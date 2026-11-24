// Turns raw account state and ticks into what the glasses show.

import type { Position, SymbolRules, Tick } from './types.ts'

export interface View {
  symbol: string
  base: string
  quote: string
  price: number
  /** Change over 24h as a ratio. */
  change24h: number
  held: boolean
  qty: number
  entry: number
  /** Position value at the current price. */
  value: number
  pnl: number
  pnlRatio: number
  /** Open profit in multiples of the initial risk, when a stop defined it. */
  r?: number
  stop?: number
  target?: number
  /** Signed distance from the current price, as a ratio of it (stop is negative). */
  toStop?: number
  toTarget?: number
  /** Stop at or above entry: the position can no longer lose (before fees). */
  riskFree: boolean
  /** Recent closes, oldest first. */
  history: number[]
  stale: boolean
}

export function viewOf(
  rules: SymbolRules,
  tick: Tick | undefined,
  position: Position | undefined,
  history: number[] = [],
  now = Date.now(),
): View {
  const px = tick?.price ?? position?.entry ?? 0
  const qty = position?.qty ?? 0
  const entry = position?.entry ?? 0
  const pnl = position ? (px - entry) * qty : 0
  const view: View = {
    symbol: rules.symbol,
    base: rules.base,
    quote: rules.quote,
    price: px,
    change24h: tick && tick.open24h > 0 ? px / tick.open24h - 1 : 0,
    held: Boolean(position),
    qty,
    entry,
    value: px * qty,
    pnl,
    pnlRatio: position && entry > 0 ? px / entry - 1 : 0,
    stop: position?.stop,
    target: position?.target,
    riskFree: Boolean(position && position.stop !== undefined && position.stop >= entry),
    history,
    stale: !tick || now - tick.time > 15_000,
  }
  if (position?.riskPerUnit && position.riskPerUnit > 0) view.r = (px - entry) / position.riskPerUnit
  if (position?.stop !== undefined && px > 0) view.toStop = position.stop / px - 1
  if (position?.target !== undefined && px > 0) view.toTarget = position.target / px - 1
  return view
}

/** Positions first (largest value first), then the rest of the watchlist in its own order. */
export function order(views: View[]): View[] {
  const held = views.filter((v) => v.held).sort((a, b) => b.value - a.value)
  return [...held, ...views.filter((v) => !v.held)]
}
