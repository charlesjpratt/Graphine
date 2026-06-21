import type { Recording, PlaybackOptions } from './types'
import { frameToHtml } from './frameCodec'

// ── Char history ──────────────────────────────────────────────────────────────

type CharType = 'typed' | 'pasted' | 'overwrite'

interface CharEntry {
  char: string  // single char; '\n' renders as <br>
  type: CharType
  pasteGroup?: number
  overwriteCount?: number  // 1 = first overwrite, capped display at 4
  fontFamily?: string
}

// pink → red over 4 steps
const OVERWRITE_COLORS = ['#fda4af', '#fb7185', '#f87171', '#ef4444']

function overwriteColor(count: number): string {
  return OVERWRITE_COLORS[Math.min(count, OVERWRITE_COLORS.length) - 1]
}

// key used to decide when to open/close a <span>
function styleKey(entry: CharEntry): string {
  const f = entry.fontFamily ? `:f:${entry.fontFamily}` : ''
  if (entry.type === 'typed') return f ? `t${f}` : ''
  if (entry.type === 'overwrite') return `ow:${Math.min(entry.overwriteCount ?? 1, 4)}${f}`
  return `paste:${entry.pasteGroup}${f}`
}

// Persistent off-screen element — lets the browser handle all paragraph/div/br cases
let textExtractor: HTMLDivElement | null = null

function htmlToTextAndStyles(html: string): { text: string; styles: string[] } {
  if (!textExtractor) {
    textExtractor = document.createElement('div')
    textExtractor.style.cssText = 'position:fixed;opacity:0;white-space:pre-wrap;pointer-events:none;top:-9999px;left:-9999px'
    document.body.appendChild(textExtractor)
  }
  // Strip trailing <br> Chrome adds as a cursor placeholder in contenteditable, then
  // remove cursor-placeholder <br>s inside block elements (trailing child with siblings).
  // A <br> that is the only child of its parent is a real empty-line marker — leave it.
  textExtractor.innerHTML = html.replace(/<br\s*\/?>\s*$/i, '')
  const removeCursorBr = (el: Element): void => {
    for (const child of Array.from(el.children)) removeCursorBr(child)
    const last = el.lastElementChild
    if (last?.tagName === 'BR' && el.childNodes.length > 1) last.remove()
  }
  removeCursorBr(textExtractor)
  // innerText is authoritative for character sequence (handles br, divs, whitespace)
  const text = textExtractor.innerText

  // Walk DOM to collect font-family per character
  const fonts: string[] = []
  function walk(node: Node, font: string): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent ?? '').length
      for (let i = 0; i < len; i++) fonts.push(font)
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      const tag = el.tagName.toUpperCase()
      const nextFont = el.style.fontFamily || font
      if (tag === 'BR') {
        fonts.push(font)
      } else {
        // Mirror innerText: block elements emit a leading newline when not first
        if ((tag === 'DIV' || tag === 'P') && fonts.length > 0) fonts.push(nextFont)
        for (const child of Array.from(el.childNodes)) walk(child, nextFont)
      }
    }
  }
  for (const child of Array.from(textExtractor.childNodes)) walk(child, '')

  // Pad/trim to match innerText length in case of complex HTML edge cases
  while (fonts.length < text.length) fonts.push('')
  return { text, styles: fonts.slice(0, text.length) }
}

