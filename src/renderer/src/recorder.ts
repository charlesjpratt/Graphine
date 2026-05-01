import type { Recording } from './types'

export class Recorder {
  private el: HTMLElement
  private frames: { t: number; v: string }[] = []
  private startTime = 0
  private lastEventTime = 0
  private handler: (() => void) | null = null

  constructor(el: HTMLElement) {
    this.el = el
  }

  start(): void {
    this.frames = []
    this.startTime = Date.now()
    this.lastEventTime = this.startTime

    this.handler = () => {
      const now = Date.now()
      const html = this.el.innerHTML
      const last = this.frames[this.frames.length - 1]
      if (last && last.v === html) {
        this.lastEventTime = now
        return
      }
      const delta = this.frames.length === 0 ? 0 : now - this.lastEventTime
      this.frames.push({ t: delta, v: html })
      this.lastEventTime = now
    }

    this.el.addEventListener('input', this.handler)
  }

  captureNow(): void {
    this.frames.push({ t: 0, v: this.el.innerHTML })
    this.lastEventTime = Date.now()
  }

  stop(): Recording {
    if (this.handler) {
      this.el.removeEventListener('input', this.handler)
      this.handler = null
    }

    const durationMs = this.frames.length > 0 ? Date.now() - this.startTime : 0
    const firstLine = (this.el.textContent ?? '').split('\n')[0].trim()

    return {
      version: 1,
      meta: {
        title: firstLine.slice(0, 80),
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
  }

  get frameCount(): number {
    return this.frames.length
  }
}
