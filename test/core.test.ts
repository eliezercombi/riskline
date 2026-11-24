import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as f from '../src/core/format.ts'
import { Alerts, proximity } from '../src/core/alerts.ts'
import { PaperBroker, freshPaperState } from '../src/core/paper.ts'
import { viewOf, order } from '../src/core/session.ts'
import { DEFAULT_RULES, roundDown, roundTo } from '../src/core/types.ts'

const BTC = 'BTCUSDT'
const rules = { ...DEFAULT_RULES(BTC), tick: 0.1, step: 0.00001, minNotional: 5 }

function broker(cash = 10_000, feeRate = 0) {
  const b = new PaperBroker(freshPaperState(cash), { feeRate, now: () => 1_000 })
  b.setRules(rules)
  return b
}

test('numbers are formatted for a glance', () => {
  assert.equal(f.price(61160.52), '61,160.5')
  assert.equal(f.price(3.14159), '3.142')
  assert.equal(f.price(0.000123456), '0.0001235')
  assert.equal(f.qty(0.15), '0.15')
  assert.equal(f.qty(2), '2')
  assert.equal(f.signed(-9.2), '-9.20')
  assert.equal(f.signed(1234.5), '+1,234.50')
  assert.equal(f.pct(0.0123), '+1.23%')
  assert.equal(f.pct(-0.018, 1), '-1.8%')
  assert.equal(f.rMultiple(0.94), '+0.9R')
  assert.equal(f.rMultiple(-1), '-1.0R')
  assert.equal(f.rMultiple(-0.004), '+0.0R', 'no negative zero')
  assert.equal(f.signed(-0.001), '+0.00')
  assert.equal(f.pct(-0.000001), '+0.00%')
})

test('sparkline resamples and scales', () => {
  assert.equal(f.sparkline([1, 2, 3, 4, 5, 6, 7, 8], 8), '▁▂▃▄▅▆▇█')
  assert.equal(f.sparkline([5, 5, 5], 4), '▄▄▄▄')
  assert.equal(f.sparkline([], 4), '')
  assert.equal([...f.sparkline(Array.from({ length: 100 }, (_, i) => i), 10)].length, 10)
})

test('gauge places the marker between stop and target', () => {
  assert.equal(f.gauge(90, 90, 110, 5), '●────')
  assert.equal(f.gauge(90, 100, 110, 5), '━━●──')
  assert.equal(f.gauge(90, 110, 110, 5), '━━━━●')
  assert.equal(f.gauge(90, 80, 110, 5), '●────', 'pins below the stop')
  assert.equal(f.gauge(90, 130, 110, 5), '━━━━●', 'pins above the target')
  assert.equal(f.gauge(110, 100, 90, 5), '', 'needs target above stop')
})

test('alignment helpers work with a proportional font', () => {
  const measure = (s: string) => [...s].reduce((w, ch) => w + (ch === ' ' ? 4 : 10), 0)
  assert.equal(measure(f.alignRight('ab', 60, measure)), 60)
  // A font whose space is 5.5px wide but reports single widths rounded: the run must still fit.
  const drifting = (s: string) => Math.round([...s].reduce((w, ch) => w + (ch === ' ' ? 5.5 : 10), 0))
  const wide = f.spread('left side', 'right side', 568, drifting)
  assert.ok(drifting(wide) <= 568 && drifting(wide) > 550, `got ${drifting(wide)}`)
  const line = f.spread('left', 'right', 200, measure)
  assert.ok(line.startsWith('left') && line.endsWith('right'))
  assert.ok(measure(line) <= 200 && measure(line) > 186)
  assert.equal(f.fit('short', 100, measure), 'short')
  assert.ok(measure(f.fit('a very long line of text', 100, measure)) <= 100)
})

test('rounding respects exchange increments', () => {
  assert.equal(roundDown(0.123456, 0.001), 0.123)
  assert.equal(roundDown(0.3, 0.1), 0.3)
  assert.equal(roundTo(61160.57, 0.1), 61160.6)
  assert.equal(roundTo(61160.52, 0.01), 61160.52)
})

test('paper buy and sell keep cash, average entry and P&L straight', async () => {
  const b = broker()
  await b.tick(BTC, 60_000)
  const first = await b.buy(BTC, 600)
  assert.equal(first.qty, 0.01)
  await b.tick(BTC, 62_000)
  await b.buy(BTC, 620)
  let account = await b.account()
  assert.equal(account.positions[0].qty, 0.02)
  assert.equal(account.positions[0].entry, 61_000)
  assert.equal(account.cash, 10_000 - 600 - 620)

  await b.tick(BTC, 63_000)
  const half = await b.sell(BTC, 0.5)
  assert.equal(half.qty, 0.01)
  assert.equal(half.pnl, 20)
  const rest = await b.sell(BTC, 1)
  assert.equal(rest.pnl, 20)
  account = await b.account()
  assert.equal(account.positions.length, 0)
  assert.equal(account.realized, 40)
  assert.equal(account.cash, 10_040)
})

test('fees reduce both cash and realised P&L', async () => {
  const b = broker(1_000, 0.001)
  await b.tick(BTC, 50_000)
  await b.buy(BTC, 500)
  const fill = await b.sell(BTC, 1)
  assert.ok(Math.abs((fill.pnl ?? 0) + 0.5) < 1e-9, 'the sell leg pays 0.1% of 500')
  assert.ok(Math.abs((await b.account()).cash - 999) < 1e-9, 'both legs cost 0.50')
})

