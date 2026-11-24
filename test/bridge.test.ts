import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BinanceTestnet, TESTNET, decimals, floorTo, parseRules, roundTo, sign, summarize } from '../server/binance.mjs'
import { accountView, emptyLedger, eventsSince, recordBuy, recordSell, setProtection } from '../server/ledger.mjs'
import { RemoteBroker } from '../src/core/remote.ts'

test('request signing matches the documented Binance example', () => {
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j'
  const query = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559'
  assert.equal(sign(query, secret), 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71')
})

test('quantities and prices are printed on exchange increments', () => {
  assert.equal(decimals(0.00001), 5)
  assert.equal(decimals(1e-8), 8)
  assert.equal(decimals(1), 0)
  assert.equal(floorTo(0.00816999, 0.00001), '0.00816')
  assert.equal(floorTo(0.3, 0.1), '0.3')
  assert.equal(floorTo(12.9, 1), '12')
  assert.equal(roundTo(60645.8846, 0.01), '60645.88')
  assert.equal(roundTo(60645.886, 0.01), '60645.89')
})

test('fills are summarised net of a base-asset commission', () => {
  const buy = { orderId: 7, side: 'BUY', status: 'FILLED', executedQty: '0.01000000', cummulativeQuoteQty: '612.50000000', fills: [{ commission: '0.00001000', commissionAsset: 'BTC' }] }
  const s = summarize(buy, 'BTC')
  assert.ok(Math.abs(s.qty - 0.00999) < 1e-12)
  assert.equal(s.price, 61250)
  const sell = { orderId: 8, side: 'SELL', status: 'FILLED', executedQty: '0.00999000', cummulativeQuoteQty: '613.00000000', fills: [{ commission: '0.61', commissionAsset: 'USDT' }] }
  assert.equal(summarize(sell, 'BTC').qty, 0.00999)
})

test('the client signs requests and refuses anything but the testnet', async () => {
  assert.throws(() => new BinanceTestnet({ key: 'k', secret: 's', base: 'https://api.binance.com' }), /only talks to/)
  assert.throws(() => new BinanceTestnet({ key: '', secret: '' }), /required/)

  const seen: { url: string; init: RequestInit }[] = []
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url, init })
    return new Response(JSON.stringify({ orderId: 1 }), { status: 200 })
  }) as unknown as typeof fetch
  const client = new BinanceTestnet({ key: 'KEY', secret: 'SECRET', fetch: fetcher, now: () => 1_700_000_000_000 })
  await client.marketBuy('BTCUSDT', 500)
  const url = new URL(seen[0].url)
  assert.equal(url.origin, TESTNET)
  assert.equal(url.pathname, '/api/v3/order')
  assert.equal(url.searchParams.get('quoteOrderQty'), '500.00')
  const signature = url.searchParams.get('signature')
  url.searchParams.delete('signature')
  assert.equal(signature, sign(url.searchParams.toString(), 'SECRET'))
  assert.equal((seen[0].init.headers as Record<string, string>)['X-MBX-APIKEY'], 'KEY')
  assert.equal(seen[0].init.method, 'POST')

  const failing = (async () => new Response(JSON.stringify({ code: -2010, msg: 'Account has insufficient balance for requested action.' }), { status: 400 })) as unknown as typeof fetch
  await assert.rejects(() => new BinanceTestnet({ key: 'K', secret: 'S', fetch: failing }).marketSell('BTCUSDT', '1'), /insufficient balance/)
})

test('OCO orders carry a stop trigger, a limit under it and a target above', async () => {
  let captured = new URLSearchParams()
  const fetcher = (async (url: string) => {
    captured = new URL(url).searchParams
    return new Response(JSON.stringify({ orders: [{ orderId: 1 }, { orderId: 2 }] }), { status: 200 })
  }) as unknown as typeof fetch
  const client = new BinanceTestnet({ key: 'K', secret: 'S', fetch: fetcher })
  await client.oco('BTCUSDT', '0.00816', 60645.886, 62483.631, { tick: 0.01 })
  assert.equal(captured.get('side'), 'SELL')
  assert.equal(captured.get('belowStopPrice'), '60645.89')
  assert.equal(captured.get('abovePrice'), '62483.63')
  assert.ok(Number(captured.get('belowPrice')) < Number(captured.get('belowStopPrice')))
})

