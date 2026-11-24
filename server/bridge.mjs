// Riskline bridge: lets the glasses app place real orders on the Binance Spot
// Testnet without the API key ever leaving this process.
//
//   BINANCE_KEY=... BINANCE_SECRET=... node server/bridge.mjs
//
// Optional: PORT (8787), BRIDGE_TOKEN (printed if not set), ALLOW_ORIGIN (*),
// LEDGER (riskline-ledger.json). Node 22+, no dependencies.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

import { BinanceTestnet, floorTo, summarize } from './binance.mjs'
import { accountView, emptyLedger, eventsSince, recordBuy, recordSell, setProtection } from './ledger.mjs'

const PORT = Number(process.env.PORT ?? 8787)
const TOKEN = process.env.BRIDGE_TOKEN ?? randomBytes(12).toString('hex')
const ORIGIN = process.env.ALLOW_ORIGIN ?? '*'
const LEDGER_FILE = process.env.LEDGER ?? 'riskline-ledger.json'

const exchange = new BinanceTestnet({ key: process.env.BINANCE_KEY, secret: process.env.BINANCE_SECRET })
const rules = new Map()
let ledger = emptyLedger()
try {
  ledger = { ...emptyLedger(), ...JSON.parse(readFileSync(LEDGER_FILE, 'utf8')) }
} catch { /* first run */ }
const persist = () => writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2))

async function rulesFor(symbol) {
  if (!rules.has(symbol)) for (const [key, value] of await exchange.rules([symbol])) rules.set(key, value)
  const found = rules.get(symbol)
  if (!found) throw new Error(`Unknown symbol ${symbol}`)
  return found
}

/** One request at a time: two taps must never race each other into the exchange. */
let chain = Promise.resolve()
const serial = (work) => {
  const run = chain.then(work, work)
  chain = run.catch(() => {})
  return run
}

async function clearProtection(symbol) {
  const held = ledger.positions[symbol]
  if (!held) return
  for (const orderId of held.orders ?? []) await exchange.cancel(symbol, orderId)
  held.orders = []
}

async function protect(symbol, levels) {
  const held = ledger.positions[symbol]
  if (!held) throw new Error(`No ${symbol} position`)
  const rule = await rulesFor(symbol)
  const stop = levels.stop === undefined ? held.stop : levels.stop ?? undefined
  const target = levels.target === undefined ? held.target : levels.target ?? undefined
  const last = await exchange.price(symbol)
  if (stop !== undefined && !(stop < last)) throw new Error('A stop has to sit below the current price')
  if (target !== undefined && !(target > last)) throw new Error('A target has to sit above the current price')

  await clearProtection(symbol)
  const quantity = floorTo(held.qty, rule.step)
  let orders = []
  if (stop !== undefined && target !== undefined) orders = (await exchange.oco(symbol, quantity, stop, target, rule)).orders.map((o) => o.orderId)
  else if (stop !== undefined) orders = [(await exchange.stopOnly(symbol, quantity, stop, rule)).orderId]
  else if (target !== undefined) orders = [(await exchange.targetOnly(symbol, quantity, target, rule)).orderId]
  const position = setProtection(ledger, symbol, { stop, target, orders })
  persist()
  return position
}

async function sell(symbol, fraction) {
  const held = ledger.positions[symbol]
  if (!held) throw new Error(`No ${symbol} position`)
  const rule = await rulesFor(symbol)
  const part = Math.min(1, Math.max(0, Number(fraction)))
  const quantity = floorTo(part >= 1 ? held.qty : held.qty * part, rule.step)
  if (!(Number(quantity) > 0)) throw new Error('Nothing to sell at that size')

  // Protective orders lock the balance, so they come off first and go back on for what remains.
  const { stop, target } = held
  await clearProtection(symbol)
  const done = summarize(await exchange.marketSell(symbol, quantity), rule.base)
  const fill = recordSell(ledger, symbol, done.qty, done.price)
  if (ledger.positions[symbol] && (stop !== undefined || target !== undefined)) {
    await protect(symbol, { stop, target }).catch((error) => console.error(`could not restore protection on ${symbol}: ${error.message}`))
  }
  persist()
  return fill
}

