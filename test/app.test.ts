import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_SETTINGS, actionsFor, suggest } from '../src/core/actions.ts'
import { Alerts } from '../src/core/alerts.ts'
import { PaperBroker, freshPaperState } from '../src/core/paper.ts'
import { viewOf } from '../src/core/session.ts'
import { DEFAULT_RULES } from '../src/core/types.ts'
import type { Tick } from '../src/core/types.ts'
import { App } from '../src/ui/app.ts'
import { H, MENU_ALERTS, MENU_FLATTEN, W } from '../src/ui/pages.ts'
import type { Page, TextBox } from '../src/ui/pages.ts'

const BTC = 'BTCUSDT'
const ETH = 'ETHUSDT'
const rulesFor = (symbol: string) => ({ ...DEFAULT_RULES(symbol), tick: 0.1 })
// Rough stand-in for the firmware font: about 7px a letter, narrow spaces, wide block glyphs.
const measure = (s: string) => [...s].reduce((w, ch) => w + (ch === ' ' ? 3 : /[━─●▁▂▃▄▅▆▇█]/.test(ch) ? 12 : 7), 0)

function setup() {
  let clock = 1_000
  const pages: Page[] = []
  const timers: (() => void)[] = []
  let exits = 0
  const broker = new PaperBroker(freshPaperState(10_000), { feeRate: 0, now: () => clock })
  const alerts = new Alerts()
  const app = new App([BTC, ETH], {
    broker, alerts, settings: DEFAULT_SETTINGS, measure, rulesFor,
    render: (page) => pages.push(page),
    exit: () => { exits += 1 },
    now: () => clock,
    later: (fn) => { timers.push(fn) },
  })
  const tick = (symbol: string, price: number, open24h = price): Promise<void> => {
    clock += 1_000
    const t: Tick = { symbol, price, open24h, time: clock }
    return app.tick(t)
  }
  /** Let time pass without a price update, e.g. so a fresh card starts accepting taps. */
  const wait = (ms: number) => { clock += ms }
  const last = () => pages[pages.length - 1]
  const textOf = (name: string) => (last().boxes.find((b) => b.name === name) as TextBox | undefined)?.text ?? ''
  const pick = async (label: RegExp) => {
    const list = last().boxes.find((b) => b.type === 'list')
    assert.ok(list && list.type === 'list', 'expected an action list on screen')
    const at = list.items.findIndex((item) => label.test(item))
    assert.ok(at >= 0, `no action matching ${label} in ${JSON.stringify(list.items)}`)
    await app.input({ select: at })
  }
  return { app, broker, alerts, tick, wait, last, textOf, pick, timers, exits: () => exits }
}

function assertFits(page: Page): void {
  const texts = page.boxes.filter((b) => b.type === 'text')
  const lists = page.boxes.filter((b) => b.type === 'list')
  assert.ok(texts.length + lists.length <= 8, 'at most 8 text and list boxes')
  const capturing = lists.length + texts.filter((b) => (b as TextBox).capture).length
  assert.equal(capturing, 1, 'exactly one box captures input')
  assert.equal(new Set(page.boxes.map((b) => b.id)).size, page.boxes.length, 'ids are unique')
  assert.equal(new Set(page.boxes.map((b) => b.name)).size, page.boxes.length, 'names are unique')
  for (const box of page.boxes) {
    assert.ok(box.name.length <= 16, `${box.name}: name too long`)
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= W && box.y + box.h <= H, `${box.name}: outside the canvas`)
    if (box.type === 'text') {
      assert.ok(box.text.length > 0 && box.text.length <= 1000, `${box.name}: text length`)
      assert.ok(box.level >= 0 && box.level <= 4, `${box.name}: brightness`)
      if (!box.capture) {
        const lines = box.text.split('\n')
        assert.ok(lines.length * 27 <= box.h, `${box.name}: ${lines.length} lines do not fit in ${box.h}px`)
        for (const line of lines) assert.ok(measure(line) <= box.w, `${box.name}: "${line}" is wider than the box`)
      }
    } else {
      assert.ok(box.items.length >= 1 && box.items.length <= 20, 'list size')
      for (const item of box.items) assert.ok(item.length <= 64, `list item too long: ${item}`)
    }
  }
  assert.ok(page.menu.length <= 10)
  for (const item of page.menu) assert.ok(item.id > 0 && Buffer.byteLength(item.label) <= 32)
}

