import type { Recording, PlaybackOptions, EditIntent } from './types'
import { frameToHtml, diffRange } from './frameCodec'

// ── Char history ──────────────────────────────────────────────────────────────

type CharType = 'typed' | 'pasted' | 'overwrite'

export interface CharEntry {
  char: string  // single char; '\n' renders as <br>
  type: CharType
  pasteGroup?: number
  overwriteCount?: number  // 1 = first overwrite, capped display at 4
  fontFamily?: string
  textAlign?: string  // block alignment inherited from the enclosing paragraph/div
  bold?: boolean      // inside <b>/<strong> or font-weight:bold
  italic?: boolean    // inside <i>/<em> or font-style:italic
  highlight?: boolean // marked with the toolbar highlighter
}

// pink → red over 4 steps
export const OVERWRITE_COLORS = ['#fda4af', '#fb7185', '#f87171', '#ef4444']

// The highlighter's marker teal, and the text colour it pairs with where the text has no
// provenance colour of its own. Lives here with the rest of the palette; the write-view
// toolbar imports it so a document and its replay mark up in the same teal.
export const HIGHLIGHT_BG = '#5eead4'
export const HIGHLIGHT_FG = '#000'

// Size fallback used ONLY on legacy frames that carry no recorded edit intent. There, a
// deletion bigger than this many chars in a single frame — or an accumulated backspace run
// past it — is guessed to be a block edit (a cut for a move, a drag-move) rather than a
// backspace-and-retype correction, so overwrite mode is not armed and the following text is
// not mis-coloured red. Sized to still cover deleting a few words. When the frame does carry
// an intent we know which it was, and the size no longer matters: deleting a whole paragraph
// and writing over it counts as an overwrite.
const BLOCK_DELETE_THRESHOLD = 24

// How many recent removals to keep provenance for, so an undo can hand it back. Deep enough
// to cover a long backspace run (one entry per char) plus the block deletes around it.
const MAX_REMOVALS = 64

function overwriteColor(count: number): string {
  return OVERWRITE_COLORS[Math.min(count, OVERWRITE_COLORS.length) - 1]
}

// key used to decide when to open/close a <span>
function styleKey(entry: CharEntry): string {
  const f = entry.fontFamily ? `:f:${entry.fontFamily}` : ''
  const b = entry.bold ? ':b' : ''
  const i = entry.italic ? ':i' : ''
  const h = entry.highlight ? ':h' : ''
  const s = `${f}${b}${i}${h}`
  if (entry.type === 'typed') return s ? `t${s}` : ''
  if (entry.type === 'overwrite') {
    // pasteGroup keeps a pasted-overwrite run boxed as one unit, separate from adjacent
    // typed-overwrite chars at the same depth.
    const pg = entry.pasteGroup != null ? `:pg:${entry.pasteGroup}` : ''
    return `ow:${Math.min(entry.overwriteCount ?? 1, 4)}${pg}${s}`
  }
  return `paste:${entry.pasteGroup}${s}`
}

// Persistent off-screen element used to parse recorded HTML into a DOM to walk.
let textExtractor: HTMLDivElement | null = null

interface CharStyle { font: string; align: string; bold: boolean; italic: boolean; highlight: boolean }

