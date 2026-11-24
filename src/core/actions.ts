// What a tap can do, given the state of one symbol.
//
// Design rule: actions that reduce risk come first and are the only ones an
// alert card may offer as its one-tap default. Anything that adds risk always
// goes through the menu and a confirmation.

import * as f from './format.ts'
import type { Alerts } from './alerts.ts'
import type { View } from './session.ts'
import type { Broker, SymbolRules } from './types.ts'
import { roundDown, roundTo } from './types.ts'

export interface Settings {
  /** Quote amounts offered for entries. */
  sizes: number[]
  /** Default stop distance below entry, as a ratio (0.01 = 1%). */
  stopPct: number
  /** Default target distance above entry. */
  targetPct: number
  /** Distance used by "trail stop". */
  trailPct: number
  /** Distance used by quick price alerts. */
  alertPct: number
}

export const DEFAULT_SETTINGS: Settings = { sizes: [100, 500], stopPct: 0.01, targetPct: 0.02, trailPct: 0.005, alertPct: 0.01 }

export interface Action {
  id: string
  /** Menu label, at most 64 characters. */
  label: string
  /** Lines shown on the confirmation screen. */
  confirm: string[]
  effect: 'reduce' | 'add' | 'neutral'
  /** Performs the action and returns the line to show afterwards. */
  run: () => Promise<string>
}

export interface Context {
  broker: Broker
  alerts: Alerts
  rules: SymbolRules
  settings: Settings
  cash: number
}

