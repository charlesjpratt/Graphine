import { diffRange } from './frameCodec'

// ── App-owned undo ────────────────────────────────────────────────────────────
//
// Chromium's contenteditable undo stack is opaque: it can't be inspected, cleared,
// or classified, and it lives on the frame rather than the element — so it leaks
// across tab switches (which swap writeArea.innerHTML wholesale) and it silently
// skips edits made through Range APIs instead of execCommand. We keep our own.
//
// The stack is fed from the write area's own 'input' events, so it captures every
// mutation path — native typing, execCommand, and the manual Range edits in main.ts
// that dispatch a synthetic input event. Each entry is an invertible HTML delta:
// at position p, `inserted` replaced `removed`. Undo swaps them back, redo swaps
// them forward. Only the top entry is ever "open" for coalescing, so at most one
// full-document snapshot (openBase) is retained at a time.
//
// The native stack still accumulates underneath but is never reachable: main.ts
// routes Cmd/Ctrl+Z through the Edit menu into doUndo() instead.

const MAX_DEPTH = 200

// Keystrokes closer together than this coalesce into one undo step. Combined with the
// word-boundary rule below, Ctrl+Z steps back word-by-word rather than char-by-char.
const COALESCE_MS = 700

type EditKind = 'insert' | 'delete' | 'other'

interface UndoEntry {
  p: number         // common-prefix length, in HTML chars
  removed: string   // HTML that was there before, after the prefix
  inserted: string  // HTML that replaced it
  kind: EditKind
  endTime: number
  lastData: string  // last character inserted into this group, for the word-boundary rule
  // The HTML from before this group began, kept only while the group can still absorb
  // more edits. Coalescing re-derives the whole group's delta from it, so a merged group
  // stays a single p/removed/inserted triple. Nulled once the group closes.
  openBase: string | null
}

// Per-tab undo state, parked on TabRuntime across tab switches.
export interface UndoState {
  stack: UndoEntry[]
  index: number  // entries currently applied; undo pops stack[index - 1]
}

export function emptyUndoState(): UndoState {
  return { stack: [], index: 0 }
}

// ── Caret coordinates ─────────────────────────────────────────────────────────
//
// Undo restores the caret by character offset rather than by DOM node, since the
// nodes it pointed at are destroyed by the innerHTML swap. The coordinate space is
// one unit per text character plus one per <br>; block boundaries contribute nothing,
// which is fine as long as measuring and restoring agree — and they walk identically.

function caretText(root: Node): string {
  let out = ''
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) out += child.textContent ?? ''
    else if (child.nodeName === 'BR') out += '\n'
    else if (child.nodeType === Node.ELEMENT_NODE) out += caretText(child)
  }
  return out
}

// Caret position within root, or -1 when the selection is elsewhere (or unavailable,
// as under jsdom). Callers treat -1 as "unknown" and degrade rather than guess.
function caretOffset(root: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return -1
  const r = sel.getRangeAt(0)
  if (!root.contains(r.endContainer)) return -1
  const pre = document.createRange()
  pre.selectNodeContents(root)
  pre.setEnd(r.endContainer, r.endOffset)
  return caretText(pre.cloneContents()).length
}

function locate(node: Node, state: { remaining: number }): { node: Node; off: number } | null {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const len = child.textContent?.length ?? 0
      // <= so an offset landing exactly at a text node's end stays in that node rather
      // than skipping to the next one — the caret renders in the same place either way.
      if (state.remaining <= len) return { node: child, off: state.remaining }
      state.remaining -= len
    } else if (child.nodeName === 'BR') {
      if (state.remaining === 0) {
        const parent = child.parentNode as Node
        return { node: parent, off: Array.prototype.indexOf.call(parent.childNodes, child) }
      }
      state.remaining -= 1
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const hit = locate(child, state)
      if (hit) return hit
    }
  }
  return null
}

function setCaretAtOffset(root: HTMLElement, offset: number): void {
  const sel = window.getSelection()
  if (!sel) return
  const hit = locate(root, { remaining: Math.max(0, offset) })
  const range = document.createRange()
  if (hit) {
    range.setStart(hit.node, hit.off)
  } else {
    range.selectNodeContents(root)
  }
  range.collapse(hit ? true : false)
  sel.removeAllRanges()
  sel.addRange(range)
}

// ── Manager ───────────────────────────────────────────────────────────────────

const isSpace = (s: string): boolean => s.length > 0 && /\s/.test(s)

function kindOf(e: InputEvent): EditKind {
  const t = e.inputType
  // Only plain single-character typing and single-step deletes coalesce. Enter,
  // paste, drop, IME composition and formatting each get their own undo step.
  if (t === 'insertText' && typeof e.data === 'string' && e.data.length === 1 && e.data !== '\n') return 'insert'
  if (t === 'deleteContentBackward' || t === 'deleteContentForward') return 'delete'
  return 'other'
}

export class UndoManager {
  private el: HTMLElement
  private stack: UndoEntry[] = []
  private index = 0
  private baseHtml = ''
  private baseUnits = 0
  private caretEnd = -1

  constructor(el: HTMLElement) {
    this.el = el
    this.baseHtml = el.innerHTML
    this.baseUnits = caretText(el).length
    el.addEventListener('input', (e) => this.record(e as InputEvent))
  }

  get canUndo(): boolean {
    return this.index > 0
  }