// Parse recorded HTML into the character sequence and per-character style that the replay
// reconstructs from. We do NOT use innerText: it counts an empty <div><br></div> blank line
// as two line breaks (block boundary + filler <br>) though it renders as a single blank
// line, which replays as a doubled paragraph gap. Instead a single DOM walk emits the text
// and its styles together — always in sync — with exactly one '\n' per on-screen line break.
//
// Owed breaks are realized just before the next character, in two kinds:
//   soft — a block (div/p) boundary: at most one (max-dedup so touching blocks separate by a
//          single line) and dropped if nothing follows (a trailing boundary is not a row).
//   hard — a <br>, a literal '\n', or a blank-line block's empty row: additive, and kept even
//          when trailing (a real blank line at the end still shows).
function htmlToTextAndStyles(html: string): { text: string; styles: CharStyle[] } {
  if (!textExtractor) {
    textExtractor = document.createElement('div')
    textExtractor.style.cssText = 'position:fixed;opacity:0;white-space:pre-wrap;pointer-events:none;top:-9999px;left:-9999px'
    document.body.appendChild(textExtractor)
  }
  // Strip a trailing <br> (Chrome's cursor placeholder) from the end of the HTML, then any
  // <br> that is the true last node of a block element — also a placeholder, not a real line.
  textExtractor.innerHTML = html.replace(/<br\s*\/?>\s*$/i, '')
  const removeCursorBr = (el: Element): void => {
    for (const child of Array.from(el.children)) removeCursorBr(child)
    const last = el.lastChild
    if (last?.nodeName === 'BR' && el.childNodes.length > 1) (last as Element).remove()
  }
  removeCursorBr(textExtractor)

  const base: CharStyle = { font: '', align: '', bold: false, italic: false, highlight: false }
  const chars: string[] = []
  const styles: CharStyle[] = []
  let emitted = false
  let pendingSoft = 0
  let pendingHard = 0
  let breakStyle = base
  const flush = (atEnd: boolean): void => {
    const n = (atEnd ? 0 : pendingSoft) + pendingHard
    for (let i = 0; i < n; i++) { chars.push('\n'); styles.push(breakStyle) }
    pendingSoft = 0; pendingHard = 0
  }
  const addChar = (ch: string, s: CharStyle): void => {
    if (ch === '\n') { pendingHard++; breakStyle = s; return }
    flush(false)
    chars.push(ch); styles.push(s); emitted = true
  }
  const softBreak = (s: CharStyle): void => { if (!emitted) return; pendingSoft = 1; breakStyle = s }
  const hardBreak = (s: CharStyle): void => { pendingHard++; breakStyle = s }

  function walk(node: Node, s: CharStyle): void {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const ch of node.textContent ?? '') addChar(ch, s)
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      const tag = el.tagName.toUpperCase()
      const nextFont = el.style.fontFamily || s.font
      // execCommand emits text-align via inline style (styleWithCSS) or the legacy align
      // attribute; accept either. 'start' is the initial value, i.e. no explicit alignment.
      const rawAlign = el.style.textAlign || el.getAttribute('align') || ''
      const nextAlign = rawAlign && rawAlign !== 'start' ? rawAlign : s.align
      // Bold/italic come from <b>/<strong>/<i>/<em> tags (styleWithCSS off, the default) or
      // the equivalent inline styles (styleWithCSS on); once set they inherit to children.
      const fw = el.style.fontWeight
      const nextBold = s.bold || tag === 'B' || tag === 'STRONG' || fw === 'bold' || fw === 'bolder' || parseInt(fw, 10) >= 600
      const fs = el.style.fontStyle
      const nextItalic = s.italic || tag === 'I' || tag === 'EM' || fs === 'italic' || fs === 'oblique'
      // The highlighter is the only thing that paints a background in the write area, so any
      // background colour here is a highlight — and like bold/italic it inherits to children.
      const bg = el.style.backgroundColor
      const nextHighlight = s.highlight || (!!bg && bg !== 'transparent')
      const next: CharStyle = {
        font: nextFont, align: nextAlign, bold: nextBold, italic: nextItalic, highlight: nextHighlight,
      }
      if (tag === 'BR') {
        hardBreak(s)
      } else if (tag === 'DIV' || tag === 'P') {
        // A block with no text is a blank line (may hold a filler <br> or inline wrappers):
        // its boundary is soft, plus one hard break for the empty row it occupies.
        if (el.textContent === '') {
          softBreak(next); hardBreak(next)
        } else {
          softBreak(next)
          for (const child of Array.from(el.childNodes)) walk(child, next)
          softBreak(next)  // separate from any following inline content
        }
      } else {
        for (const child of Array.from(el.childNodes)) walk(child, next)
      }
    }
  }
  for (const child of Array.from(textExtractor.childNodes)) walk(child, base)
  flush(true)
  return { text: chars.join(''), styles }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// The style fields of a CharEntry, normalized from a CharStyle (empty/false → undefined so