test('paper refuses orders it cannot fill', async () => {
  const b = broker(100)
  await assert.rejects(() => b.buy(BTC, 50), /No price/)
  await b.tick(BTC, 60_000)
  await assert.rejects(() => b.buy(BTC, 500), /Not enough/)
  await assert.rejects(() => b.buy(BTC, 1), /minimum/)
  await assert.rejects(() => b.sell(BTC, 1), /No BTCUSDT position/)
})

test('stops and targets trigger from the tick stream', async () => {
  const b = broker()
  const seen: string[] = []
  b.onFill = (fill) => seen.push(fill.reason)
  await b.tick(BTC, 60_000)
  await b.buy(BTC, 600)
  await b.protect(BTC, { stop: 59_400, target: 61_200 })
  assert.deepEqual(await b.tick(BTC, 59_900), [])
  const [stopped] = await b.tick(BTC, 59_390)
  assert.equal(stopped.reason, 'stop')
  assert.equal(stopped.price, 59_390)
  assert.ok(Math.abs((stopped.pnl ?? 0) + 6.1) < 1e-9)
  assert.equal((await b.account()).positions.length, 0)

  await b.tick(BTC, 60_000)
  await b.buy(BTC, 600)
  await b.protect(BTC, { stop: 59_400, target: 61_200 })
  const [hit] = await b.tick(BTC, 61_250)
  assert.equal(hit.reason, 'target')
  assert.deepEqual(seen, ['manual', 'stop', 'manual', 'target'])
})

test('protective levels are validated and 1R is fixed by the first stop', async () => {
  const b = broker()
  await b.tick(BTC, 60_000)
  await b.buy(BTC, 600)
  await assert.rejects(() => b.protect(BTC, { stop: 60_500 }), /below the current price/)
  await assert.rejects(() => b.protect(BTC, { target: 59_000 }), /above the current price/)
  await b.protect(BTC, { stop: 59_400 })
  await b.tick(BTC, 61_200)
  const moved = await b.protect(BTC, { stop: 60_000 })
  assert.equal(moved.stop, 60_000)
  assert.equal(moved.riskPerUnit, 600, 'moving the stop does not redefine the initial risk')
  const cleared = await b.protect(BTC, { stop: null, target: null })
  assert.equal(cleared.stop, undefined)
})

test('flatten sells everything', async () => {
  const b = broker()
  await b.tick(BTC, 60_000)
  await b.tick('ETHUSDT', 3_000)
  await b.buy(BTC, 600)
  await b.buy('ETHUSDT', 300)
  const fills = await b.flatten()
  assert.equal(fills.length, 2)
  assert.equal((await b.account()).positions.length, 0)
})

test('views report P&L, R and distances', async () => {
  const b = broker()
  await b.tick(BTC, 60_000)
  await b.buy(BTC, 600)
  await b.protect(BTC, { stop: 59_400, target: 61_200 })
  const position = (await b.account()).positions[0]
  const view = viewOf(rules, { symbol: BTC, price: 60_300, open24h: 60_000, time: 5_000 }, position, [1, 2], 6_000)
  assert.equal(view.pnl, 3)
  assert.equal(view.r, 0.5)
  assert.ok(Math.abs(view.change24h - 0.005) < 1e-12)
  assert.ok((view.toStop ?? 0) < 0 && (view.toTarget ?? 0) > 0)
  assert.equal(view.riskFree, false)
  assert.equal(view.stale, false)
  assert.equal(viewOf(rules, undefined, undefined).stale, true)

  const flat = viewOf(DEFAULT_RULES('ETHUSDT'), { symbol: 'ETHUSDT', price: 3_000, open24h: 3_000, time: 5_000 }, undefined, [], 6_000)
  assert.deepEqual(order([flat, view]).map((v) => v.symbol), [BTC, 'ETHUSDT'], 'positions come first')
})

test('alerts fire once, on the crossing tick', () => {
  const alerts = new Alerts()
  alerts.add(BTC, 'above', 61_000)
  alerts.add(BTC, 'below', 59_000)
  assert.deepEqual(alerts.check(BTC, 61_500), [], 'the first tick only sets the baseline')
  assert.deepEqual(alerts.check(BTC, 60_500), [])
  const up = alerts.check(BTC, 61_000)
  assert.equal(up.length, 1)
  assert.equal(up[0].rule.kind, 'above')
  assert.deepEqual(alerts.check(BTC, 61_200), [], 'it does not fire twice')
  assert.equal(alerts.check(BTC, 58_900).length, 1)
  assert.equal(alerts.rules.length, 0)
})

test('proximity warns once and re-arms after the price moves away', async () => {
  const b = broker()
  await b.tick(BTC, 60_000)
  await b.buy(BTC, 600)
  await b.protect(BTC, { stop: 59_400, target: 61_200 })
  const position = (await b.account()).positions[0]
  const at = (price: number) => viewOf(rules, { symbol: BTC, price, open24h: 60_000, time: 0 }, position, [], 0)
  const seen = new Set<string>()
  assert.equal(proximity(at(60_000), seen), null)
  assert.equal(proximity(at(59_500), seen), 'stop-near')
  assert.equal(proximity(at(59_480), seen), null, 'already announced')
  assert.equal(proximity(at(60_200), seen), null, 're-arms')
  assert.equal(proximity(at(59_500), seen), 'stop-near')
  assert.equal(proximity(at(61_100), seen), 'target-near')
})