export function actionsFor(view: View, ctx: Context): Action[] {
  const { broker, alerts, rules, settings } = ctx
  const px = view.price
  // Show levels as precisely as the session screen does, never finer than the exchange tick.
  const dp = Math.min(Math.max(0, -Math.floor(Math.log10(rules.tick))), f.priceDecimals(px))
  const p = (value: number) => f.price(value, dp)
  const out: Action[] = []

  if (view.held) {
    const breakEven = roundTo(view.entry, rules.tick)
    if (px > breakEven && (view.stop === undefined || view.stop < breakEven)) {
      out.push({
        id: 'stop-be',
        label: `Stop to break-even (${p(breakEven)})`,
        confirm: [`Move stop to break-even?`, `${view.base} stop ${view.stop === undefined ? 'none' : p(view.stop)} -> ${p(breakEven)}`, 'The position can no longer lose.'],
        effect: 'reduce',
        run: async () => {
          await broker.protect(view.symbol, { stop: breakEven })
          return `Stop at ${p(breakEven)}. ${view.base} is risk-free.`
        },
      })
    }

    // Shown exactly as it will be sent: half the position, rounded down to the lot size.
    const half = roundDown(view.qty / 2, rules.step)
    if (half * px >= rules.minNotional && half >= rules.step) {
      out.push({
        id: 'half',
        label: `Take half off (${f.signed((px - view.entry) * half)} ${rules.quote})`,
        confirm: [`Take half off ${view.base}?`, `Sell ${f.qty(half)} at market, about ${f.group(half * px, 2)} ${rules.quote}`, `Locks in ${f.signed((px - view.entry) * half)} ${rules.quote}`],
        effect: 'reduce',
        run: async () => {
          const fill = await broker.sell(view.symbol, 0.5)
          return `Sold ${f.qty(fill.qty)} ${view.base} at ${p(fill.price)}  ${f.signed(fill.pnl ?? 0)}`
        },
      })
    }

    out.push({
      id: 'close',
      label: `Close ${view.base} (${f.signed(view.pnl)} ${rules.quote})`,
      confirm: [`Close ${view.base}?`, `Sell ${f.qty(view.qty)} at market, about ${f.group(view.value, 2)} ${rules.quote}`, `Result ${f.signed(view.pnl)} ${rules.quote} (${f.pct(view.pnlRatio)})`],
      effect: 'reduce',
      run: async () => {
        const fill = await broker.sell(view.symbol, 1)
        return `Closed ${view.base} at ${p(fill.price)}  ${f.signed(fill.pnl ?? 0)} ${rules.quote}`
      },
    })

    const trail = roundTo(px * (1 - settings.trailPct), rules.tick)
    if (view.stop === undefined || trail > view.stop) {
      out.push({
        id: 'trail',
        label: `Trail stop to ${p(trail)} (-${(settings.trailPct * 100).toFixed(1)}%)`,
        confirm: [`Trail the stop?`, `${view.base} stop ${view.stop === undefined ? 'none' : p(view.stop)} -> ${p(trail)}`, `${(settings.trailPct * 100).toFixed(1)}% under the current price`],
        effect: 'reduce',
        run: async () => {
          await broker.protect(view.symbol, { stop: trail })
          return `Stop trailed to ${p(trail)}.`
        },
      })
    }

    if (view.stop === undefined && view.target === undefined) {
      const stop = roundTo(px * (1 - settings.stopPct), rules.tick)
      const target = roundTo(px * (1 + settings.targetPct), rules.tick)
      out.push({
        id: 'bracket',
        label: `Add stop ${p(stop)} / target ${p(target)}`,
        confirm: [`Protect ${view.base}?`, `Stop ${p(stop)} (-${(settings.stopPct * 100).toFixed(1)}%)`, `Target ${p(target)} (+${(settings.targetPct * 100).toFixed(1)}%)`],
        effect: 'reduce',
        run: async () => {
          await broker.protect(view.symbol, { stop, target })
          return `Stop ${p(stop)}, target ${p(target)} set.`
        },
      })
    }
  }

  for (const size of settings.sizes) {
    if (size > ctx.cash || size < rules.minNotional) continue
    const stop = roundTo(px * (1 - settings.stopPct), rules.tick)
    const target = roundTo(px * (1 + settings.targetPct), rules.tick)
    const risk = size * settings.stopPct
    out.push({
      id: `buy-${size}`,
      label: `${view.held ? 'Add' : 'Buy'} ${f.group(size, 0)} ${rules.quote}, risk ${f.group(risk, 2)}`,
      confirm: view.held
        ? [`Add ${f.group(size, 0)} ${rules.quote} of ${view.base}?`, `Market buy at about ${p(px)}`, 'Stop and target stay where they are.']
        : [`Buy ${f.group(size, 0)} ${rules.quote} of ${view.base}?`, `Market at about ${p(px)}, stop ${p(stop)}, target ${p(target)}`, `Risk ${f.group(risk, 2)} ${rules.quote} to make ${f.group(size * settings.targetPct, 2)}`],
      effect: 'add',
      run: async () => {
        const wasHeld = view.held
        const fill = await broker.buy(view.symbol, size)
        if (!wasHeld) {
          // Every new position starts with a stop. Levels are set from the real fill price.
          await broker.protect(view.symbol, {
            stop: roundTo(fill.price * (1 - settings.stopPct), rules.tick),
            target: roundTo(fill.price * (1 + settings.targetPct), rules.tick),
          })
        }
        return `Bought ${f.qty(fill.qty)} ${view.base} at ${p(fill.price)}`
      },
    })
  }

  for (const kind of ['above', 'below'] as const) {
    const level = roundTo(px * (1 + (kind === 'above' ? 1 : -1) * settings.alertPct), rules.tick)
    out.push({
      id: `alert-${kind}`,
      label: `Alert ${kind} ${p(level)} (${kind === 'above' ? '+' : '-'}${(settings.alertPct * 100).toFixed(1)}%)`,
      confirm: [`Set an alert?`, `${view.base} ${kind} ${p(level)}`, 'It fires once.'],
      effect: 'neutral',
      run: async () => {
        alerts.add(view.symbol, kind, level)
        return `Alert set: ${view.base} ${kind} ${p(level)}`
      },
    })
  }

  if (view.held && (view.stop !== undefined || view.target !== undefined)) {
    out.push({
      id: 'unprotect',
      label: 'Remove stop and target',
      confirm: [`Remove protection from ${view.base}?`, 'Stop and target orders are cancelled.', 'The position will have no stop.'],
      effect: 'add',
      run: async () => {
        await broker.protect(view.symbol, { stop: null, target: null })
        return `${view.base} has no stop now.`
      },
    })
  }

  return out
}

/** The single risk-reducing action an alert card offers on tap, if there is one. */
export function suggest(view: View, reason: 'above' | 'below' | 'stop-near' | 'target-near', actions: Action[]): Action | undefined {
  if (!view.held) return undefined
  const pick = (id: string) => actions.find((a) => a.id === id && a.effect === 'reduce')
  if (reason === 'above') return pick('stop-be') ?? pick('trail') ?? pick('half')
  if (reason === 'target-near') return pick('half') ?? pick('stop-be') ?? pick('trail')
  return pick('close')
}
