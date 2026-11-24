import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseExchangeInfo, parseKlines, parseMiniTicker, parseTickers, streamUrl } from '../src/market/binance.ts'
import { Display, payload } from '../src/ui/display.ts'
import type { Bridge } from '../src/ui/display.ts'
import { EVENT, translate } from '../src/ui/input.ts'
import { confirmPage, sessionPage } from '../src/ui/pages.ts'
import type { Page } from '../src/ui/pages.ts'
import { viewOf } from '../src/core/session.ts'
import { DEFAULT_RULES } from '../src/core/types.ts'

const chrome = { mode: 'paper' as const, alertsPaused: false, anyPosition: false }
const measure = (s: string) => s.length * 7

function page(price: number, note = 'Ready.'): Page {
  const view = viewOf(DEFAULT_RULES('BTCUSDT'), { symbol: 'BTCUSDT', price, open24h: 60_000, time: Date.now() }, undefined, [1, 2, 3])
  return sessionPage(view, 0, 1, note, [], chrome, measure)
}

function fakeBridge() {
  const calls: { method: string; arg: any }[] = []
  let createResult = 0
  const bridge: Bridge = {
    async createStartUpPageContainer(arg) { calls.push({ method: 'create', arg }); return createResult },
    async rebuildPageContainer(arg) { calls.push({ method: 'rebuild', arg }); return true },
    async textContainerUpgrade(arg) { calls.push({ method: 'upgrade', arg }); return true },
    async shutDownPageContainer(arg) { calls.push({ method: 'shutdown', arg }); return true },
  }
  return { bridge, calls, failCreate: (code: number) => { createResult = code } }
}

test('page payloads satisfy the SDK container rules', () => {
  const p = payload(page(60_000)) as any
  assert.equal(p.containerTotalNum, 8)
  assert.equal(p.textObject.length, 8)
  assert.equal(p.listObject.length, 0)
  assert.equal(p.textObject.filter((c: any) => c.isEventCapture === 1).length, 1)
  const z = p.textObject.map((c: any) => c.zOrderIndex)
  assert.equal(new Set(z).size, z.length, 'z-order values are unique')
  assert.equal(p.textObject.find((c: any) => c.isEventCapture === 1).zOrderIndex, Math.min(...z), 'the input layer is at the back')
  assert.deepEqual(p.menuObject.menuItems, [{ itemName: 'Pause alerts', itemID: 2 }])
  for (const c of p.textObject) assert.ok(c.textColor >= 0 && c.textColor <= 4 && c.content.length > 0)
})

test('the display creates once, upgrades changed text only, rebuilds on layout change', async () => {
  const { bridge, calls } = fakeBridge()
  const display = new Display(bridge, { minGapMs: 0 })

  display.show(page(60_000))
  await display.idle()
  assert.deepEqual(calls.map((c) => c.method), ['create'])

  display.show(page(60_000))
  await display.idle()
  assert.equal(calls.length, 1, 'an identical page sends nothing')

  display.show(page(60_100))
  await display.idle()
  const upgrades = calls.slice(1)
  assert.ok(upgrades.length >= 1 && upgrades.every((c) => c.method === 'upgrade'))
  assert.deepEqual(upgrades.map((c) => c.arg.containerName), ['price'], 'only the price line changed')
  assert.match(upgrades[0].arg.content, /60,100\.0/)

  calls.length = 0
  display.show(confirmPage(['Close BTC?', 'Sell 0.01 at market'], chrome))
  await display.idle()
  assert.deepEqual(calls.map((c) => c.method), ['rebuild'])

  // The first page of a burst is already on its way; everything behind it collapses to the newest.
  calls.length = 0
  display.show(page(60_100))
  display.show(page(60_200))
  display.show(page(60_300))
  display.show({ ...page(60_400), menu: [{ id: 1, label: 'Flatten all' }] })
  await display.idle()
  assert.deepEqual(calls.map((c) => c.method), ['rebuild', 'rebuild'], 'four pages, two sends')
  assert.equal(calls[1].arg.menuObject.menuItems[0].itemName, 'Flatten all')
  assert.match(calls[1].arg.textObject.find((c: any) => c.containerName === 'price').content, /60,400\.0/)

  display.exit()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(calls.at(-1), { method: 'shutdown', arg: 1 }, 'exit goes through the system dialog')
  assert.equal(display.stats.creates, 1)
})