test('a full session: enter with a stop, alert, move stop, take half, get stopped', async () => {
  const s = setup()
  await s.app.refresh()
  await s.tick(BTC, 60_000, 59_000)
  await s.tick(ETH, 3_000)
  assertFits(s.last())
  assert.match(s.textOf('head'), /^BTC {3}flat.*PAPER {3}1\/2$/)
  assert.match(s.textOf('price'), /60,000\.0 {3}▲ \+1\.69% 24h/)

  await s.app.input('tap')
  assertFits(s.last())
  await s.pick(/^Buy 500 USDT/)
  assertFits(s.last())
  assert.match(s.textOf('title'), /Buy 500 USDT of BTC\?/)
  assert.match(s.textOf('body'), /stop 59,400\.0, target 61,200\.0/)
  await s.app.input('tap')
  assert.match(s.textOf('title'), /^Done$/)
  assertFits(s.last())

  let account = await s.broker.account()
  assert.equal(account.positions[0].stop, 59_400, 'a new position always starts with a stop')
  assert.equal(account.positions[0].target, 61_200)

  s.timers.shift()?.()
  assert.equal(s.last().key, 'session', 'the result screen clears itself')
  assert.match(s.textOf('risk'), /Stop 59,400\.0 \(-1\.0%\).*Target 61,200\.0 \(\+2\.0%\)\n━*●─*$/s)

  // An alert above the market fires and offers the one risk-reducing default.
  s.alerts.add(BTC, 'above', 60_600)
  await s.tick(BTC, 60_500)
  assert.equal(s.last().key, 'session')
  await s.tick(BTC, 60_650)
  assert.equal(s.last().key, 'card')
  assertFits(s.last())
  assert.match(s.textOf('title'), /Crossed above 60,600\.0/)
  assert.match(s.textOf('offer'), /^Tap: stop to break-even \(60,000\.0\)$/)
  await s.app.input('tap')
  assert.equal(s.last().key, 'card', 'a tap in the first moments of a card is ignored')
  assert.equal((await s.broker.account()).positions[0].stop, 59_400)
  s.wait(1_000)
  await s.app.input('tap')
  assert.match(s.textOf('body'), /BTC is risk-free/)
  account = await s.broker.account()
  assert.equal(account.positions[0].stop, 60_000)

  await s.app.input('tap')
  assert.equal(s.last().key, 'session')
  assert.match(s.textOf('pnl'), /P&L \+5\.41 USDT.*\+1\.1R {3}risk-free/)

  // Near the target the app proposes banking half.
  await s.tick(BTC, 61_100)
  assert.equal(s.last().key, 'card')
  assert.match(s.textOf('tag'), /NEAR TARGET/)
  assert.match(s.textOf('offer'), /^Tap: take half off/)
  await s.app.input('down')
  assert.equal(s.last().key, 'session', 'a swipe dismisses a card without acting')

  await s.app.input('tap')
  await s.pick(/^Take half off/)
  await s.app.input('tap')
  account = await s.broker.account()
  assert.ok(Math.abs(account.positions[0].qty - 0.00417) < 1e-9)
  await s.app.input('tap')

  // Price falls back to the stop: the venue sells, the glasses say so.
  await s.tick(BTC, 59_990)
  assert.equal(s.last().key, 'card')
  assert.match(s.textOf('tag'), /STOPPED OUT/)
  assertFits(s.last())
  s.wait(1_000)
  await s.app.input('tap')
  assert.equal(s.last().key, 'session')
  assert.match(s.textOf('head'), /BTC {3}flat/)
  assert.equal((await s.broker.account()).positions.length, 0)
})

test('swipes cycle symbols, positions sort first, double-tap asks to exit', async () => {
  const s = setup()
  await s.app.refresh()
  await s.tick(BTC, 60_000)
  await s.tick(ETH, 3_000)
  await s.app.input('down')
  assert.match(s.textOf('head'), /^ETH {3}flat.*2\/2$/)
  await s.app.input('tap')
  await s.pick(/^Buy 100 USDT/)
  await s.app.input('tap')
  await s.app.input('tap')
  assert.match(s.textOf('head'), /^ETH {3}0\.03333 held.*1\/2$/, 'the position moved to the front and stayed selected')
  await s.app.input('up')
  assert.match(s.textOf('head'), /^BTC/)
  await s.app.input('double')
  assert.equal(s.exits(), 1)
})

