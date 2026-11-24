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
 * Warn once when the price comes within `band` of the stop or the target.
 * `seen` remembers what was already announced; a key clears when the price
 * moves back out to twice the band, so the warning can fire again later.
 */
export function proximity(view: View, seen: Set<string>, band = 0.0025): Proximity | null {
  if (!view.held) return null
  const checks: [Proximity, number | undefined][] = [
    ['stop-near', view.toStop !== undefined ? -view.toStop : undefined],
    ['target-near', view.toTarget],
  ]
  for (const [kind, distance] of checks) {
    const key = `${view.symbol}:${kind}`
    if (distance === undefined) {
      seen.delete(key)
      continue
    }
    if (distance > band * 2) seen.delete(key)
    if (distance >= 0 && distance <= band && !seen.has(key)) {
      seen.add(key)
      return kind
    }
  }
  return null
}