// entries stay minimal and equality checks are simple).
function styleFields(
  s: CharStyle | undefined,
): Pick<CharEntry, 'fontFamily' | 'textAlign' | 'bold' | 'italic' | 'highlight'> {
  return {
    fontFamily: s?.font || undefined,
    textAlign: s?.align || undefined,
    bold: s?.bold || undefined,
    italic: s?.italic || undefined,
    highlight: s?.highlight || undefined,
  }
}

// On-screen pasted text is light yellow (reads well on the dark replay area). The PDF
// export overrides this with a darker yellow for readability on white — see renderHistory.
export const SCREEN_PASTE_COLOR = '#fef08a'

// The colored outline that marks pasted text; shared by plain pastes and pasted overwrites.
function pasteBox(color: string): string {
  return `border:1px solid ${color};border-radius:2px;padding:0 2px;box-decoration-break:clone;-webkit-box-decoration-break:clone`
}

function openSpanFor(entry: CharEntry, pasteColor: string): string {
  // CSSOM normalizes 'Courier New' → "Courier New"; replace back to single quotes so
  // the value is safe inside a double-quoted HTML style attribute.
  const ff = entry.fontFamily?.replace(/"/g, "'") ?? ''
  let css = ff ? `font-family:${ff};` : ''
  if (entry.bold) css += 'font-weight:bold;'
  if (entry.italic) css += 'font-style:italic;'
  // A highlight repaints the background only, leaving provenance to own the foreground:
  // highlighted overwrite keeps its pink→red text, highlighted paste its yellow text and
  // box. Both then read as marked text without losing where the text came from.
  if (entry.highlight) css += `background-color:${HIGHLIGHT_BG};`
  if (entry.type === 'overwrite') {
    // Overwrite is red; if it also came from a paste, add the yellow box around it.
    const box = entry.pasteGroup != null ? `;${pasteBox(pasteColor)}` : ''
    return `<span style="${css}color:${overwriteColor(entry.overwriteCount ?? 1)}${box}">`
  }
  if (entry.type === 'pasted') {
    return `<span style="${css}color:${pasteColor};${pasteBox(pasteColor)}">`
  }
  // Typed text has no provenance colour, so highlighted it takes the same black the write
  // view gives it — the replay area's own light-on-dark text would vanish against teal.
  return `<span style="${css}${entry.highlight ? `color:${HIGHLIGHT_FG};` : ''}">`
}

// Renders a run of chars as one continuous inline stream: '\n' → <br>, with color/font
// spans opened and closed by styleKey. This is the whole document when nothing is aligned.
function renderInlineStream(history: CharEntry[], pasteColor: string): string {
  let html = ''
  let openKey = ''

  for (const entry of history) {
    const key = styleKey(entry)
    if (key !== openKey) {
      if (openKey) html += '</span>'
      openKey = key
      if (key) html += openSpanFor(entry, pasteColor)
    }
    html += entry.char === '\n' ? '<br>' : escapeHtml(entry.char)
  }

  if (openKey) html += '</span>'
  return html
}

// pasteColor lets callers (the PDF export) substitute a darker, print-readable yellow
// while live replay uses the default light yellow.
export function renderHistory(history: CharEntry[], pasteColor: string = SCREEN_PASTE_COLOR): string {
  // Fast path: no alignment anywhere → the original flat inline rendering, unchanged.
  if (!history.some((e) => e.textAlign)) {
    return renderInlineStream(history, pasteColor)
  }

  // Alignment-aware path. text-align only takes effect on a block element, so split the
  // history into lines (at '\n') and wrap each aligned line in a <div> carrying its
  // text-align. A line's alignment comes from its content; the block <div> supplies its
  // own line break, so the terminating '\n' is absorbed rather than rendered as <br>.
  type Line = { entries: CharEntry[]; align: string; terminated: boolean }
  const lines: Line[] = []
  let cur: CharEntry[] = []
  for (const e of history) {
    if (e.char === '\n') {
      lines.push({ entries: cur, align: cur[0]?.textAlign || e.textAlign || '', terminated: true })
      cur = []
    } else {
      cur.push(e)
    }
  }
  lines.push({ entries: cur, align: cur[0]?.textAlign || '', terminated: false })

  let html = ''
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]
    const content = renderInlineStream(line.entries, pasteColor)
    if (line.align) {
      html += `<div style="text-align:${line.align}">${content || '<br>'}</div>`
    } else {
      html += content
      // Emit the break for this line's terminating '\n' — unless the next line is a
      // block <div>, which already breaks the flow (avoids a doubled blank line).
      if (line.terminated) {
        const nextIsBlock = k + 1 < lines.length && !!lines[k + 1].align
        if (!nextIsBlock) html += '<br>'
      }
    }
  }
  return html
}