test('exchange info becomes trading rules', () => {
  const rules = parseRules({ symbols: [{ symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'LOT_SIZE', stepSize: '0.0001' }, { filterType: 'NOTIONAL', minNotional: '5' }] }] })
  assert.deepEqual(rules.get('ETHUSDT'), { symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT', tick: 0.01, step: 0.0001, minNotional: 5 })
})

test('the ledger tracks only what the session opened', () => {
  const ledger = emptyLedger()
  recordBuy(ledger, 'BTCUSDT', 0.01, 60_000, 1)
  recordBuy(ledger, 'BTCUSDT', 0.01, 62_000, 2)
  assert.equal(ledger.positions.BTCUSDT.entry, 61_000)
  setProtection(ledger, 'BTCUSDT', { stop: 60_390, target: 62_220, orders: [11, 12] })
  assert.equal(ledger.positions.BTCUSDT.riskPerUnit, 610)
  setProtection(ledger, 'BTCUSDT', { stop: 61_000, target: 62_220, orders: [13, 14] })
  assert.equal(ledger.positions.BTCUSDT.riskPerUnit, 610, '1R stays fixed')

  const half = recordSell(ledger, 'BTCUSDT', 0.01, 61_500, 'manual', 3)
  assert.equal(half.pnl, 5)
  const view = accountView(ledger, 9_000)
  assert.equal(view.mode, 'testnet')
  assert.equal(view.positions[0].qty, 0.01)
  assert.equal('orders' in view.positions[0], false, 'exchange order ids stay on the server')

  const out = recordSell(ledger, 'BTCUSDT', 5, 61_000, 'stop', 4)
  assert.equal(out.qty, 0.01, 'cannot sell more than the session holds')
  assert.deepEqual(ledger.positions, {})
  assert.equal(ledger.realized, 5)
  assert.deepEqual(eventsSince(ledger, 't2').map((e) => e.reason), ['manual', 'stop'])
  assert.equal(eventsSince(ledger, '').length, 4)
  assert.throws(() => recordSell(ledger, 'BTCUSDT', 1, 1), /No BTCUSDT position/)
})

test('the remote venue speaks the bridge protocol and reports its errors', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  let events = [{ id: 't4', symbol: 'BTCUSDT', side: 'sell', qty: 1, price: 1, reason: 'manual', time: 0 }]
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (url.includes('/events')) return new Response(JSON.stringify(events), { status: 200 })
    if (url.endsWith('/sell')) return new Response(JSON.stringify({ error: 'No BTCUSDT position' }), { status: 400 })
    return new Response(JSON.stringify({ id: 't1', symbol: 'BTCUSDT', side: 'buy', qty: 0.008, price: 61_000, reason: 'manual', time: 1 }), { status: 200 })
  }) as unknown as typeof fetch
  const remote = new RemoteBroker('http://localhost:8787/', 'secret', fetcher)

  const fill = await remote.buy('BTCUSDT', 500)
  assert.equal(fill.qty, 0.008)
  assert.equal(calls[0].url, 'http://localhost:8787/buy')
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer secret')
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { symbol: 'BTCUSDT', quote: 500 })
  await assert.rejects(() => remote.sell('BTCUSDT', 1), /No BTCUSDT position/)

  assert.deepEqual(await remote.poll(), [], 'history from before the app started is not replayed')
  events = [{ id: 't5', symbol: 'BTCUSDT', side: 'sell', qty: 1, price: 1, reason: 'stop', time: 0 }]
  const fresh = await remote.poll()
  assert.equal(fresh.length, 1)
  assert.match(calls.at(-1)!.url, /since=t4$/)

  const down = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
  await assert.rejects(() => new RemoteBroker('http://x', 't', down).account(), /not reachable/)
})
