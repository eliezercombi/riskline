// Pure page builders: state in, a list of boxes out. Nothing here touches the
// SDK, so layouts can be tested without glasses or a simulator.
//
// The canvas is 576x288, one proportional font, 27px line height, five text
// brightness levels (0-4). At most 8 text/list boxes per page, one of which
// captures input.

import * as f from '../core/format.ts'
import type { Measure } from '../core/format.ts'
import type { AlertRule } from '../core/alerts.ts'
import type { View } from '../core/session.ts'

export const W = 576
export const H = 288
/** Left and right margin of text boxes. Boxes carry no padding, so a line is exactly LINE tall. */
const MARGIN = 4
const INNER = W - 2 * MARGIN
const LINE = 27

export interface TextBox {
  type: 'text'
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  text: string
  /** Text brightness 0-4. */
  level: number
  capture?: boolean
}

export interface ListBox {
  type: 'list'
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  items: string[]
}

export type Box = TextBox | ListBox

export interface Page {
  /** Pages with the same key share a layout, so only changed text is re-sent. */
  key: string
  boxes: Box[]
  menu: { id: number; label: string }[]
}

export const MENU_FLATTEN = 1
export const MENU_ALERTS = 2

const text = (id: number, name: string, y: number, lines: number, content: string, level: number): TextBox => ({
  type: 'text', id, name, x: MARGIN, y, w: INNER, h: lines * LINE, text: content || ' ', level,
})

/** Invisible full-screen box that receives taps and swipes on text pages. */
const captureLayer = (): TextBox => ({ type: 'text', id: 90, name: 'input', x: 0, y: 0, w: W, h: H, text: ' ', level: 0, capture: true })

export interface Chrome {
  mode: 'paper' | 'testnet'
  alertsPaused: boolean
  anyPosition: boolean
}

function menu(chrome: Chrome): Page['menu'] {
  const items = [{ id: MENU_ALERTS, label: chrome.alertsPaused ? 'Resume alerts' : 'Pause alerts' }]
  if (chrome.anyPosition) items.unshift({ id: MENU_FLATTEN, label: 'Flatten all' })
  return items
}

export function sessionPage(view: View, index: number, count: number, note: string, rules: AlertRule[], chrome: Chrome, measure: Measure): Page {
  const dp = f.priceDecimals(view.price)
  const p = (value: number) => f.price(value, dp)
  const left = view.held ? `${view.base}   ${f.qty(view.qty)} held` : `${view.base}   flat`
  const right = `${chrome.mode === 'paper' ? 'PAPER' : 'TESTNET'}   ${index + 1}/${count}`

  const priceLine = view.stale
    ? `${p(view.price)}   waiting for prices...`
    : `${p(view.price)}   ${f.arrow(view.change24h)} ${f.pct(view.change24h)} 24h`

  let pnlLine: string
  if (!view.held) pnlLine = 'No position'
  else {
    pnlLine = `P&L ${f.signed(view.pnl)} ${view.quote}   ${f.pct(view.pnlRatio)}`
    if (view.r !== undefined) pnlLine += `   ${f.rMultiple(view.r)}`
    if (view.riskFree) pnlLine += '   risk-free'
  }

  const cell = measure('━') || 12
  const cells = Math.max(8, Math.floor(INNER / cell) - 1)
  const spark = f.sparkline(view.history, Math.min(32, cells))

  let riskTop = ''
  let riskBottom = ''
  if (view.held) {
    const stopLabel = view.stop !== undefined ? `Stop ${p(view.stop)} (${f.pct(view.toStop ?? 0, 1)})` : 'No stop'
    const targetLabel = view.target !== undefined ? `Target ${p(view.target)} (${f.pct(view.toTarget ?? 0, 1)})` : 'no target'
    riskTop = f.spread(stopLabel, targetLabel, INNER, measure)
    riskBottom = view.stop !== undefined && view.target !== undefined
      ? f.gauge(view.stop, view.price, view.target, cells)
      : view.stop === undefined ? 'Tap to add a stop.' : ''
  } else if (rules.length) {
    riskTop = `Alerts: ${rules.map((r) => `${r.kind} ${p(r.level)}`).join(' · ')}`
  }

  return {
    key: 'session',
    menu: menu(chrome),
    boxes: [
      captureLayer(),
      text(1, 'head', 0, 1, f.spread(left, right, INNER, measure), 2),
      text(2, 'price', 30, 1, priceLine, 4),
      text(3, 'pnl', 60, 1, pnlLine, view.held ? 4 : 2),
      text(4, 'spark', 94, 1, spark ? `${spark}  24h` : '', 2),
      text(5, 'risk', 128, 2, riskBottom ? `${riskTop}\n${riskBottom}` : riskTop, 3),
      text(6, 'note', 196, 1, f.fit(note, INNER, measure), 3),
      text(7, 'hint', 258, 1, 'tap: actions    swipe: next    double-tap: exit', 1),
    ],
  }
}

export function actionsPage(view: View, labels: string[], chrome: Chrome): Page {
  return {
    key: `actions:${view.symbol}:${labels.join('|')}`,
    menu: menu(chrome),
    boxes: [
      text(1, 'title', 0, 1, `${view.base}   ${f.price(view.price)}   choose an action`, 2),
      { type: 'list', id: 2, name: 'actions', x: 0, y: 32, w: W, h: H - 32, items: [...labels, 'Back'] },
    ],
  }
}

export function confirmPage(lines: string[], chrome: Chrome): Page {
  return {
    key: 'confirm',
    menu: menu(chrome),
    boxes: [
      captureLayer(),
      text(1, 'title', 24, 1, lines[0] ?? '', 4),
      text(2, 'body', 66, 3, lines.slice(1).join('\n'), 3),
      text(3, 'hint', 228, 2, 'tap: confirm\ndouble-tap: cancel', 2),
    ],
  }
}

export function resultPage(ok: boolean, lines: string[], chrome: Chrome): Page {
  return {
    key: 'result',
    menu: menu(chrome),
    boxes: [
      captureLayer(),
      text(1, 'title', 24, 1, ok ? 'Done' : 'Not done', 4),
      text(2, 'body', 66, 4, lines.join('\n'), 3),
      text(3, 'hint', 258, 1, 'tap: back', 1),
    ],
  }
}

export interface Card {
  tag: string
  title: string
  body: string[]
  /** What a tap will do, spelled out. Empty when a tap just opens the action list. */
  offer: string
}

export function cardPage(card: Card, waiting: number, chrome: Chrome, measure: Measure): Page {
  const more = waiting > 0 ? `+${waiting} more` : ''
  return {
    key: 'card',
    menu: menu(chrome),
    boxes: [
      captureLayer(),
      text(1, 'tag', 0, 1, f.spread(card.tag, more, INNER, measure), 2),
      text(2, 'title', 36, 1, card.title, 4),
      text(3, 'body', 72, 3, card.body.join('\n'), 3),
      text(4, 'offer', 176, 2, card.offer ? `Tap: ${card.offer}` : 'Tap: open actions', 4),
      text(5, 'hint', 258, 1, 'swipe or double-tap: dismiss', 1),
    ],
  }
}

export function emptyPage(message: string, chrome: Chrome): Page {
  return {
    key: 'empty',
    menu: menu(chrome),
    boxes: [captureLayer(), text(1, 'title', 100, 2, message, 3), text(2, 'hint', 258, 1, 'double-tap: exit', 1)],
  }
}