// ── Player ────────────────────────────────────────────────────────────────────

export class Player {
  private el: HTMLElement
  private options: PlaybackOptions
  private frames: Recording['frames'] = []
  private cursor = 0
  private timeoutId: ReturnType<typeof setTimeout> | null = null
  // Playback position is tracked in the recording's own timeline, not wall-clock: elapsedMs
  // is the recorded time consumed before the current playing stretch began, and
  // playbackStartTime anchors that stretch. Keeping it unscaled is what lets the speed
  // change mid-playback — wall-clock elapsed would have to be re-read through the new
  // multiplier, which stalls (slower) or bursts (faster) on resume.
  private playbackStartTime = 0
  private elapsedMs = 0
  private playing = false
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
  // Provenance of the most recent structural removal (cut / drag-out), so a later internal
  // paste or drop landing can restore the moved text's original color instead of minting it.
  private pendingRemovedRun: { text: string; entries: CharEntry[] } | null = null
  // Every recent removal, newest first, with the provenance it carried. An undo that puts
  // characters back looks up its own removal here so the restored text keeps the colour it
  // had — without this a >1-char re-insertion reads as a paste and replays yellow.
  private removals: { text: string; entries: CharEntry[] }[] = []
  private tabHistories = new Map<string, { history: CharEntry[]; prevText: string }>()
  private currentTabId: string | null = null
  private reconstructedHtml = ''

  constructor(el: HTMLElement, options: PlaybackOptions) {
    this.el = el
    this.options = options
  }

  setOptions(options: Partial<PlaybackOptions>): void {
    const speedChanged =
      options.speedMultiplier != null && options.speedMultiplier !== this.options.speedMultiplier
    const gapChanged =
      options.maxGapMs != null && options.maxGapMs !== this.options.maxGapMs

    // Bank the time already played at the old rate before the new one takes effect, then
    // re-anchor. Also re-time the frame already in flight so the change is felt immediately
    // rather than after the pending delay.
    if ((speedChanged || gapChanged) && this.playing) {
      this.elapsedMs = this.recordedElapsed()
      this.playbackStartTime = Date.now()
    }
    this.options = { ...this.options, ...options }

    // A new clamp rewrites the recorded timeline itself, so the banked elapsedMs — measured
    // in clamped ms — no longer means anything. Re-anchor to the boundary of the frame that
    // is next to play: position in the document is what the viewer is holding onto, not a
    // millisecond offset. Any part of the current gap already waited out is forgiven.
    if (gapChanged) {
      this.computeDelays()
      this.elapsedMs = this.cursor > 0 ? this.cumulativeDelays[this.cursor - 1] : 0
    }

    if ((speedChanged || gapChanged) && this.playing) {
      this.clearTimer()
      this.scheduleNext()
    }
  }

