// The bridge's own record of what this session bought. A testnet account
// arrives pre-funded with many assets, so "position" cannot mean "balance":
// it means the quantity Riskline itself opened, with its average entry.

/**
 * @typedef {{ symbol: string, qty: number, entry: number, openedAt: number, orders: number[], stop?: number, target?: number, riskPerUnit?: number }} Held
 * @typedef {{ id: string, symbol: string, side: 'buy' | 'sell', qty: number, price: number, pnl?: number, reason: string, time: number }} LedgerEvent
 * @typedef {{ positions: Record<string, Held>, realized: number, events: LedgerEvent[], seq: number }} Ledger
 */

/** @returns {Ledger} */
export const emptyLedger = () => ({ positions: {}, realized: 0, events: [], seq: 0 })

export function recordBuy(ledger, symbol, qty, price, now = Date.now()) {
  const held = ledger.positions[symbol]
  if (held) {
    held.entry = (held.entry * held.qty + price * qty) / (held.qty + qty)
    held.qty += qty
  } else {
    ledger.positions[symbol] = { symbol, qty, entry: price, openedAt: now, orders: [] }
  }
  return event(ledger, { symbol, side: 'buy', qty, price, reason: 'manual' }, now)
}

export function recordSell(ledger, symbol, qty, price, reason = 'manual', now = Date.now()) {
  const held = ledger.positions[symbol]
  if (!held) throw new Error(`No ${symbol} position`)
  const sold = Math.min(qty, held.qty)
  const pnl = (price - held.entry) * sold
  ledger.realized += pnl
  held.qty -= sold
  if (held.qty <= 1e-12) delete ledger.positions[symbol]
  return event(ledger, { symbol, side: 'sell', qty: sold, price, pnl, reason }, now)
}

/** Remember the protective levels and the exchange orders that implement them. */
export function setProtection(ledger, symbol, { stop, target, orders }) {
  const held = ledger.positions[symbol]
  if (!held) throw new Error(`No ${symbol} position`)
  if (stop !== undefined && held.riskPerUnit === undefined && stop < held.entry) held.riskPerUnit = held.entry - stop
  held.stop = stop
  held.target = target
  held.orders = orders ?? []
  return held
}

function event(ledger, fill, now) {
  const done = { ...fill, id: `t${++ledger.seq}`, time: now }
  ledger.events.push(done)
  if (ledger.events.length > 200) ledger.events.shift()
  return done
}

export const eventsSince = (ledger, id) => {
  const from = Number(String(id ?? '').replace(/\D/g, '')) || 0
  return ledger.events.filter((e) => Number(e.id.slice(1)) > from)
}

/** Shape the app expects from `Broker.account()`. */
export function accountView(ledger, cash) {
  return {
    mode: 'testnet',
    cash,
    realized: ledger.realized,
    positions: Object.values(ledger.positions).map(({ orders, ...position }) => position),
  }
}