  get canRedo(): boolean {
    return this.index < this.stack.length
  }

  // Re-anchor to the element's current content without pushing an entry. Used after
  // any programmatic innerHTML swap that isn't an edit (tab restore).
  sync(): void {
    this.baseHtml = this.el.innerHTML
    this.baseUnits = caretText(this.el).length
    this.caretEnd = caretOffset(this.el)
    this.closeGroup()
  }

  clear(): void {
    this.stack = []
    this.index = 0
    this.sync()
  }

  // The state object is handed over by reference; the caller parks it on the outgoing
  // tab and immediately installs another via setState, so there is no shared aliasing.
  getState(): UndoState {
    this.closeGroup()
    return { stack: this.stack, index: this.index }
  }

  setState(state: UndoState): void {
    this.stack = state.stack
    this.index = state.index
    this.sync()
  }

  private closeGroup(): void {
    if (this.index > 0) this.stack[this.index - 1].openBase = null
  }

  private record(e: InputEvent): void {
    const html = this.el.innerHTML
    // Our own undo/redo re-anchors baseHtml before dispatching its input event, so the
    // event it fires for the recorder lands here as a no-op instead of re-entering.
    if (html === this.baseHtml) return

    const before = this.baseHtml
    const beforeUnits = this.baseUnits
    const units = caretText(this.el).length
    const caret = caretOffset(this.el)
    this.baseHtml = html
    this.baseUnits = units

    const kind = kindOf(e)
    const data = e.data ?? ''
    const top = this.index > 0 ? this.stack[this.index - 1] : null

    if (top && top.openBase !== null && this.canCoalesce(top, kind, data, caret, units - beforeUnits)) {
      const { prefixLen, prevEnd, currEnd } = diffRange(top.openBase, html)
      top.p = prefixLen
      top.removed = top.openBase.slice(prefixLen, prevEnd)
      top.inserted = html.slice(prefixLen, currEnd)
      top.endTime = Date.now()
      top.lastData = data
      this.caretEnd = caret
      return
    }

    // A fresh edit closes the open group and discards the redo tail.
    this.closeGroup()
    this.stack.length = this.index

    const { prefixLen, prevEnd, currEnd } = diffRange(before, html)
    this.stack.push({
      p: prefixLen,
      removed: before.slice(prefixLen, prevEnd),
      inserted: html.slice(prefixLen, currEnd),
      kind,
      endTime: Date.now(),
      lastData: data,
      openBase: kind === 'other' ? null : before,
    })
    this.index = this.stack.length
    this.caretEnd = caret

    if (this.stack.length > MAX_DEPTH) {
      this.stack.shift()
      this.index--
    }
  }

  private canCoalesce(top: UndoEntry, kind: EditKind, data: string, caret: number, unitDelta: number): boolean {
    if (kind === 'other' || kind !== top.kind) return false
    if (Date.now() - top.endTime > COALESCE_MS) return false
    // Start a new step at the start of a word, so undo peels off whole words.
    if (kind === 'insert' && isSpace(top.lastData) && !isSpace(data)) return false
    // The caret must have continued from where the group left off: an insert advances it
    // by the units added, a backspace retreats by the units removed, a forward-delete
    // leaves it put. Any other position means the user moved and this is a new edit.
    // caret/caretEnd are -1 when the selection can't be read; skip the check then.
    if (caret >= 0 && this.caretEnd >= 0) {
      const advanced = caret === this.caretEnd + unitDelta
      const stationary = kind === 'delete' && caret === this.caretEnd
      if (!advanced && !stationary) return false
    }
    return true
  }

  undo(): boolean {
    if (!this.canUndo) return false
    const entry = this.stack[this.index - 1]
    const html = this.el.innerHTML
    if (html.slice(entry.p, entry.p + entry.inserted.length) !== entry.inserted) {
      // The document moved under us (an out-of-band mutation that fired no input event),
      // so the recorded offsets no longer describe it. Drop the stack rather than apply
      // a delta at the wrong place.
      this.clear()
      return false
    }
    this.closeGroup()
    this.apply(html.slice(0, entry.p) + entry.removed + html.slice(entry.p + entry.inserted.length))
    this.index--
    return true
  }

  redo(): boolean {
    if (!this.canRedo) return false
    const entry = this.stack[this.index]
    const html = this.el.innerHTML
    if (html.slice(entry.p, entry.p + entry.removed.length) !== entry.removed) {
      this.clear()
      return false
    }
    this.apply(html.slice(0, entry.p) + entry.inserted + html.slice(entry.p + entry.removed.length))
    this.index++
    return true
  }

  // Swap in the new content and put the caret at the end of whatever changed, then
  // re-anchor. baseHtml is re-read rather than assumed: the parser may normalize the
  // string we assigned, and every later delta is measured against what it actually holds.
  private apply(html: string): void {
    const before = caretText(this.el)
    this.el.innerHTML = html
    const after = caretText(this.el)
    this.baseHtml = this.el.innerHTML
    this.baseUnits = after.length

    this.el.focus()
    if (before === after) {
      // A formatting-only step: nothing moved, so leave the caret where it was.
      setCaretAtOffset(this.el, Math.min(Math.max(this.caretEnd, 0), after.length))
    } else {
      setCaretAtOffset(this.el, diffRange(before, after).currEnd)
    }
    this.caretEnd = caretOffset(this.el)
  }
}