function diffText(prev: string, curr: string): { prefixLen: number; prevSuffix: number; currSuffix: number } {
  let prefixLen = 0
  while (prefixLen < prev.length && prefixLen < curr.length && prev[prefixLen] === curr[prefixLen]) {
    prefixLen++
  }
  let prevEnd = prev.length
  let currEnd = curr.length
  while (prevEnd > prefixLen && currEnd > prefixLen && prev[prevEnd - 1] === curr[currEnd - 1]) {
    prevEnd--
    currEnd--
  }
  return { prefixLen, prevSuffix: prevEnd, currSuffix: currEnd }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function openSpanFor(entry: CharEntry): string {
  // CSSOM normalizes 'Courier New' → "Courier New"; replace back to single quotes so
  // the value is safe inside a double-quoted HTML style attribute.
  const ff = entry.fontFamily?.replace(/"/g, "'") ?? ''
  const fontStyle = ff ? `font-family:${ff};` : ''
  if (entry.type === 'overwrite') {
    return `<span style="${fontStyle}color:${overwriteColor(entry.overwriteCount ?? 1)}">`
  }
  if (entry.type === 'pasted') {
    return `<span style="${fontStyle}color:#fef08a;border:1px solid #fef08a;border-radius:2px;padding:0 2px;box-decoration-break:clone;-webkit-box-decoration-break:clone">`
  }
  return `<span style="${fontStyle}">`
}

function renderHistory(history: CharEntry[]): string {
  let html = ''
  let openKey = ''

  for (const entry of history) {
    const key = styleKey(entry)
    if (key !== openKey) {
      if (openKey) html += '</span>'
      openKey = key
      if (key) html += openSpanFor(entry)
    }
    html += entry.char === '\n' ? '<br>' : escapeHtml(entry.char)
  }

  if (openKey) html += '</span>'
  return html
}

// ── Player ────────────────────────────────────────────────────────────────────

export class Player {
  private el: HTMLElement
  private options: PlaybackOptions
  private frames: Recording['frames'] = []
  private cursor = 0
  private timeoutId: ReturnType<typeof setTimeout> | null = null
  private playbackStartTime = 0
  private elapsedAtPause = 0
  private cumulativeDelays: number[] = []
  private progressCb: ((index: number, total: number) => void) | null = null
  private completeCb: (() => void) | null = null
  private statsCb: ((typed: number, pasted: number, overwrite: number) => void) | null = null
  private tabSwitchCb: ((toTabId: string, toTabName: string) => void) | null = null
  private history: CharEntry[] = []
  private prevActiveText = ''
  private pendingOverwrite = false
  private overwriteBalance = 0
  private pendingOverwriteMaxCount = 0
  private pasteGroupCounter = 0
  private tabHistories = new Map<string, { history: CharEntry[]; prevText: string }>()
  private currentTabId: string | null = null
  private reconstructedHtml = ''

  constructor(el: HTMLElement, options: PlaybackOptions) {
    this.el = el
    this.options = options
  }

  setOptions(options: Partial<PlaybackOptions>): void {
    this.options = { ...this.options, ...options }
  }

  private resetState(): void {
    this.cursor = 0
    this.elapsedAtPause = 0
    this.history = []
    this.prevActiveText = ''
    this.pendingOverwrite = false
    this.overwriteBalance = 0
    this.pendingOverwriteMaxCount = 0
    this.pasteGroupCounter = 0
    this.tabHistories = new Map()
    this.currentTabId = null
    this.reconstructedHtml = ''
  }

  load(recording: Recording, startTabId?: string): void {
    this.frames = recording.frames
    this.resetState()
    this.currentTabId = startTabId ?? null

    let acc = 0
    this.cumulativeDelays = this.frames.map((f) => {
      acc += Math.min(f.t, this.options.maxGapMs)
      return acc
    })
  }

  play(): void {
    this.playbackStartTime = Date.now() - this.elapsedAtPause
    this.scheduleNext()
  }

  pause(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
    this.elapsedAtPause = Date.now() - this.playbackStartTime
  }

  skipToEnd(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
    while (this.cursor < this.frames.length) {
      const frame = this.frames[this.cursor]
      this.reconstructedHtml = frameToHtml(frame, this.reconstructedHtml)
      if (frame.baseline) {
        this.applyBaseline(this.reconstructedHtml)
      } else {
        this.prevActiveText = this.applyFrame(this.reconstructedHtml).text
        if (frame.tabSwitch) {
          this.handleTabSwitch(frame.tabSwitch.toTabId, frame.tabSwitch.toTabName)
        }
      }
      this.cursor++
    }
    this.el.innerHTML = renderHistory(this.history)
    this.emitStats()
    this.progressCb?.(this.cursor, this.frames.length)
    this.completeCb?.()
  }

  stop(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
    this.resetState()
    this.el.innerHTML = ''
    this.statsCb?.(0, 0, 0)
    this.progressCb?.(0, this.frames.length)
  }

  onProgress(cb: (index: number, total: number) => void): void {
    this.progressCb = cb
  }

  onComplete(cb: () => void): void {
    this.completeCb = cb
  }

  onStats(cb: (typed: number, pasted: number, overwrite: number) => void): void {
    this.statsCb = cb
  }

  onTabSwitch(cb: (toTabId: string, toTabName: string) => void): void {
    this.tabSwitchCb = cb
  }

  private emitStats(): void {
    if (!this.statsCb) return
    let typed = 0, pasted = 0, overwrite = 0
    for (const e of this.history) {
      if (e.type === 'typed') typed++
      else if (e.type === 'pasted') pasted++
      else overwrite++
    }
    this.statsCb(typed, pasted, overwrite)
  }

  private applyBaseline(html: string): void {
    const { text, styles } = htmlToTextAndStyles(html)
    this.pendingOverwrite = false
    this.overwriteBalance = 0
    this.pendingOverwriteMaxCount = 0
    this.prevActiveText = text

    if (this.history.length === 0) {
      this.history = Array.from(text).map((char, i) => ({
        char, type: 'typed' as CharType, fontFamily: styles[i] || undefined,
      }))
      return
    }

    const currentText = this.history.map(e => e.char).join('')
    if (text === currentText) {
      for (let i = 0; i < this.history.length; i++) {
        this.history[i].fontFamily = styles[i] || undefined
      }
      return
    }

    // Reconcile baseline against history: preserve existing char types, add new chars as typed
    const { prefixLen, prevSuffix, currSuffix } = diffText(currentText, text)
    const deletedCount = prevSuffix - prefixLen
    const addedText = text.slice(prefixLen, currSuffix)
    if (deletedCount > 0) this.history.splice(prefixLen, deletedCount)
    if (addedText.length > 0) {
      const entries: CharEntry[] = Array.from(addedText).map((char, i) => ({
        char, type: 'typed' as CharType, fontFamily: styles[prefixLen + i] || undefined,
      }))
      this.history.splice(prefixLen, 0, ...entries)
    }
    for (let i = 0; i < this.history.length; i++) {
      this.history[i].fontFamily = styles[i] || undefined
    }
  }

  private handleTabSwitch(toTabId: string, toTabName: string): void {
    if (this.currentTabId !== null) {
      this.tabHistories.set(this.currentTabId, {
        history: this.history.map(e => ({ ...e })),
        prevText: this.prevActiveText,
      })
    }
    this.currentTabId = toTabId
    const saved = this.tabHistories.get(toTabId)
    if (saved) {
      this.history = saved.history.map(e => ({ ...e }))
      this.prevActiveText = saved.prevText
    }
    this.tabSwitchCb?.(toTabId, toTabName)
  }

  private applyFrame(currHtml: string): { text: string; fontsChanged: boolean } {
    const { text: currText, styles: currStyles } = htmlToTextAndStyles(currHtml)
    const { prefixLen, prevSuffix, currSuffix } = diffText(this.prevActiveText, currText)

    const deletedCount = prevSuffix - prefixLen
    const addedText = currText.slice(prefixLen, currSuffix)
    const deletedNonNl = this.prevActiveText.slice(prefixLen, prevSuffix).replace(/\n/g, '').length
    const addedNonNl = addedText.replace(/\n/g, '')

    // Capture overwrite counts from positions about to be removed
    let deletedMaxCount = 0
    for (let i = prefixLen; i < prefixLen + deletedCount && i < this.history.length; i++) {
      deletedMaxCount = Math.max(deletedMaxCount, this.history[i].overwriteCount ?? 0)
    }

    // Pure deletion: accumulate balance and remember the max overwrite depth
    if (deletedNonNl > 0 && addedNonNl.length === 0) {
      this.pendingOverwriteMaxCount = Math.max(this.pendingOverwriteMaxCount, deletedMaxCount)
      this.overwriteBalance += deletedNonNl
      this.pendingOverwrite = true
    }

    // select+type in one frame is always overwrite; pending balance covers backspace+type
    const directOverwrite = deletedNonNl > 0 && addedNonNl.length > 0
    const pendingOverwrite = this.pendingOverwrite && deletedNonNl === 0 && addedNonNl.length > 0
    const isOverwrite = directOverwrite || pendingOverwrite

    const addType: CharType = isOverwrite ? 'overwrite' : addedNonNl.length > 1 ? 'pasted' : 'typed'

    // Capture base count before spend-down can reset pendingOverwriteMaxCount
    const baseCount = directOverwrite ? deletedMaxCount : this.pendingOverwriteMaxCount

    // Spend down the balance as overwrite chars are inserted
    if (pendingOverwrite) {
      this.overwriteBalance = Math.max(0, this.overwriteBalance - addedNonNl.length)
      if (this.overwriteBalance === 0) {
        this.pendingOverwrite = false
        this.pendingOverwriteMaxCount = 0
      }
    }

    // Enter (newlines only) ends the overwrite context — paragraph break, not overwriting
    if (this.pendingOverwrite && addedText.length > 0 && addedNonNl.length === 0) {
      this.pendingOverwrite = false
      this.overwriteBalance = 0
      this.pendingOverwriteMaxCount = 0
    }

    // A paste with no deletion ends overwrite mode
    if (addedNonNl.length > 1 && !isOverwrite) {
      this.pendingOverwrite = false
      this.overwriteBalance = 0
      this.pendingOverwriteMaxCount = 0
    }

    if (deletedCount > 0) this.history.splice(prefixLen, deletedCount)

    if (addedText.length > 0) {
      const overwriteCount = isOverwrite ? baseCount + 1 : undefined
      const pasteGroup = addType === 'pasted' ? ++this.pasteGroupCounter : undefined
      const entries: CharEntry[] = Array.from(addedText).map((char) => ({
        char, type: addType, pasteGroup, overwriteCount,
      }))
      this.history.splice(prefixLen, 0, ...entries)
    }

    // Sync font-family for every char from current frame — handles style changes to existing text
    let fontsChanged = false
    for (let i = 0; i < this.history.length; i++) {
      const next = currStyles[i] || undefined
      if (this.history[i].fontFamily !== next) fontsChanged = true
      this.history[i].fontFamily = next
    }

    return { text: currText, fontsChanged }
  }

  private scheduleNext(): void {
    if (this.cursor >= this.frames.length) {
      this.completeCb?.()
      return
    }

    const expectedElapsed = this.cumulativeDelays[this.cursor] / this.options.speedMultiplier
    const actualElapsed = Date.now() - this.playbackStartTime
    const delay = Math.max(0, expectedElapsed - actualElapsed)

    this.timeoutId = setTimeout(() => {
      const frame = this.frames[this.cursor]
      this.reconstructedHtml = frameToHtml(frame, this.reconstructedHtml)
      if (frame.baseline) {
        this.applyBaseline(this.reconstructedHtml)
        this.el.innerHTML = renderHistory(this.history)
        this.emitStats()
      } else {
        const oldText = this.prevActiveText
        const { text: newText, fontsChanged } = this.applyFrame(this.reconstructedHtml)
        this.prevActiveText = newText
        if (newText !== oldText || fontsChanged) {
          this.el.innerHTML = renderHistory(this.history)
          this.emitStats()
        }
        if (frame.tabSwitch) {
          this.handleTabSwitch(frame.tabSwitch.toTabId, frame.tabSwitch.toTabName)
        }
      }
      this.cursor++
      this.progressCb?.(this.cursor, this.frames.length)
      this.scheduleNext()
    }, delay)
  }
}
