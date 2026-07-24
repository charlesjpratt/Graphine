import type { Frame, Recording, EditIntent } from './types'
import { buildDelta, titleFromText } from './frameCodec'

// Normalize a native InputEvent.inputType into the coarse intent replay cares about.
// Synthetic input events dispatched by the write controls (plain-text paste, styled-char
// insertion) set inputType too, so this covers them as well. Unknown or ambiguous types
// (notably historyUndo/Redo, which may add or remove text) return undefined, leaving replay
// to fall back to its snapshot-diff heuristic for that frame.
export function intentFromInputType(inputType: string | undefined): EditIntent | undefined {
  if (!inputType) return undefined
  if (inputType.startsWith('insert')) {
    if (inputType === 'insertFromPaste' || inputType === 'insertFromPasteAsQuotation') return 'paste'
    if (inputType === 'insertFromDrop') return 'drop'
    if (inputType === 'insertReplacementText') return 'replace'
    return 'type'  // insertText, insertParagraph, insertLineBreak, insertCompositionText, …
  }
  if (inputType.startsWith('delete')) {
    // A cut or drag-out is a structural removal; everything else is a backspace-style edit.
    if (inputType === 'deleteByCut' || inputType === 'deleteByDrag') return 'deleteCut'
    return 'deleteEdit'
  }
  if (inputType.startsWith('format')) return 'format'
  return undefined
}

export class Recorder {
  private el: HTMLElement
  private frames: Frame[] = []
  private startTime = 0
  private lastEventTime = 0
  private lastHtml = ''
  private handler: ((e: Event) => void) | null = null
  private internalInsertPending = false

  constructor(el: HTMLElement) {
    this.el = el
  }

  // Flag the next paste/drop frame as an internal copy/move — clipboard or drag content that
  // already lived in this doc — so replay tags it 'internal' and inherits the copied source's
  // provenance rather than minting a fresh paste. Set by main.ts for a paste whose text
  // matches an in-doc copy, or a drop whose drag originated inside the editor; consumed by the
  // input handler on the next insertFromPaste/insertFromDrop frame.
  markInternalInsert(): void {
    this.internalInsertPending = true
  }

  start(): void {
    this.frames = []
    this.lastHtml = ''
    this.internalInsertPending = false
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
    this.handler = (e: Event) => {
      const now = Date.now()
      const html = this.el.innerHTML
      if (this.frames.length > 0 && html === this.lastHtml) {
        this.lastEventTime = now
        return
      }
      // First frame is a self-contained keyframe; later frames are deltas that carry the
      // recorded edit intent so replay classifies provenance from truth, not inference.
      let frame: Frame
      if (this.frames.length === 0) {
        frame = { t: 0, v: html }
      } else {
        frame = { t: now - this.lastEventTime, d: buildDelta(this.lastHtml, html) }
        const inputType = (e as InputEvent).inputType
        // A paste/drop of content that originated inside the doc is an internal copy or move,
        // not incoming content: record it as 'internal' so replay inherits the source's
        // provenance. Scoped to the paste/drop insert frame, leaving a paired deleteByDrag
        // (source removal) to record as its own structural delete.
        if (this.internalInsertPending && (inputType === 'insertFromPaste' || inputType === 'insertFromDrop')) {
          frame.intent = 'internal'
          this.internalInsertPending = false
        } else {
          const intent = intentFromInputType(inputType)
          if (intent) frame.intent = intent
        }
      }
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
    this.internalInsertPending = false
  }

  get frameCount(): number {
    return this.frames.length
  }
}
