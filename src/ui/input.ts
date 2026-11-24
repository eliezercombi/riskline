// Maps raw Even Hub events onto the handful of inputs the app understands.
//
// Quirks handled here so nothing else has to know about them:
//   - event types are protobuf enums, and the zero value (a single press) is
//     omitted on the wire, so it arrives as `undefined`;
//   - presses on a text container arrive as `sysEvent`, swipes as `textEvent`;
//   - a press on a list arrives as `listEvent` with the selected index, which
//     is also omitted when it is 0;
//   - menu selections arrive on their own field regardless of the page.

import type { Input } from './app.ts'

export const EVENT = {
  CLICK: 0,
  SCROLL_TOP: 1,
  SCROLL_BOTTOM: 2,
  DOUBLE_CLICK: 3,
  FOREGROUND_ENTER: 4,
  FOREGROUND_EXIT: 5,
  ABNORMAL_EXIT: 6,
  SYSTEM_EXIT: 7,
  IMU_DATA: 8,
  LONG_PRESS: 9,
  LONG_PRESS_RELEASE: 10,
} as const

export type Lifecycle = 'foreground' | 'background' | 'exit'

export interface HubEvent {
  listEvent?: { eventType?: number; currentSelectItemIndex?: number }
  textEvent?: { eventType?: number }
  sysEvent?: { eventType?: number; imuData?: unknown }
  menuItemClickEvent?: { itemID?: number }
  audioEvent?: unknown
}

export function translate(event: HubEvent): Input | Lifecycle | null {
  const menu = event.menuItemClickEvent?.itemID
  if (menu !== undefined) return { menu }

  if (event.listEvent) {
    const type = event.listEvent.eventType ?? EVENT.CLICK
    if (type === EVENT.DOUBLE_CLICK) return 'double'
    if (type === EVENT.CLICK) return { select: event.listEvent.currentSelectItemIndex ?? 0 }
    return null
  }

  if (event.textEvent) {
    const type = event.textEvent.eventType ?? EVENT.CLICK
    if (type === EVENT.SCROLL_TOP) return 'up'
    if (type === EVENT.SCROLL_BOTTOM) return 'down'
    if (type === EVENT.DOUBLE_CLICK) return 'double'
    if (type === EVENT.CLICK) return 'tap'
    return null
  }

  if (event.sysEvent) {
    if (event.sysEvent.imuData !== undefined) return null
    switch (event.sysEvent.eventType ?? EVENT.CLICK) {
      case EVENT.CLICK: return 'tap'
      case EVENT.DOUBLE_CLICK: return 'double'
      case EVENT.SCROLL_TOP: return 'up'
      case EVENT.SCROLL_BOTTOM: return 'down'
      case EVENT.FOREGROUND_ENTER: return 'foreground'
      case EVENT.FOREGROUND_EXIT: return 'background'
      case EVENT.LONG_PRESS: return 'hold'
      case EVENT.LONG_PRESS_RELEASE: return 'release'
      case EVENT.ABNORMAL_EXIT:
      case EVENT.SYSTEM_EXIT: return 'exit'
      default: return null
    }
  }

  return null
}