test('cancelling and stale menus never send an order', async () => {
  const s = setup()
  await s.app.refresh()
  await s.tick(BTC, 60_000)
  await s.app.input('tap')
  await s.pick(/^Buy 100 USDT/)
  await s.app.input('double')
  assert.equal(s.last().key, 'session')
  assert.equal((await s.broker.account()).positions.length, 0)

  await s.app.input('tap')
  await s.pick(/^Back$/)
  assert.equal(s.last().key, 'session')

  // Without a fresh price nothing can be opened or confirmed.
  await s.app.input('down')
  await s.app.input('tap')
  assert.equal(s.last().key, 'session')
  assert.match(s.textOf('note'), /Waiting for a price/)
})

test('errors are shown and change nothing', async () => {
  const s = setup()
  await s.app.refresh()
  await s.tick(BTC, 60_000)
  s.broker.state.cash = 120
  await s.app.refresh()
  await s.app.input('tap')
  await s.pick(/^Buy 100 USDT/)
  s.broker.state.cash = 10
  await s.app.input('tap')
  assert.match(s.textOf('title'), /^Not done$/)
  assert.match(s.textOf('body'), /Not enough USDT/)
  assertFits(s.last())
})

test('the system menu flattens everything and pauses alerts', async () => {
  const s = setup()
  await s.app.refresh()
  await s.tick(BTC, 60_000)
  await s.tick(ETH, 3_000)
  assert.deepEqual(s.last().menu.map((m) => m.id), [MENU_ALERTS], 'nothing to flatten yet')
  await s.broker.buy(BTC, 500)
  await s.broker.buy(ETH, 300)
  await s.app.refresh()
  s.app.render()
  assert.deepEqual(s.last().menu.map((m) => m.id), [MENU_FLATTEN, MENU_ALERTS])

  await s.app.input({ menu: MENU_FLATTEN })
  assert.match(s.textOf('title'), /Flatten everything\?/)
  assertFits(s.last())
  await s.app.input('tap')
  assert.match(s.textOf('body'), /Flat\. 2 position\(s\) closed/)
  assert.equal((await s.broker.account()).positions.length, 0)

  await s.app.input('tap')
  await s.app.input({ menu: MENU_ALERTS })
  s.alerts.add(BTC, 'above', 60_100)
  await s.tick(BTC, 60_050)
  await s.tick(BTC, 60_200)
  assert.equal(s.last().key, 'session', 'paused alerts stay quiet')
  assert.equal(s.last().menu.find((m) => m.id === MENU_ALERTS)?.label, 'Resume alerts')
})

test('cards queue behind a decision instead of interrupting it', async () => {
  const s = setup()
  await s.app.refresh()
  await s.tick(BTC, 60_000)
  s.alerts.add(BTC, 'above', 60_100)
  await s.app.input('tap')
  assert.ok(s.last().key.startsWith('actions:'))
  await s.tick(BTC, 60_150)
  assert.ok(s.last().key.startsWith('actions:'), 'the menu stays up')
  await s.app.input('double')
  assert.equal(s.last().key, 'session')
  assert.equal(s.app.queue.length, 1)
})

test('risk-reducing actions come first and alerts only ever offer those', async () => {
  const broker = new PaperBroker(freshPaperState(10_000), { feeRate: 0 })
  await broker.tick(BTC, 60_000)
  await broker.buy(BTC, 500)
  await broker.protect(BTC, { stop: 59_400, target: 61_200 })
  const position = (await broker.account()).positions[0]
  const view = viewOf(rulesFor(BTC), { symbol: BTC, price: 60_700, open24h: 60_000, time: Date.now() }, position)
  const actions = actionsFor(view, { broker, alerts: new Alerts(), rules: rulesFor(BTC), settings: DEFAULT_SETTINGS, cash: 9_500 })
  const effects = actions.map((a) => a.effect)
  assert.ok(effects.indexOf('add') > effects.lastIndexOf('reduce'), 'reduce before add')
  for (const reason of ['above', 'below', 'stop-near', 'target-near'] as const) {
    assert.equal(suggest(view, reason, actions)?.effect, 'reduce')
  }
  assert.equal(suggest(view, 'below', actions)?.id, 'close')
  const flat = viewOf(rulesFor(ETH), { symbol: ETH, price: 3_000, open24h: 3_000, time: Date.now() }, undefined)
  assert.equal(suggest(flat, 'above', []), undefined, 'no position, no one-tap order')
})