  // Position in the recording's timeline right now, in recorded ms.
  private recordedElapsed(): number {
    if (!this.playing) return this.elapsedMs
    return this.elapsedMs + (Date.now() - this.playbackStartTime) * this.options.speedMultiplier
  }

  private clearTimer(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
  }

  // Snapshot of the current end-of-replay char history. Used by the PDF export to
  // reproduce the exact colored state after a load()+skipToEnd() on a throwaway Player.
  getHistory(): CharEntry[] {
    return this.history.map((e) => ({ ...e }))
  }

  // Per-tab variant: the given tab's end-of-replay history, or [] if the tab never
  // appeared in the recording. Used by the tab-scoped PDF export.
  getHistoryForTab(tabId: string): CharEntry[] {
    if (tabId === this.currentTabId) return this.getHistory()
    const saved = this.tabHistories.get(tabId)
    return saved ? saved.history.map((e) => ({ ...e })) : []
  }

  private resetState(): void {
    this.cursor = 0
    this.elapsedMs = 0
    this.playing = false
    this.history = []
    this.prevActiveText = ''
    this.pendingOverwrite = false
    this.overwriteBalance = 0
    this.pendingOverwriteMaxCount = 0
    this.pasteGroupCounter = 0
    this.pendingRemovedRun = null
    this.removals = []
    this.tabHistories = new Map()
    this.currentTabId = null
    this.reconstructedHtml = ''
  }

  load(recording: Recording, startTabId?: string): void {
    this.frames = recording.frames
    this.resetState()
    this.currentTabId = startTabId ?? null
    this.computeDelays()
  }

  // The playback timeline: real recorded gaps with each one capped at maxGapMs, so long
  // pauses for thought don't replay as dead air. An infinite cap means true real time.
  private computeDelays(): void {
    let acc = 0
    this.cumulativeDelays = this.frames.map((f) => {
      acc += Math.min(f.t, this.options.maxGapMs)
      return acc
    })
  }

  play(): void {
    this.clearTimer()
    this.elapsedMs = this.recordedElapsed()
    this.playing = true
    this.playbackStartTime = Date.now()
    this.scheduleNext()
  }

  pause(): void {
    this.clearTimer()
    this.elapsedMs = this.recordedElapsed()
    this.playing = false
  }

