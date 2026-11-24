// Price alerts. Each rule fires once, on the tick that crosses its level.

import type { View } from './session.ts'

export interface AlertRule {
  id: string
  symbol: string
  kind: 'above' | 'below'
  level: number
  createdAt: number
}

export interface AlertHit {
  rule: AlertRule
  price: number
  time: number
}

export class Alerts {
  rules: AlertRule[]
  private last = new Map<string, number>()
  private seq = 0

  constructor(rules: AlertRule[] = []) {
    this.rules = rules
    for (const rule of rules) this.seq = Math.max(this.seq, Number(rule.id.replace(/\D/g, '')) || 0)
  }

  add(symbol: string, kind: AlertRule['kind'], level: number, now = Date.now()): AlertRule {
    const rule: AlertRule = { id: `a${++this.seq}`, symbol, kind, level, createdAt: now }
    this.rules.push(rule)
    return rule
  }

  remove(id: string): void {
    this.rules = this.rules.filter((rule) => rule.id !== id)
  }

  for(symbol: string): AlertRule[] {
    return this.rules.filter((rule) => rule.symbol === symbol)
  }

  /** Returns the rules crossed by this tick and drops them. The first tick only sets the baseline. */
  check(symbol: string, price: number, now = Date.now()): AlertHit[] {
    const before = this.last.get(symbol)
    this.last.set(symbol, price)
    if (before === undefined) return []
    const hits: AlertHit[] = []
    for (const rule of this.for(symbol)) {
      const crossed = rule.kind === 'above' ? before < rule.level && price >= rule.level : before > rule.level && price <= rule.level
      if (crossed) hits.push({ rule, price, time: now })
    }
    for (const hit of hits) this.remove(hit.rule.id)
    return hits
  }
}

export type Proximity = 'stop-near' | 'target-near'

/**
 * Warn when the price comes close to the stop or the target.
 *
 * "Close" scales with the trade: a quarter of the planned distance, capped at
 * `cap` of the price, so a tight stop does not warn the moment it is placed.
 * A warning has to be armed first by the price being at least twice that far
 * away, and it disarms when it fires, so each approach is announced once.
 */
export function proximity(view: View, armed: Set<string>, cap = 0.0025): Proximity | null {
  if (!view.held || !(view.price > 0)) return null
  const planned = (level: number | undefined) => (level === undefined ? cap : Math.abs(level - view.entry) / view.price)
  const checks: [Proximity, number | undefined, number][] = [
    ['stop-near', view.toStop !== undefined ? -view.toStop : undefined, Math.min(cap, planned(view.stop) * 0.25 || cap)],
    ['target-near', view.toTarget, Math.min(cap, planned(view.target) * 0.25 || cap)],
  ]
  for (const [kind, distance, band] of checks) {
    const key = `${view.symbol}:${kind}`
    if (distance === undefined) {
      armed.delete(key)
      continue
    }
    if (distance > band * 2) armed.add(key)
    else if (distance >= 0 && distance <= band && armed.has(key)) {
      armed.delete(key)
      return kind
    }
  }
  return null
}