test('a failed start is retried instead of being followed by a rebuild', async () => {
  const { bridge, calls, failCreate } = fakeBridge()
  const display = new Display(bridge, { minGapMs: 0 })
  failCreate(1)
  display.show(page(60_000))
  await new Promise((resolve) => setTimeout(resolve, 30))
  failCreate(0)
  await display.idle()
  assert.deepEqual(calls.map((c) => c.method), ['create', 'create'])
})

test('a hung bridge call times out and is counted', async () => {
  const bridge: Bridge = {
    createStartUpPageContainer: async () => 0,
    rebuildPageContainer: () => new Promise(() => {}),
    textContainerUpgrade: async () => true,
    shutDownPageContainer: async () => true,
  }
  const display = new Display(bridge, { minGapMs: 0, timeoutMs: 20 })
  display.show(page(60_000))
  display.show(confirmPage(['x'], chrome))
  await display.idle()
  assert.equal(display.stats.failures, 1)
})

test('hub events map to inputs, including protobuf zero values', () => {
  assert.equal(translate({ sysEvent: {} }), 'tap')
  assert.equal(translate({ sysEvent: { eventType: EVENT.DOUBLE_CLICK } }), 'double')
  assert.equal(translate({ textEvent: { eventType: EVENT.SCROLL_TOP } }), 'up')
  assert.equal(translate({ textEvent: { eventType: EVENT.SCROLL_BOTTOM } }), 'down')
  assert.deepEqual(translate({ listEvent: {} }), { select: 0 })
  assert.deepEqual(translate({ listEvent: { currentSelectItemIndex: 3 } }), { select: 3 })
  assert.equal(translate({ listEvent: { eventType: EVENT.DOUBLE_CLICK } }), 'double')
  assert.deepEqual(translate({ menuItemClickEvent: { itemID: 2 }, sysEvent: { eventType: EVENT.FOREGROUND_ENTER } }), { menu: 2 })
  assert.equal(translate({ sysEvent: { eventType: EVENT.FOREGROUND_EXIT } }), 'background')
  assert.equal(translate({ sysEvent: { eventType: EVENT.SYSTEM_EXIT } }), 'exit')
  assert.equal(translate({ sysEvent: { eventType: EVENT.IMU_DATA, imuData: { x: 1 } } }), null)
  assert.equal(translate({ sysEvent: { eventType: EVENT.LONG_PRESS } }), null)
  assert.equal(translate({ audioEvent: {} }), null, 'audio frames are never taps')
  assert.equal(translate({}), null)
})

test('Binance payloads are parsed defensively', () => {
  const frame = { stream: 'btcusdt@miniTicker', data: { e: '24hrMiniTicker', E: 1795476000000, s: 'BTCUSDT', c: '61160.52', o: '61310.28', h: '1', l: '1', v: '1', q: '1' } }
  assert.deepEqual(parseMiniTicker(frame), { symbol: 'BTCUSDT', price: 61160.52, open24h: 61310.28, time: 1795476000000 })
  assert.equal(parseMiniTicker({ data: { e: 'trade' } }), null)
  assert.equal(parseMiniTicker({ data: { e: '24hrMiniTicker', s: 'BTCUSDT', c: '0' } }), null)
  assert.equal(parseMiniTicker(null), null)

  assert.deepEqual(parseTickers([{ symbol: 'ETHUSDT', lastPrice: '3000.5', openPrice: '2990' }, { symbol: 'X', lastPrice: 'nope' }], 5), [
    { symbol: 'ETHUSDT', price: 3000.5, open24h: 2990, time: 5 },
  ])
  assert.deepEqual(parseKlines([[0, '1', '2', '0.5', '1.5', '9'], [1, '1.5', '2', '1', '1.8', '9']]), [1.5, 1.8])
  assert.deepEqual(parseKlines({ code: -1121 }), [])

  const info = {
    symbols: [{
      symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT',
      filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01000000' }, { filterType: 'LOT_SIZE', stepSize: '0.00001000' }, { filterType: 'NOTIONAL', minNotional: '5.00000000' }],
    }],
  }
  assert.deepEqual(parseExchangeInfo(info), [{ symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', tick: 0.01, step: 0.00001, minNotional: 5 }])
  assert.deepEqual(parseExchangeInfo({}), [])
  assert.equal(streamUrl('wss://x', ['BTCUSDT', 'ETHUSDT']), 'wss://x/stream?streams=btcusdt@miniTicker/ethusdt@miniTicker')
})