async function buy(symbol, quoteAmount) {
  const rule = await rulesFor(symbol)
  const amount = Number(quoteAmount)
  if (!(amount >= rule.minNotional)) throw new Error(`Order is below the ${rule.minNotional} ${rule.quote} minimum`)
  const held = ledger.positions[symbol]
  const levels = held ? { stop: held.stop, target: held.target } : null
  if (held) await clearProtection(symbol)
  const done = summarize(await exchange.marketBuy(symbol, amount), rule.base)
  const fill = recordBuy(ledger, symbol, done.qty, done.price)
  if (levels && (levels.stop !== undefined || levels.target !== undefined)) await protect(symbol, levels).catch((error) => console.error(error.message))
  persist()
  return fill
}

/** Look for stops and targets the exchange filled on its own. */
async function reconcile() {
  for (const held of Object.values(ledger.positions)) {
    if (!held.orders?.length) continue
    const rule = await rulesFor(held.symbol)
    for (const orderId of [...held.orders]) {
      const order = await exchange.order(held.symbol, orderId)
      if (order.status !== 'FILLED' && order.status !== 'PARTIALLY_FILLED') continue
      const done = summarize(order, rule.base)
      const reason = order.type.startsWith('STOP') ? 'stop' : 'target'
      recordSell(ledger, held.symbol, done.qty, done.price, reason)
      if (ledger.positions[held.symbol]) ledger.positions[held.symbol].orders = []
      console.log(`${held.symbol}: ${reason} filled at ${done.price}`)
      persist()
      break
    }
  }
}
setInterval(() => void serial(reconcile).catch((error) => console.error(`reconcile: ${error.message}`)), 2500)

const routes = {
  'GET /account': async () => {
    const balances = await exchange.balances()
    return accountView(ledger, balances.get('USDT') ?? 0)
  },
  'GET /events': async (query) => eventsSince(ledger, query.get('since')),
  'POST /buy': (_, body) => serial(() => buy(body.symbol, body.quote)),
  'POST /sell': (_, body) => serial(() => sell(body.symbol, body.fraction)),
  'POST /protect': (_, body) => serial(async () => {
    const { orders, ...position } = await protect(body.symbol, { stop: body.stop, target: body.target })
    return position
  }),
  'POST /flatten': () => serial(async () => {
    const fills = []
    for (const symbol of Object.keys(ledger.positions)) fills.push(await sell(symbol, 1))
    return fills
  }),
}

const authorised = (header) => {
  const given = Buffer.from(String(header ?? '').replace(/^Bearer /, ''))
  const wanted = Buffer.from(TOKEN)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

createServer(async (request, response) => {
  const headers = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json' }
  const reply = (status, payload) => response.writeHead(status, headers).end(JSON.stringify(payload))
  if (request.method === 'OPTIONS') return response.writeHead(204, { ...headers, 'Access-Control-Max-Age': '86400' }).end()
  if (!authorised(request.headers.authorization)) return reply(401, { error: 'Wrong or missing bridge token' })

  const url = new URL(request.url, 'http://bridge')
  const route = routes[`${request.method} ${url.pathname}`]
  if (!route) return reply(404, { error: 'Not found' })
  try {
    let raw = ''
    for await (const chunk of request) {
      raw += chunk
      if (raw.length > 4096) return reply(413, { error: 'Body too large' })
    }
    reply(200, await route(url.searchParams, raw ? JSON.parse(raw) : {}))
  } catch (error) {
    reply(400, { error: error.message })
  }
}).listen(PORT, () => {
  console.log(`Riskline bridge on http://localhost:${PORT} -> Binance Spot Testnet`)
  console.log(`Bridge token: ${TOKEN}`)
})
