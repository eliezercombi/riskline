// Sends pages to the glasses with as little traffic as possible.
//
//   first page            -> createStartUpPageContainer (allowed exactly once)
//   layout or menu change -> rebuildPageContainer (full redraw, brief flicker)
//   same layout           -> textContainerUpgrade for the boxes whose text changed
//
// Calls are strictly serialised and bursts are coalesced: while one page is on
// its way, only the newest pending page is kept.

import type { Box, Page } from './pages.ts'

export interface Bridge {
  createStartUpPageContainer(container: unknown): Promise<number>
  rebuildPageContainer(container: unknown): Promise<boolean>
  textContainerUpgrade(container: unknown): Promise<boolean>
  shutDownPageContainer(exitMode?: number): Promise<boolean>
}

export interface DisplayOptions {
  /** Minimum gap between two sends, in ms. The Bluetooth link is slow; text does not need 60 fps. */
  minGapMs?: number
  /** Give up on a single bridge call after this long. */
  timeoutMs?: number
  log?: (message: string) => void
}

const CAPTURE_Z = 1

function describe(box: Box, z: number): Record<string, unknown> {
  const base = {
    xPosition: box.x, yPosition: box.y, width: box.w, height: box.h,
    containerID: box.id, containerName: box.name, zOrderIndex: z,
  }
  if (box.type === 'list') {
    return {
      ...base, borderWidth: 0, borderColor: 0, paddingLength: 0, isEventCapture: 1,
      itemContainer: { itemCount: box.items.length, itemWidth: 0, isItemSelectBorderEn: 1, itemName: box.items },
    }
  }
  return {
    ...base, borderWidth: 0, borderColor: 0, paddingLength: 0,
    isEventCapture: box.capture ? 1 : 0, content: box.text, textColor: box.level,
  }
}

export function payload(page: Page): Record<string, unknown> {
  // The input layer sits at the back; everything else stacks in declaration order.
  let z = CAPTURE_Z
  const boxes = page.boxes.map((box) => ({ box, z: box.type === 'text' && box.capture ? CAPTURE_Z : ++z }))
  const out: Record<string, unknown> = {
    containerTotalNum: page.boxes.length,
    textObject: boxes.filter((b) => b.box.type === 'text').map((b) => describe(b.box, b.z)),
    listObject: boxes.filter((b) => b.box.type === 'list').map((b) => describe(b.box, b.z)),
  }
  if (page.menu.length) out.menuObject = { menuItems: page.menu.map((item) => ({ itemName: item.label, itemID: item.id })) }
  return out
}

const signature = (page: Page): string => `${page.key}#${page.menu.map((m) => `${m.id}:${m.label}`).join(',')}`
const stamp = (box: Box): string => (box.type === 'text' ? `${box.level}|${box.text}` : box.items.join('|'))

export class Display {
  private bridge: Bridge
  private options: Required<DisplayOptions>
  private started = false
  private layout = ''
  private shown = new Map<string, string>()
  private pending: Page | null = null
  private pumping = false
  private lastSend = 0
  /** Counters, exposed for the companion page and for tests. */
  stats = { creates: 0, rebuilds: 0, upgrades: 0, failures: 0 }

  constructor(bridge: Bridge, options: DisplayOptions = {}) {
    this.bridge = bridge
    this.options = { minGapMs: options.minGapMs ?? 250, timeoutMs: options.timeoutMs ?? 4000, log: options.log ?? (() => {}) }
  }

  show(page: Page): void {
    this.pending = page
    void this.pump()
  }

  /** Resolves when everything queued so far has been sent. */
  async idle(): Promise<void> {
    while (this.pumping || this.pending) await new Promise((resolve) => setTimeout(resolve, 10))
  }

  exit(): void {
    void this.guard('shutDownPageContainer', () => this.bridge.shutDownPageContainer(1))
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.pending) {
        const page = this.pending
        this.pending = null
        const wait = this.lastSend + this.options.minGapMs - Date.now()
        if (this.started && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        await this.apply(page)
        this.lastSend = Date.now()
      }
    } finally {
      this.pumping = false
    }
  }

  private remember(page: Page): void {
    this.layout = signature(page)
    this.shown = new Map(page.boxes.map((box) => [box.name, stamp(box)]))
  }

  private async apply(page: Page): Promise<void> {
    if (!this.started) {
      const code = await this.guard('createStartUpPageContainer', () => this.bridge.createStartUpPageContainer(payload(page)))
      if (code === 0) {
        this.started = true
        this.stats.creates += 1
        this.remember(page)
      } else {
        this.options.log(`createStartUpPageContainer returned ${String(code)}`)
        this.pending ??= page // try again with the next render
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      return
    }

    if (signature(page) !== this.layout) {
      const ok = await this.guard('rebuildPageContainer', () => this.bridge.rebuildPageContainer(payload(page)))
      if (ok) {
        this.stats.rebuilds += 1
        this.remember(page)
      }
      return
    }

    for (const box of page.boxes) {
      if (box.type !== 'text' || this.shown.get(box.name) === stamp(box)) continue
      const ok = await this.guard('textContainerUpgrade', () =>
        this.bridge.textContainerUpgrade({ containerID: box.id, containerName: box.name, content: box.text, textColor: box.level }))
      if (ok) {
        this.stats.upgrades += 1
        this.shown.set(box.name, stamp(box))
      }
    }
  }

  private async guard<T>(name: string, call: () => Promise<T>): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        call(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), this.options.timeoutMs) }),
      ])
    } catch (error) {
      this.stats.failures += 1
      this.options.log(`${name} failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
}