  skipToEnd(): void {
    this.clearTimer()
    this.playing = false
    while (this.cursor < this.frames.length) {
      const frame = this.frames[this.cursor]
      this.reconstructedHtml = frameToHtml(frame, this.reconstructedHtml)
      if (frame.baseline) {
        this.applyBaseline(this.reconstructedHtml)
      } else {
        this.prevActiveText = this.applyFrame(this.reconstructedHtml, frame.intent).text
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
    this.clearTimer()
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
        char, type: 'typed' as CharType, ...styleFields(styles[i]),
      }))
      return
    }

    const currentText = this.history.map(e => e.char).join('')
    if (text === currentText) {
      for (let i = 0; i < this.history.length; i++) {
        Object.assign(this.history[i], styleFields(styles[i]))
      }
      return
    }

    // Reconcile baseline against history: preserve existing char types, add new chars as typed
    const { prefixLen, prevEnd, currEnd } = diffRange(currentText, text)
    const deletedCount = prevEnd - prefixLen
    const addedText = text.slice(prefixLen, currEnd)
    if (deletedCount > 0) this.history.splice(prefixLen, deletedCount)
    if (addedText.length > 0) {
      const entries: CharEntry[] = Array.from(addedText).map((char, i) => ({
        char, type: 'typed' as CharType, ...styleFields(styles[prefixLen + i]),
      }))
      this.history.splice(prefixLen, 0, ...entries)
    }
    for (let i = 0; i < this.history.length; i++) {
      Object.assign(this.history[i], styleFields(styles[i]))
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

  private applyFrame(currHtml: string, intent?: EditIntent): { text: string; stylesChanged: boolean } {
    const { text: currText, styles: currStyles } = htmlToTextAndStyles(currHtml)
    const { prefixLen, prevEnd, currEnd } = diffRange(this.prevActiveText, currText)

    const deletedCount = prevEnd - prefixLen
    const addedText = currText.slice(prefixLen, currEnd)
    const deletedNonNl = this.prevActiveText.slice(prefixLen, prevEnd).replace(/\n/g, '').length
    const addedNonNl = addedText.replace(/\n/g, '')

    // Capture overwrite counts from positions about to be removed
    let deletedMaxCount = 0
    for (let i = prefixLen; i < prefixLen + deletedCount && i < this.history.length; i++) {
      deletedMaxCount = Math.max(deletedMaxCount, this.history[i].overwriteCount ?? 0)
    }

    // Remember a structural removal (cut / drag-out) with its provenance, so if the same text
    // is pasted or dropped back into the doc as an internal move it keeps its original color.
    if (intent === 'deleteCut' && deletedCount > 0 && addedText.length === 0) {
      const removed = this.history.slice(prefixLen, prefixLen + deletedCount)
      this.pendingRemovedRun = { text: removed.map((e) => e.char).join(''), entries: removed.map((e) => ({ ...e })) }
    }

    // Internal copy/paste or drag-move: the inserted text is a duplicate or relocation of
    // content already in this doc, so it inherits that source's provenance — plain if the
    // source was typed, yellow if the source was itself pasted from outside — rather than
    // being classified anew. Tagged 'internal' at capture time (main.ts / recorder.ts).
    if (intent === 'internal' && addedText.length > 0) {
      // Relocated/duplicated content is never a correction: end any overwrite context.
      this.pendingOverwrite = false
      this.overwriteBalance = 0
      this.pendingOverwriteMaxCount = 0

      const source = this.findInternalSource(addedText)
      const newPasteGroup = ++this.pasteGroupCounter
      const entries: CharEntry[] = Array.from(addedText).map((char, i) => {
        const s = source?.[i]
        // Treat pasted source chars — and pasted-overwrite chars (yellow-boxed) — as pasted.
        const inheritPasted = !!s && (s.type === 'pasted' || (s.type === 'overwrite' && s.pasteGroup != null))
        return inheritPasted
          ? { char, type: 'pasted' as CharType, pasteGroup: newPasteGroup }
          : { char, type: 'typed' as CharType }
      })

      if (deletedCount > 0) this.removeFromHistory(prefixLen, deletedCount)
      this.history.splice(prefixLen, 0, ...entries)
      if (this.pendingRemovedRun?.text === addedText) this.pendingRemovedRun = null

      return { text: currText, stylesChanged: this.syncStyles(currStyles) }
    }

    // Undo/redo restores an earlier state rather than authoring or discarding content.
    // Characters coming back get the exact provenance they carried when they left; the
    // characters an undo removes are a structural removal, never a typo correction, so
    // overwrite mode is cleared instead of armed for whatever is typed next.
    if (intent === 'historyUndo' || intent === 'historyRedo') {
      this.pendingOverwrite = false
      this.overwriteBalance = 0
      this.pendingOverwriteMaxCount = 0

      if (deletedCount > 0) this.removeFromHistory(prefixLen, deletedCount)
      if (addedText.length > 0) {
        const restored = this.takeRemoval(addedText)
        // No matching removal (it aged out of the ring, or the recording starts mid-history):
        // fall back to plain typed rather than letting the size heuristic call it a paste.
        const entries: CharEntry[] = restored
          ? restored.map((e) => ({ ...e }))
          : Array.from(addedText).map((char) => ({ char, type: 'typed' as CharType }))
        this.history.splice(prefixLen, 0, ...entries)
      }

      return { text: currText, stylesChanged: this.syncStyles(currStyles) }
    }

    // Recorded edit intent (when present) tells us for certain what the size heuristic can
    // only guess: whether a removal was a backspace/select-delete correction or a structural
    // cut/drag-out, and whether an insertion is a drag-move landing. Legacy frames carry no
    // intent, leaving these flags false so classification stays exactly as before.
    const structuralDelete = intent === 'deleteCut'
    const isDropInsert = intent === 'drop'
    // An insert that also removed text in the same frame — select a run, then type or paste
    // over it. Known from intent, this is a replacement at any size.
    const replaceInsert = intent === 'type' || intent === 'paste' || intent === 'replace'

    // Without an intent to go on, a block-scale deletion in this single frame is guessed to be
    // a structural edit rather than a char-level overwrite (see BLOCK_DELETE_THRESHOLD).
    const blockScaleDelete = deletedNonNl > BLOCK_DELETE_THRESHOLD && !replaceInsert

    // Pure deletion: a backspace-style removal accumulates balance and remembers the max
    // overwrite depth so the text that follows replays red. This covers a whole selected
    // paragraph deleted with Backspace/Delete just as it covers a single mistyped char — both
    // arrive as deleteEdit, and rewriting over either is overwriting. A structural removal (a
    // cut or drag-out, known from intent) is NOT: clear overwrite mode so text typed or pasted
    // afterwards replays plain. With no intent recorded, fall back to the size guess.
    if (deletedNonNl > 0 && addedNonNl.length === 0) {
      const pastThreshold = !intent && this.overwriteBalance + deletedNonNl > BLOCK_DELETE_THRESHOLD
      if (structuralDelete || pastThreshold) {
        this.pendingOverwrite = false
        this.overwriteBalance = 0
        this.pendingOverwriteMaxCount = 0
      } else {
        this.pendingOverwriteMaxCount = Math.max(this.pendingOverwriteMaxCount, deletedMaxCount)
        this.overwriteBalance += deletedNonNl
        this.pendingOverwrite = true
      }
    }

    // select+type in one frame is always overwrite; pending balance covers backspace+type.
    // A block-scale replacement, or a drag-move landing (known from intent), is excluded so
    // the relocated text isn't painted red.
    const directOverwrite = deletedNonNl > 0 && addedNonNl.length > 0 && !blockScaleDelete && !isDropInsert
    const pendingOverwrite = this.pendingOverwrite && deletedNonNl === 0 && addedNonNl.length > 0 && !isDropInsert
    const isOverwrite = directOverwrite || pendingOverwrite

    // A bulk insert (>1 non-newline char in one frame) is a paste. It stays an
    // 'overwrite' when it also deleted text — but we still tag the paste so it gets the
    // yellow box, signalling "an overwrite that was pasted".
    //
    // Provenance comes from recorded intent when present: an external paste is 'paste' (yellow);
    // ordinary typing is 'type' (plain, even when a keystroke batches >1 char). Internal
    // copy/paste and drag-moves ('internal') are handled above. Legacy frames and other intents
    // (drop-from-outside, replace) fall back to the size heuristic, unchanged.
    const wasPasted =
      intent === 'paste' ? true
      : intent === 'type' ? false
      : addedNonNl.length > 1
    const addType: CharType = isOverwrite ? 'overwrite' : wasPasted ? 'pasted' : 'typed'

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

    // Enter (newlines only, nothing removed) ends the overwrite context — a paragraph break,
    // not overwriting. Requires a pure insertion: emptying a paragraph leaves a <br> behind, so
    // the delete frame reads as "removed 65 chars, added a newline" — that is the deletion we
    // just armed on, not a break.
    if (this.pendingOverwrite && deletedNonNl === 0 && addedText.length > 0 && addedNonNl.length === 0) {
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

    if (deletedCount > 0) this.removeFromHistory(prefixLen, deletedCount)

    if (addedText.length > 0) {
      const overwriteCount = isOverwrite ? baseCount + 1 : undefined
      const pasteGroup = wasPasted ? ++this.pasteGroupCounter : undefined
      const entries: CharEntry[] = Array.from(addedText).map((char) => ({
        char, type: addType, pasteGroup, overwriteCount,
      }))
      this.history.splice(prefixLen, 0, ...entries)
    }

    return { text: currText, stylesChanged: this.syncStyles(currStyles) }
  }

  // Splice characters out of the replayed history, remembering them and their provenance so a
  // later undo can hand exactly those characters back. Every removal passes through here.
  private removeFromHistory(at: number, count: number): void {
    const removed = this.history.splice(at, count)
    if (removed.length === 0) return
    this.removals.unshift({
      text: removed.map((e) => e.char).join(''),
      entries: removed.map((e) => ({ ...e })),
    })
    if (this.removals.length > MAX_REMOVALS) this.removals.length = MAX_REMOVALS
  }

  // Find and consume the removal that produced `text`. Either one recorded removal (a block
  // delete, or a previous undo step), or a run of consecutive single-char removals: backspace
  // deletes right-to-left, so walking the ring newest-first reassembles the original order.
  private takeRemoval(text: string): CharEntry[] | null {
    for (let i = 0; i < this.removals.length; i++) {
      if (this.removals[i].text === text) return this.removals.splice(i, 1)[0].entries
    }
    let assembled = ''
    const parts: CharEntry[][] = []
    for (let i = 0; i < this.removals.length; i++) {
      assembled += this.removals[i].text
      parts.push(this.removals[i].entries)
      if (assembled === text) {
        this.removals.splice(0, i + 1)
        return parts.reduce<CharEntry[]>((all, p) => all.concat(p), [])
      }
      if (assembled.length >= text.length) break
    }
    return null
  }

  // Locate the provenance source for an internal insertion: an identical run still present in
  // the doc (a copy/paste), or the run just removed by a cut/drag-out (a move). Returns the
  // source char entries aligned to addedText, or null when no match is found (treat as typed).
  private findInternalSource(addedText: string): CharEntry[] | null {
    const histText = this.history.map((e) => e.char).join('')
    const idx = histText.indexOf(addedText)
    if (idx >= 0) return this.history.slice(idx, idx + addedText.length)
    if (this.pendingRemovedRun?.text === addedText) return this.pendingRemovedRun.entries
    return null
  }

  // Sync font-family, alignment, bold/italic and highlight for every char from the frame —
  // handles styling toggled on text that already exists in the history. Returns whether any
  // char's style changed.
  private syncStyles(currStyles: CharStyle[]): boolean {
    let stylesChanged = false
    for (let i = 0; i < this.history.length; i++) {
      const e = this.history[i]
      const s = styleFields(currStyles[i])
      if (e.fontFamily !== s.fontFamily || e.textAlign !== s.textAlign || e.bold !== s.bold
          || e.italic !== s.italic || e.highlight !== s.highlight) {
        stylesChanged = true
      }
      Object.assign(e, s)
    }
    return stylesChanged
  }

  private scheduleNext(): void {
    if (this.cursor >= this.frames.length) {
      this.playing = false
      this.completeCb?.()
      return
    }

    // Remaining recorded time until this frame is due, converted to wall-clock by the speed.
    const remaining = this.cumulativeDelays[this.cursor] - this.recordedElapsed()
    const delay = Math.max(0, remaining / this.options.speedMultiplier)

    this.timeoutId = setTimeout(() => {
      const frame = this.frames[this.cursor]
      this.reconstructedHtml = frameToHtml(frame, this.reconstructedHtml)
      if (frame.baseline) {
        this.applyBaseline(this.reconstructedHtml)
        this.el.innerHTML = renderHistory(this.history)
        this.emitStats()
      } else {
        const oldText = this.prevActiveText
        const { text: newText, stylesChanged } = this.applyFrame(this.reconstructedHtml, frame.intent)
        this.prevActiveText = newText
        if (newText !== oldText || stylesChanged) {
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
