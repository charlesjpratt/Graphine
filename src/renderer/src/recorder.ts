import type { Frame, Recording } from './types'
import { buildDelta, titleFromText } from './frameCodec'

export class Recorder {
  private el: HTMLElement
  private frames: Frame[] = []
  private startTime = 0
  private lastEventTime = 0
  private lastHtml = ''
  private handler: (() => void) | null = null

  constructor(el: HTMLElement) {
    this.el = el
  }

  start(): void {
    this.frames = []
    this.lastHtml = ''
    this.startTime = Date.now()
    this.lastEventTime = this.startTime
    this.attach()
  }

  // Re-attach the input listener without clearing already-captured frames or
  // resetting startTime — used to keep a recording alive after a cancelled/failed save.
  resume(): void {
    if (this.handler) return
    this.lastEventTime = Date.now()
    this.attach()
  }

  private attach(): void {
    this.handler = () => {
      const now = Date.now()
      const html = this.el.innerHTML
      if (this.frames.length > 0 && html === this.lastHtml) {
        this.lastEventTime = now
        return
      }
      // First frame is a self-contained keyframe; later frames are deltas.
      const frame: Frame = this.frames.length === 0
        ? { t: 0, v: html }
        : { t: now - this.lastEventTime, d: buildDelta(this.lastHtml, html) }
      this.frames.push(frame)
      this.lastHtml = html
      this.lastEventTime = now
    }

    this.el.addEventListener('input', this.handler)
  }

  captureNow(baseline = false): void {
    const html = this.el.innerHTML
    const frame: Frame = { t: 0, v: html }
    if (baseline) frame.baseline = true
    this.frames.push(frame)
    this.lastHtml = html
    this.lastEventTime = Date.now()
  }

  captureTabSwitch(toTabId: string, toTabName: string): void {
    const now = Date.now()
    const html = this.el.innerHTML
    const delta = this.frames.length === 0 ? 0 : now - this.lastEventTime
    this.frames.push({ t: delta, v: html, tabSwitch: { toTabId, toTabName } })
    this.lastHtml = html
    this.lastEventTime = now
  }

  get isRecording(): boolean {
    return this.handler !== null
  }

  stop(): Recording {
    if (this.handler) {
      this.el.removeEventListener('input', this.handler)
      this.handler = null
    }

    const durationMs = this.frames.length > 0 ? Date.now() - this.startTime : 0

    return {
      version: 2,
      meta: {
        title: titleFromText(this.el.textContent ?? ''),
        createdAt: new Date(this.startTime).toISOString(),
        durationMs,
        frameCount: this.frames.length,
      },
      frames: this.frames,
    }
  }

  reset(): void {
    if (this.handler) {
      this.el.removeEventListener('input', this.handler)
      this.handler = null
    }
    this.frames = []
    this.lastHtml = ''
  }

  get frameCount(): number {
    return this.frames.length
  }
}
