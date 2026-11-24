// Minimal signed client for the Binance Spot REST API, built on fetch and
// node:crypto. It is deliberately pinned to the Spot Testnet: this project
// never talks to an account that holds real funds.

import { createHmac } from 'node:crypto'

export const TESTNET = 'https://testnet.binance.vision'

export const sign = (query, secret) => createHmac('sha256', secret).update(query).digest('hex')

export function decimals(increment) {
  const text = String(increment)
  if (text.includes('e-')) return Number(text.split('e-')[1])
  return text.includes('.') ? text.replace(/0+$/, '').split('.')[1]?.length ?? 0 : 0
}

/** Round down to an exchange increment and print without float noise. */
export function floorTo(value, increment) {
  const places = decimals(increment)
  const scaled = Math.floor(value / increment + 1e-9) * increment
  return scaled.toFixed(places)
}

export function roundTo(value, increment) {
  return (Math.round(value / increment) * increment).toFixed(decimals(increment))
}

export function parseRules(info) {
  const out = new Map()
  for (const s of info.symbols ?? []) {
    const filter = (type) => s.filters?.find((f) => f.filterType === type)
    out.set(s.symbol, {
      symbol: s.symbol,
      base: s.baseAsset,
      quote: s.quoteAsset,
      tick: Number(filter('PRICE_FILTER')?.tickSize) || 0.01,
      step: Number(filter('LOT_SIZE')?.stepSize) || 0.00001,
      minNotional: Number(filter('NOTIONAL')?.minNotional ?? filter('MIN_NOTIONAL')?.minNotional) || 5,
    })
  }
  return out
}

/**
 * What an order actually moved: base quantity net of a commission charged in
 * the base asset, and the volume-weighted price.
 */
export function summarize(order, base) {
  const executed = Number(order.executedQty)
  const quote = Number(order.cummulativeQuoteQty)
  const feeInBase = (order.fills ?? []).filter((f) => f.commissionAsset === base).reduce((sum, f) => sum + Number(f.commission), 0)
  return {
    orderId: order.orderId,
    qty: order.side === 'BUY' ? executed - feeInBase : executed,
    gross: executed,
    price: executed > 0 ? quote / executed : 0,
    status: order.status,
  }
}

export class BinanceTestnet {
  constructor({ key, secret, base = TESTNET, fetch: fetcher = fetch, now = Date.now }) {
    if (base !== TESTNET) throw new Error(`Refusing to use ${base}: this bridge only talks to ${TESTNET}`)
    if (!key || !secret) throw new Error('BINANCE_KEY and BINANCE_SECRET (Spot Testnet) are required')
    this.key = key
    this.secret = secret
    this.base = base
    this.fetcher = fetcher
    this.now = now
  }

  async call(method, path, params = {}, signed = true) {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]))
    if (signed) {
      query.set('recvWindow', '5000')
      query.set('timestamp', String(this.now()))
      query.set('signature', sign(query.toString(), this.secret))
    }
    const response = await this.fetcher(`${this.base}${path}?${query}`, { method, headers: signed ? { 'X-MBX-APIKEY': this.key } : {} })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.msg ? `Binance: ${body.msg}` : `Binance answered ${response.status}`)
    return body
  }

  rules(symbols) {
    return this.call('GET', '/api/v3/exchangeInfo', { symbols: JSON.stringify(symbols) }, false).then(parseRules)
  }

  async price(symbol) {
    return Number((await this.call('GET', '/api/v3/ticker/price', { symbol }, false)).price)
  }

  async balances() {
    const account = await this.call('GET', '/api/v3/account', { omitZeroBalances: true })
    return new Map(account.balances.map((b) => [b.asset, Number(b.free)]))
  }

  marketBuy(symbol, quoteAmount) {
    return this.call('POST', '/api/v3/order', { symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: quoteAmount.toFixed(2), newOrderRespType: 'FULL' })
  }

  marketSell(symbol, quantity) {
    return this.call('POST', '/api/v3/order', { symbol, side: 'SELL', type: 'MARKET', quantity, newOrderRespType: 'FULL' })
  }

  /** Stop and target as one OCO pair: filling either cancels the other. */
  oco(symbol, quantity, stop, target, rules) {
    return this.call('POST', '/api/v3/orderList/oco', {
      symbol, side: 'SELL', quantity,
      aboveType: 'LIMIT_MAKER', abovePrice: roundTo(target, rules.tick),
      belowType: 'STOP_LOSS_LIMIT', belowStopPrice: roundTo(stop, rules.tick),
      // The limit sits a little under the trigger so a fast move still fills.
      belowPrice: roundTo(stop * 0.997, rules.tick), belowTimeInForce: 'GTC',
      newOrderRespType: 'RESULT',
    })
  }

  stopOnly(symbol, quantity, stop, rules) {
    return this.call('POST', '/api/v3/order', {
      symbol, side: 'SELL', type: 'STOP_LOSS_LIMIT', quantity, timeInForce: 'GTC',
      stopPrice: roundTo(stop, rules.tick), price: roundTo(stop * 0.997, rules.tick), newOrderRespType: 'RESULT',
    })
  }

  targetOnly(symbol, quantity, target, rules) {
    return this.call('POST', '/api/v3/order', { symbol, side: 'SELL', type: 'LIMIT', quantity, timeInForce: 'GTC', price: roundTo(target, rules.tick), newOrderRespType: 'RESULT' })
  }

  order(symbol, orderId) {
    return this.call('GET', '/api/v3/order', { symbol, orderId })
  }

  cancel(symbol, orderId) {
    return this.call('DELETE', '/api/v3/order', { symbol, orderId }).catch((error) => {
      // Already filled or cancelled is fine: the goal is that it is no longer working.
      if (!/Unknown order|UNKNOWN_ORDER/i.test(error.message)) throw error
    })
  }
}
