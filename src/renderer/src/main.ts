import { Recorder } from './recorder'
import { Player } from './player'
import { buildExportHtml } from './pdfExport'
import { switchView, applyState, updateProgress, showToast, setupInactivityHiding, updateStats, setDocTitle } from './ui'
import { AppState } from './types'
import type { Recording, Tab, TabRuntime, GraphineDocument } from './types'
import { createTab, renderTabBar, startRename } from './tabs'
import { setupMinimap } from './minimap'
import { UndoManager, emptyUndoState } from './undo'
import { basename, buildDefaultName, mergeRecording, wrapV1AsDocument } from './document'
import { titleFromText } from './frameCodec'

const writeArea = document.getElementById('write-area') as HTMLDivElement
const writeScroll = document.getElementById('write-scroll') as HTMLDivElement
const minimapCanvas = document.getElementById('minimap') as HTMLCanvasElement
const minimapWrap = document.getElementById('minimap-wrap') as HTMLDivElement
const btnMinimapToggle = document.getElementById('btn-minimap-toggle') as HTMLButtonElement
const replayArea = document.getElementById('replay-area') as HTMLDivElement
const btnStopSave = document.getElementById('btn-stop-save') as HTMLButtonElement
const btnNew = document.getElementById('btn-new') as HTMLButtonElement
const tabWrite = document.getElementById('tab-write') as HTMLButtonElement
const tabReplay = document.getElementById('tab-replay') as HTMLButtonElement
const btnOpenHeader = document.getElementById('btn-open-header') as HTMLButtonElement
const btnPlayPause = document.getElementById('btn-play-pause') as HTMLButtonElement
const btnStopPlayback = document.getElementById('btn-stop-playback') as HTMLButtonElement
const btnSkipEnd = document.getElementById('btn-skip-end') as HTMLButtonElement
const speedBtns = document.querySelectorAll<HTMLButtonElement>('.speed-btn')
const gapBtns = document.querySelectorAll<HTMLButtonElement>('.gap-btn')
const btnBold = document.getElementById('btn-bold') as HTMLButtonElement
const btnItalic = document.getElementById('btn-italic') as HTMLButtonElement
const btnAlignLeft = document.getElementById('btn-align-left') as HTMLButtonElement
const btnAlignCenter = document.getElementById('btn-align-center') as HTMLButtonElement
const btnAlignRight = document.getElementById('btn-align-right') as HTMLButtonElement
const fontSizeInput = document.getElementById('font-size-input') as HTMLInputElement
const docTabBar = document.getElementById('doc-tab-bar') as HTMLDivElement
const btnAddTab = document.getElementById('btn-add-tab') as HTMLButtonElement
const tabSidebar = document.getElementById('tab-sidebar') as HTMLElement
const btnSidebarToggle = document.getElementById('btn-sidebar-toggle') as HTMLButtonElement
const fontFamilySelect = document.getElementById('font-family-select') as HTMLSelectElement
const btnWordCount = document.getElementById('btn-word-count') as HTMLButtonElement
const saveReminderBackdrop = document.getElementById('save-reminder-backdrop') as HTMLDivElement
const btnReminderSave = document.getElementById('btn-reminder-save') as HTMLButtonElement
const btnReminderDismiss = document.getElementById('btn-reminder-dismiss') as HTMLButtonElement

// ── Font family ───────────────────────────────────────────────────────────────

const FONT_CSS: Record<string, string> = {
  serif: "Georgia, 'Times New Roman', serif",
  sans: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  mono: "'Courier New', Courier, monospace",
}

function syncFontSelect(key: string): void {
  fontFamilySelect.value = key in FONT_CSS ? key : 'serif'
}

const recorder = new Recorder(writeArea)

// Longest pause replayed at its recorded length; anything longer collapses to this. Keeps a
// session full of thinking time watchable by default. Changed at runtime from the replay
// controls, so read maxGapMs off the player rather than this constant after startup — it is
// only the initial value, and must match the button marked active in index.html.
const DEFAULT_MAX_GAP_MS = 3000

const player = new Player(replayArea, { speedMultiplier: 1, maxGapMs: DEFAULT_MAX_GAP_MS })
let maxGapMs = DEFAULT_MAX_GAP_MS
const undoManager = new UndoManager(writeArea)

let tabs: TabRuntime[] = [createTab('Tab 1')]
let activeTabIndex = 0
// Monotonic counter for default tab names so closing a middle tab can't produce
// a later collision (e.g. two "Tab 3"s). Reset on New, bumped past opened docs.
let tabSeq = 1
let currentFilePath: string | null = null
let sessionRecording: Recording | null = null
let sessionStartTabId: string | null = null

const activeTab = () => tabs[activeTabIndex]

player.onProgress((index, total) => updateProgress(index, total))
player.onStats((typed, pasted, overwrite) => updateStats(typed, pasted, overwrite))
player.onComplete(() => {
  transition(AppState.Recorded)
  showToast('Playback complete')
})
player.onTabSwitch((toTabId) => {
  const idx = tabs.findIndex(t => t.id === toTabId)
  if (idx === -1 || idx === activeTabIndex) return
  // Keep writeArea and toolbar state in sync with the active tab even when playback
  // drives the switch — otherwise the next save copies the wrong tab's HTML into
  // the new active tab. The playing/paused state travels with the active tab; the
  // tab left behind is playable (a session recording exists), hence Recorded.
  const playState = activeTab().state
  activeTab().state = AppState.Recorded
  saveActiveTabRuntime()
  activeTabIndex = idx
  restoreActiveTabRuntime()
  activeTab().state = playState
  renderTabBar(tabs, toTabId, docTabBar, tabBarCallbacks)
})

function updateReplayAvailable(): void {
  document.body.dataset.replayAvailable =
    (sessionRecording !== null || activeTab().loadedRecording !== null) ? 'true' : 'false'
}

function transition(next: AppState): void {
  activeTab().state = next
  applyState(next)

  const hasRecording = sessionRecording !== null || activeTab().loadedRecording !== null
  const isPlayable = next === AppState.Recorded || next === AppState.Playing || next === AppState.Paused
  btnPlayPause.disabled = !hasRecording || !isPlayable
  btnStopPlayback.disabled = next !== AppState.Playing && next !== AppState.Paused
  btnSkipEnd.disabled = !hasRecording || !isPlayable
  replayArea.contentEditable = 'false'

  if (next === AppState.Playing) {
    btnPlayPause.textContent = 'Pause'
  } else if (next === AppState.Paused) {
    btnPlayPause.textContent = 'Resume'
  } else {
    btnPlayPause.textContent = 'Play'
  }
}

// Persist the active tab's editor content and toolbar state onto its TabRuntime.
function saveActiveTabRuntime(): void {
  const tab = activeTab()
  tab.editorHtml = writeArea.innerHTML
  tab.fontSizeRem = currentFontSizeRem
  tab.pendingFontSize = pendingFontSize
  tab.pendingFontFamily = pendingFontFamily
  tab.fontFamily = fontFamilySelect.value
  tab.undo = undoManager.getState()
}

// Load the active tab's editor content and toolbar state into the DOM and globals.
// Any saved selection Range points into DOM the innerHTML swap just detached, so
// it is always dropped rather than carried across tabs. The undo history travels with
// the tab for the same reason: its deltas only describe this tab's content.
function restoreActiveTabRuntime(): void {
  const tab = activeTab()
  writeArea.innerHTML = tab.editorHtml
  undoManager.setState(tab.undo)
  currentFontSizeRem = tab.fontSizeRem
  pendingFontSize = tab.pendingFontSize
  pendingFontFamily = tab.pendingFontFamily
  savedRange = null
  clearSelectionOverlay()
  fontSizeInput.value = String(Math.round(currentFontSizeRem * 10))
  syncFontSelect(tab.fontFamily)
}

function buildDocumentPayload(): GraphineDocument {
  activeTab().editorHtml = writeArea.innerHTML
  return {
    version: 3,
    tabs: tabs.map(t => ({
      id: t.id,
      name: t.name,
      editorHtml: t.editorHtml,
      recording: t.loadedRecording,
      fontFamily: t.fontFamily,
    })),
    activeTabId: activeTab().id,
    sessionRecording,
    sessionStartTabId: sessionStartTabId ?? undefined,
  }
}

const tabBarCallbacks = {
  onSwitch: (index: number) => switchActiveTab(index),
  onClose: (tabId: string) => doCloseTab(tabId),
  onRename: (tabId: string, labelEl: HTMLSpanElement) => {
    startRename(tabId, labelEl, (id, newName) => {
      // startRename has already swapped the label DOM to show newName; we only
      // need to persist it onto the tab model here.
      const t = tabs.find(t => t.id === id)
      if (t) t.name = newName
      // Tab names are part of the saved payload, so a rename is an unsaved change even
      // though it never touches the write area and so fires no input event.
      markDirty()
    })
  },
}

// ── Autosave ──────────────────────────────────────────────────────────────────

// Once the document has a file on disk, a pause in editing writes it back silently, so an
// unattended session can never lose more than a minute of work.
//
// "Inactive" here means no edits — deliberately not the broader mouse/keyboard activity the
// inactivity-based control hiding watches. A reader nudging the mouse over a finished
// paragraph is idle for our purposes, and treating that as activity would let unsaved
// changes sit in memory indefinitely, which is the exact failure autosave exists to prevent.
const AUTOSAVE_IDLE_MS = 60_000

let dirtySinceSave = false
let autosaveTimer: ReturnType<typeof setTimeout> | null = null
let saveInFlight = false

// Every document mutation restarts the countdown, so the write lands a minute after the
// user actually stops, not a minute after they started.
function markDirty(): void {
  dirtySinceSave = true
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(runAutosave, AUTOSAVE_IDLE_MS)
  setDocTitle(currentFilePath, true)
}

// Called on every successful write, manual or automatic. Every assignment to
// currentFilePath is paired with one of these two, so the header title only
// needs refreshing here.
function markSaved(): void {
  dirtySinceSave = false
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = null
  setDocTitle(currentFilePath, false)
}

function runAutosave(): void {
  autosaveTimer = null
  // Autosave only ever overwrites a file the user already chose: with no path it would fall
  // through to the Save-As branch and throw a native dialog at an absent user.
  if (!currentFilePath || !dirtySinceSave || saveInFlight) return
  const st = activeTab().state
  if (st === AppState.Playing || st === AppState.Paused) return
  doSave(true)
}

// Wrapper so an autosave timer can tell whether a save is already running — the native
// dialog in the Save-As branch keeps performSave in flight for as long as the user leaves
// it open, and a second concurrent save would merge the same recorder frames twice.
async function doSave(auto = false): Promise<void> {
  saveInFlight = true
  try {
    await performSave(auto)
  } finally {
    saveInFlight = false
  }
}

async function performSave(auto: boolean): Promise<void> {
  const tab = activeTab()
  // Only consume the recorder while it's live. stop() deliberately leaves frames in
  // place so a cancelled save can resume(); calling it again after a successful save
  // would return the same frames and merge the whole segment into the recording twice.
  const wasRecording = recorder.isRecording
  const newRecording = wasRecording ? recorder.stop() : null

  // Build session recording (spans all tabs; used for playback)
  const prevSessionRecording = sessionRecording
  if (newRecording && newRecording.frames.length > 0) {
    sessionRecording = prevSessionRecording
      ? mergeRecording(prevSessionRecording, newRecording)
      : newRecording
  }

  // Per-tab recording (backward compat for single-tab scenarios)
  let tabRecording: Recording | null = tab.loadedRecording
  if (newRecording && newRecording.frames.length > 0) {
    tabRecording = tabRecording
      ? mergeRecording(tabRecording, newRecording)
      : newRecording
  }

  const hasAnyContent = sessionRecording !== null
    || tabRecording !== null
    || tabs.some((t, i) => i !== activeTabIndex && t.loadedRecording !== null)
  if (!hasAnyContent) {
    // An autosave firing on an empty document is a no-op, not a user error worth a toast.
    if (!auto) showToast('Nothing recorded yet', 'error')
    if (wasRecording) recorder.resume()
    return
  }

  // Temporarily update tab for payload building; revert on failure
  const prevLoaded = tab.loadedRecording
  tab.loadedRecording = tabRecording
  tab.editorHtml = writeArea.innerHTML

  const json = JSON.stringify(buildDocumentPayload(), null, 2)

  try {
    if (currentFilePath) {
      await window.electronAPI.writeToPath(currentFilePath, json)
      markSaved()
      updateReplayAvailable()
      transition(AppState.Recorded)
      showToast(`${auto ? 'Autosaved' : 'Saved'} to ${basename(currentFilePath)}`)
    } else {
      const refRecording = sessionRecording ?? tabRecording ?? tabs.find(t => t.loadedRecording !== null)?.loadedRecording
      const defaultName = refRecording
        ? buildDefaultName(refRecording.meta.createdAt)
        : 'graphine-document.grph'
      const savedPath = await window.electronAPI.saveRecording(json, defaultName)
      if (savedPath) {
        currentFilePath = savedPath
        markSaved()
        updateReplayAvailable()
        transition(AppState.Recorded)
        showToast(`Saved to ${basename(savedPath)}`)
      } else {
        // Save dialog cancelled — keep recording so nothing typed is lost.
        sessionRecording = prevSessionRecording
        tab.loadedRecording = prevLoaded
        if (wasRecording) recorder.resume()
      }
    }
  } catch {
    sessionRecording = prevSessionRecording
    tab.loadedRecording = prevLoaded
    showToast('Failed to save recording', 'error')
    if (wasRecording) recorder.resume()
    // dirtySinceSave is still set, but the countdown that fired has already been consumed —
    // restart it, or a failed write on an idle machine would never be retried, since there
    // is no further edit coming to reschedule it.
    if (auto) autosaveTimer = setTimeout(runAutosave, AUTOSAVE_IDLE_MS)
  }
}

async function doOpen(): Promise<void> {
  if (activeTab().state === AppState.Recording && recorder.frameCount > 0) {
    const save = confirm('Save current recording before opening?')
    if (save) {
      // doSave fully awaits the native dialog and the disk write, so if we're no
      // longer in Recording state the save either succeeded or there was nothing
      // to save — safe to continue straight into the open dialog.
      await doSave()
      if (activeTab().state === AppState.Recording) return
    } else {
      recorder.reset()
    }
  }

  let result: Awaited<ReturnType<typeof window.electronAPI.openRecording>>
  try {
    result = await window.electronAPI.openRecording()
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to open file', 'error')
    return
  }
  if (!result) return

  try {
    const data = JSON.parse(result.content) as { version?: unknown; frames?: unknown; tabs?: unknown }

    let doc: GraphineDocument
    let loadedSession: Recording | null = null
    if (data.version === 1 && Array.isArray(data.frames)) {
      doc = wrapV1AsDocument(data as Recording)
      loadedSession = doc.sessionRecording
    } else if (data.version === 3 && Array.isArray(data.tabs)) {
      doc = data as GraphineDocument
      loadedSession = doc.sessionRecording ?? null
    } else if (data.version === 2 && Array.isArray(data.tabs)) {
      const d = data as { tabs: Tab[]; activeTabId: string }
      doc = { version: 3, tabs: d.tabs, activeTabId: d.activeTabId, sessionRecording: null }
      loadedSession = null
    } else {
      showToast('Invalid recording file', 'error')
      return
    }

    sessionRecording = loadedSession
    sessionStartTabId = (doc as GraphineDocument).sessionStartTabId ?? null
    currentFilePath = result.filePath
    // Freshly loaded from disk, so in-memory and on-disk agree until the next edit.
    markSaved()
    tabs = doc.tabs.map(t => ({
      id: t.id,
      name: t.name,
      editorHtml: t.editorHtml,
      state: (t.recording !== null || loadedSession !== null) ? AppState.Recorded : AppState.Idle,
      loadedRecording: t.recording,
      fontSizeRem: 1.2,
      pendingFontSize: null,
      pendingFontFamily: null,
      fontFamily: t.fontFamily ?? 'serif',
      undo: emptyUndoState(),
    }))

    tabSeq = Math.max(tabSeq, tabs.length)

    const activeIdx = tabs.findIndex(t => t.id === doc.activeTabId)
    activeTabIndex = activeIdx >= 0 ? activeIdx : 0

    const tab = activeTab()
    writeArea.innerHTML = tab.editorHtml
    // Nothing in the freshly loaded document can be undone back past its own opening state.
    undoManager.setState(tab.undo)
    replayArea.innerHTML = ''

    const toLoad = sessionRecording ?? tab.loadedRecording
    if (toLoad) {
      player.load(toLoad, sessionStartTabId ?? undefined)
      updateProgress(0, toLoad.frames.length)
    }

    renderTabBar(tabs, activeTab().id, docTabBar, tabBarCallbacks)
    updateReplayAvailable()
    transition(tab.state)
    syncFontSelect(tab.fontFamily)

    const title = tab.loadedRecording?.meta.title
    showToast(title ? `Loaded: ${title}` : 'Document loaded')
  } catch {
    showToast('Failed to parse recording file', 'error')
  }
}

async function doExportPdf(): Promise<void> {
  // Export is scoped to the active tab: its own recording, or its slice of the
  // session recording — never another tab's content, even when this tab is blank.
  const tab = activeTab()
  const tabRec = tab.loadedRecording
  const rec = tabRec ?? sessionRecording
  if (!rec) {
    showToast('Save or record before exporting', 'error')
    return
  }

  // Reproduce the exact end-of-replay colored state via a throwaway Player on a
  // detached element, so the PDF matches what the replay shows. Legacy documents
  // may lack sessionStartTabId; attribute the session start to the active tab then.
  const scratch = document.createElement('div')
  // Timing is irrelevant here — skipToEnd() applies every frame at once — but the export
  // should track the live player's settings rather than pin its own copy of the default.
  const exporter = new Player(scratch, { speedMultiplier: 1, maxGapMs })
  exporter.load(rec, tabRec ? undefined : (sessionStartTabId ?? tab.id))
  exporter.skipToEnd()
  const history = tabRec ? exporter.getHistory() : exporter.getHistoryForTab(tab.id)

  // Derive the title from the exported slice, not the whole recording, so a blank
  // or partial tab can't pick up another tab's text.
  const text = history.map(e => e.char).join('')
  const title = (tabRec ? rec.meta.title : '') || titleFromText(text) || 'Untitled document'
  const safeName = title.replace(/[/\\:*?"<>|]/g, '-').slice(0, 80)
  const html = buildExportHtml([{ history }], { title, createdAt: rec.meta.createdAt })

  try {
    const saved = await window.electronAPI.exportPdf(html, `${safeName}.pdf`)
    if (saved) showToast(`Exported to ${saved.split('/').pop()}`)
  } catch {
    showToast('Failed to export PDF', 'error')
  }
}

function doNew(): void {
  const hasUnsaved = activeTab().state === AppState.Recording && recorder.frameCount > 0

  if (hasUnsaved) {
    if (!confirm('Discard unsaved recording and start a new document?')) return
  }

  if (activeTab().state === AppState.Recording) recorder.reset()
  else if (activeTab().state === AppState.Playing || activeTab().state === AppState.Paused) player.stop()

  currentFilePath = null
  // No path and no edits yet — cancel any countdown left over from the discarded document.
  markSaved()
  sessionRecording = null
  sessionStartTabId = null
  tabs = [createTab('Tab 1')]
  tabSeq = 1
  activeTabIndex = 0

  restoreActiveTabRuntime()
  replayArea.innerHTML = ''
  writeArea.contentEditable = 'true'
  writeArea.focus()

  renderTabBar(tabs, activeTab().id, docTabBar, tabBarCallbacks)
  updateReplayAvailable()
  switchView('write')
  transition(AppState.Idle)
}

function doNewTab(): void {
  // switchActiveTab refuses to leave a recorded/playing/paused tab; creating one
  // here anyway would push an orphan tab that never renders. Guard up front.
  const st = activeTab().state
  if (st === AppState.Recorded || st === AppState.Playing || st === AppState.Paused) {
    showToast('Finish or start a new document before adding a tab', 'error')
    return
  }
  tabs.push(createTab(`Tab ${++tabSeq}`))
  switchActiveTab(tabs.length - 1)
  markDirty()
}

function doCloseTab(tabId: string): void {
  if (tabs.length <= 1) return

  const idx = tabs.findIndex(t => t.id === tabId)
  if (idx === -1) return

  const tab = tabs[idx]
  const isDirty = idx === activeTabIndex && tab.state === AppState.Recording && recorder.frameCount > 0
  if (isDirty && !confirm(`Close "${tab.name}" and discard unsaved changes?`)) return

  if (idx === activeTabIndex) {
    // After splice every later tab shifts left by one, so closing the first tab
    // (idx 0) should land on the new index 0; otherwise prefer the left neighbour.
    const targetIdx = idx > 0 ? idx - 1 : 0

    if (tab.state === AppState.Recording) recorder.reset()
    else if (tab.state === AppState.Playing || tab.state === AppState.Paused) player.stop()

    tabs.splice(idx, 1)
    activeTabIndex = Math.min(targetIdx, tabs.length - 1)

    const incoming = activeTab()
    restoreActiveTabRuntime()
    replayArea.innerHTML = ''

    if (incoming.loadedRecording) {
      player.load(incoming.loadedRecording)
      updateProgress(0, incoming.loadedRecording.frames.length)
    }

    updateReplayAvailable()
    transition(incoming.state)
  } else {
    tabs.splice(idx, 1)
    if (idx < activeTabIndex) activeTabIndex--
  }

  renderTabBar(tabs, activeTab().id, docTabBar, tabBarCallbacks)
  markDirty()
}

function switchActiveTab(toIndex: number): void {
  if (toIndex === activeTabIndex) return
  if (toIndex < 0 || toIndex >= tabs.length) return

  const outgoing = activeTab()

  if (outgoing.state === AppState.Recorded || outgoing.state === AppState.Playing || outgoing.state === AppState.Paused) return

  if (outgoing.state === AppState.Recording) {
    // Capture a tab-switch marker frame and keep the recorder running
    recorder.captureTabSwitch(tabs[toIndex].id, tabs[toIndex].name)
  }

  saveActiveTabRuntime()
  activeTabIndex = toIndex
  const incoming = activeTab()

  restoreActiveTabRuntime()
  replayArea.innerHTML = ''

  if (outgoing.state === AppState.Recording) {
    recorder.captureNow(true)  // baseline frame for incoming tab — resets diff anchor
    incoming.state = AppState.Recording
  }

  const toLoad = sessionRecording ?? incoming.loadedRecording
  if (toLoad) {
    player.load(toLoad, sessionStartTabId ?? undefined)
    updateProgress(0, toLoad.frames.length)
  }

  updateReplayAvailable()
  renderTabBar(tabs, incoming.id, docTabBar, tabBarCallbacks)
  transition(incoming.state)
}

// ── Font size ─────────────────────────────────────────────────────────────────

const FONT_STEP = 0.1
const FONT_MIN = 0.8
const FONT_MAX = 2.4
let currentFontSizeRem = 1.2
let pendingFontSize: number | null = null
let pendingFontFamily: string | null = null

function insertCharWithStyles(char: string, sizeRem: number | null, fontFamilyKey: string | null): void {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  range.deleteContents()

  const span = document.createElement('span')
  if (sizeRem !== null) span.style.fontSize = `${sizeRem}rem`
  if (fontFamilyKey !== null) span.style.fontFamily = FONT_CSS[fontFamilyKey] ?? FONT_CSS['serif']
  const textNode = document.createTextNode(char)
  span.appendChild(textNode)
  range.insertNode(span)

  const newRange = document.createRange()
  newRange.setStart(textNode, char.length)
  newRange.collapse(true)
  sel.removeAllRanges()
  sel.addRange(newRange)

  // `data` carries the character so the undo stack can coalesce this into the surrounding
  // typing run, exactly as it would for a native keystroke.
  writeArea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char }))
}

// Shift+Tab outdent: if the caret sits just after a tab character, remove that one tab.
// execCommand('delete') keeps the change on the contentEditable undo stack and fires an
// input event so the recorder captures it (as a backspace-style edit) like any other edit.
function outdentAtCaret(): void {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  if (!range.collapsed) return
  const node = range.startContainer
  const offset = range.startOffset
  if (node.nodeType !== Node.TEXT_NODE || offset === 0) return
  if (node.textContent?.[offset - 1] !== '\t') return

  const del = document.createRange()
  del.setStart(node, offset - 1)
  del.setEnd(node, offset)
  sel.removeAllRanges()
  sel.addRange(del)
  document.execCommand('delete')
}

// Wrap a selection range in a styled span and reselect the wrapped content. Shared by the
// font-size and font-family controls.
function wrapRangeWithStyle(range: Range, prop: 'fontSize' | 'fontFamily', value: string): void {
  const fragment = range.extractContents()
  const span = document.createElement('span')
  span.style[prop] = value
  span.appendChild(fragment)
  range.insertNode(span)
  const newRange = document.createRange()
  newRange.selectNodeContents(span)
  const sel = window.getSelection()
  if (sel) {
    sel.removeAllRanges()
    sel.addRange(newRange)
  }
  // Announce the change as input rather than calling recorder.captureNow(): that puts it on
  // the undo stack (this path mutates the DOM directly, so nothing else would), and lets the
  // recorder time the frame like any other edit instead of stamping it t:0.
  const inputType = prop === 'fontSize' ? 'formatFontSize' : 'formatFontName'
  writeArea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }))
}

function applyFontSize(targetRem: number): void {
  currentFontSizeRem = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(targetRem * 10) / 10))
  fontSizeInput.value = String(Math.round(currentFontSizeRem * 10))

  const sel = window.getSelection()
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
  const inWriteArea = range && writeArea.contains(range.commonAncestorContainer)

  if (range && !range.collapsed && inWriteArea) {
    wrapRangeWithStyle(range, 'fontSize', `${currentFontSizeRem}rem`)
  } else {
    pendingFontSize = currentFontSizeRem
  }
}

function applyFontSizeChange(delta: number): void {
  applyFontSize(currentFontSizeRem + delta)
}

// ── Boot ──────────────────────────────────────────────────────────────────────

applyState(AppState.Idle)
updateReplayAvailable()
setupInactivityHiding()
renderTabBar(tabs, activeTab().id, docTabBar, tabBarCallbacks)
setDocTitle(currentFilePath, dirtySinceSave)
syncFontSelect(activeTab().fontFamily)
setupMinimap(writeScroll, writeArea, minimapCanvas)

document.execCommand('defaultParagraphSeparator', false, 'br')

if (window.electronAPI.platform === 'darwin') {
  document.body.dataset.platform = 'darwin'
}

window.electronAPI.onFullscreenChange((isFullscreen) => {
  document.body.dataset.fullscreen = String(isFullscreen)
})

// ── Save reminder ─────────────────────────────────────────────────────────────

// Nudge the user to save once they return from another app. The main process only reports
// window-level focus (it can't see WHICH app took over), and it already suppresses the
// blur/focus pair a native save/open dialog produces — so a report of lost focus here really
// does mean the user left Graphine. Only a return that follows a departure opens the dialog,
// so it never fires on launch.
let wasBlurred = false
// Where the caret was when focus left, so dismissing puts the user back where they were
// instead of at the top of the document.
let reminderSavedRange: Range | null = null

function showSaveReminder(): void {
  if (!saveReminderBackdrop.hidden) return
  const sel = window.getSelection()
  reminderSavedRange = sel && sel.rangeCount > 0 && writeArea.contains(sel.getRangeAt(0).commonAncestorContainer)
    ? sel.getRangeAt(0).cloneRange()
    : null
  saveReminderBackdrop.hidden = false
  btnReminderSave.focus()
}

function hideSaveReminder(): void {
  if (saveReminderBackdrop.hidden) return
  saveReminderBackdrop.hidden = true
  if (document.body.dataset.view !== 'write') return
  writeArea.focus()
  if (reminderSavedRange) {
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(reminderSavedRange)
  }
  reminderSavedRange = null
}

window.electronAPI.onFocusChange((isFocused) => {
  if (!isFocused) {
    wasBlurred = true
    return
  }
  if (!wasBlurred) return
  wasBlurred = false
  // A long absence is exactly when autosave fires, so by the time the user gets back the
  // work may already be on disk. Nagging them to save what is demonstrably saved would be
  // worse than saying nothing.
  if (currentFilePath !== null && !dirtySinceSave) return
  showSaveReminder()
})

btnReminderDismiss.addEventListener('click', hideSaveReminder)

btnReminderSave.addEventListener('click', () => {
  // Close first: doSave opens a native dialog, and leaving the modal up behind it would
  // trap focus once the dialog returns.
  hideSaveReminder()
  doSave()
})

// Escape dismisses; Tab is trapped between the two buttons so focus can't wander into the
// editor behind the modal.
saveReminderBackdrop.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    hideSaveReminder()
    return
  }
  if (e.key !== 'Tab') return
  e.preventDefault()
  const next = document.activeElement === btnReminderSave ? btnReminderDismiss : btnReminderSave
  next.focus()
})

// Clicking the dimmed area outside the card dismisses, matching the Escape affordance.
saveReminderBackdrop.addEventListener('mousedown', (e) => {
  if (e.target === saveReminderBackdrop) hideSaveReminder()
})

// ── Menu actions ──────────────────────────────────────────────────────────────

window.electronAPI.onMenuAction((action) => {
  switch (action) {
    case 'save': doSave(); break
    case 'open': doOpen(); break
    case 'export-pdf': doExportPdf(); break
    case 'new': doNew(); break
    case 'view:write': switchView('write'); break
    case 'view:replay': switchView('replay'); break
    case 'font:increase': applyFontSizeChange(FONT_STEP); break
    case 'font:decrease': applyFontSizeChange(-FONT_STEP); break
    case 'undo': applyHistoryStep('undo'); break
    case 'redo': applyHistoryStep('redo'); break
  }
})

// ── Write controls ────────────────────────────────────────────────────────────

// Begin a recording segment if one isn't already running, capturing the editor's
// CURRENT content as the baseline keyframe. Call this BEFORE mutating the DOM so the
// mutation that follows records as its own delta frame rather than being folded into
// the baseline (which would replay as plain typed text).
function ensureRecordingStarted(): void {
  const st = activeTab().state
  if (st !== AppState.Idle && st !== AppState.Recorded) return
  if (sessionRecording === null) sessionStartTabId = activeTab().id
  recorder.start()
  recorder.captureNow(true)
  transition(AppState.Recording)
}

writeArea.addEventListener('input', ensureRecordingStarted)
// Covers every edit path, not just typing: paste, drop, undo/redo and the formatting
// commands all reach the recorder by dispatching an input event on the write area.
writeArea.addEventListener('input', markDirty)

// ── Undo / redo ───────────────────────────────────────────────────────────────

// Both steps mutate the write area directly, so — exactly like the paste handler — the
// recording segment has to be opened BEFORE the mutation, or the restored state would be
// swallowed into a fresh baseline keyframe and the step would never appear in the replay.
// The synthetic input event that follows is what carries the intent to the recorder, and
// that intent is what lets replay give restored characters back their original provenance.
function applyHistoryStep(step: 'undo' | 'redo'): void {
  if (document.body.dataset.view !== 'write') return
  // The save reminder is modal — don't let Ctrl+Z rewrite the document behind it.
  if (!saveReminderBackdrop.hidden) return
  const st = activeTab().state
  if (st === AppState.Playing || st === AppState.Paused) return

  // A focused text field (the font-size box, a tab-rename input) keeps its own native undo;
  // leave that to the browser rather than rewriting the document behind the user's back.
  const focused = document.activeElement
  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
    document.execCommand(step)
    return
  }

  // Checked before ensureRecordingStarted so a no-op Ctrl+Z can't open an empty segment.
  if (step === 'undo' ? !undoManager.canUndo : !undoManager.canRedo) return
  ensureRecordingStarted()
  if (!(step === 'undo' ? undoManager.undo() : undoManager.redo())) return

  writeArea.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    inputType: step === 'undo' ? 'historyUndo' : 'historyRedo',
  }))
}

writeArea.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((pendingFontSize !== null || pendingFontFamily !== null) && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
    e.preventDefault()
    insertCharWithStyles(e.key, pendingFontSize, pendingFontFamily)
    pendingFontSize = null
    pendingFontFamily = null
    return
  }
  // Tab inserts a literal tab for indentation (default would move focus out of the
  // editable area); Shift+Tab removes one preceding tab. white-space: pre-wrap renders
  // the tab in the write, replay, and PDF views alike.
  if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault()
    if (e.shiftKey) {
      outdentAtCaret()
    } else if (pendingFontSize !== null || pendingFontFamily !== null) {
      insertCharWithStyles('\t', pendingFontSize, pendingFontFamily)
      pendingFontSize = null
      pendingFontFamily = null
    } else {
      document.execCommand('insertText', false, '\t')
    }
    return
  }
  if (!(e.metaKey || e.ctrlKey)) return
  if (e.shiftKey) {
    const key = e.key.toLowerCase()
    if (key === 'l') {
      e.preventDefault()
      applyAlign('justifyLeft')
    } else if (key === 'e') {
      e.preventDefault()
      applyAlign('justifyCenter')
    } else if (key === 'r') {
      e.preventDefault()
      applyAlign('justifyRight')
    }
    return
  }
  if (e.key === 'b') {
    e.preventDefault()
    document.execCommand('bold')
  } else if (e.key === 'i') {
    e.preventDefault()
    document.execCommand('italic')
  }
})

// Undo/redo are bound here rather than by the Edit menu's accelerators. Key events reach the
// renderer first, and a focused contenteditable handles Ctrl+Z itself as an editing command —
// so the accelerator would never fire and Chromium's own undo stack would run instead.
// preventDefault is what actually stops it. Bound on the document, not the write area, so the
// shortcut still works when focus sits on a toolbar button; applyHistoryStep does the rest of
// the guarding. The menu items carry registerAccelerator:false so they cannot double-fire.
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return
  const key = e.key.toLowerCase()
  if (key === 'z') {
    e.preventDefault()
    applyHistoryStep(e.shiftKey ? 'redo' : 'undo')
  } else if (key === 'y' && !e.shiftKey) {
    e.preventDefault()
    applyHistoryStep('redo')
  }
})

// Text copied or cut from within the editor, so a later paste of the same content can be
// recognized as internal (authored here) rather than incoming — see the paste handler.
let lastInternalClipboardText = ''
const normalizeBreaks = (s: string): string => s.replace(/\r\n?/g, '\n')

const captureInternalCopy = (): void => {
  lastInternalClipboardText = normalizeBreaks(window.getSelection()?.toString() ?? '')
}
writeArea.addEventListener('copy', captureInternalCopy)
writeArea.addEventListener('cut', captureInternalCopy)

// True while a drag that started inside the editor is in flight, so a drop landing back in
// the editor is treated as an internal move rather than incoming content.
let internalDragActive = false
writeArea.addEventListener('dragstart', () => { internalDragActive = true })
writeArea.addEventListener('dragend', () => { internalDragActive = false })
// Native drop insertion is left as-is; we only tag its provenance. A drop whose drag
// originated inside the editor is an internal move → the recorder tags the resulting
// insertFromDrop frame 'internal', and replay inherits the moved text's original provenance.
// External drag-ins never set the flag → they stay yellow via the size heuristic.
writeArea.addEventListener('drop', () => {
  if (internalDragActive) recorder.markInternalInsert()
})

// Paste as plain text so line breaks become literal '\n' text nodes (matching
// typed Enter under white-space: pre-wrap) instead of Chromium's default <br>/div
// HTML — which double-counts breaks on replay (innerText sees both \n and <br>).
writeArea.addEventListener('paste', (e: ClipboardEvent) => {
  e.preventDefault()
  const text = e.clipboardData?.getData('text/plain') ?? ''
  if (!text) return
  const normalized = normalizeBreaks(text)

  // Establish the baseline from the pre-paste content first, so the paste below records
  // as its own delta frame and replays as 'pasted' (yellow). Without this, the generic
  // input listener would snapshot the post-paste DOM as the baseline → plain typed text.
  ensureRecordingStarted()

  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  range.deleteContents()

  const textNode = document.createTextNode(normalized)
  range.insertNode(textNode)

  const newRange = document.createRange()
  newRange.setStart(textNode, normalized.length)
  newRange.collapse(true)
  sel.removeAllRanges()
  sel.addRange(newRange)

  // Clipboard content that exactly matches what was last copied/cut from this doc is an
  // internal copy: flag it so replay inherits the copied source's provenance — plain if the
  // source was typed, still yellow if the source was itself pasted from outside. Anything else
  // is an external paste (stays yellow). Exact-match is conservative: a miss keeps the yellow
  // behavior. Both cases dispatch insertFromPaste; the flag is what distinguishes them.
  if (normalized === lastInternalClipboardText) recorder.markInternalInsert()
  writeArea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }))
})

// Wrapped, not passed directly: doSave's first parameter is the autosave flag, and a
// listener bound straight to it would hand the MouseEvent over as a truthy `auto`.
btnStopSave.addEventListener('click', () => doSave())
btnOpenHeader.addEventListener('click', doOpen)
btnNew.addEventListener('click', doNew)
document.getElementById('btn-save-for-replay')!.addEventListener('click', () => doSave())
document.getElementById('btn-open-replay')!.addEventListener('click', doOpen)
btnAddTab.addEventListener('click', doNewTab)
btnSidebarToggle.addEventListener('click', () => {
  const collapsed = tabSidebar.classList.toggle('collapsed')
  btnSidebarToggle.textContent = collapsed ? '›' : '‹'
  btnSidebarToggle.title = collapsed ? 'Show sidebar' : 'Hide sidebar'
  btnSidebarToggle.setAttribute('aria-expanded', String(!collapsed))
})

btnMinimapToggle.addEventListener('click', () => {
  const collapsed = minimapWrap.classList.toggle('collapsed')
  btnMinimapToggle.textContent = collapsed ? '‹' : '›'
  btnMinimapToggle.title = collapsed ? 'Show minimap' : 'Hide minimap'
  btnMinimapToggle.setAttribute('aria-expanded', String(!collapsed))
})

// ── View switching ────────────────────────────────────────────────────────────

tabWrite.addEventListener('click', () => switchView('write'))
tabReplay.addEventListener('click', () => switchView('replay'))

// ── Replay controls ───────────────────────────────────────────────────────────

function jumpToStartTab(): void {
  if (!sessionStartTabId) return
  const startIdx = tabs.findIndex(t => t.id === sessionStartTabId)
  if (startIdx === -1 || startIdx === activeTabIndex) return
  saveActiveTabRuntime()
  activeTabIndex = startIdx
  restoreActiveTabRuntime()
  renderTabBar(tabs, activeTab().id, docTabBar, tabBarCallbacks)
}

// Rewind to the recording's start tab, load it into the player and enter Playing.
function preparePlaybackFromRecorded(): void {
  jumpToStartTab()
  const toPlay = sessionRecording ?? activeTab().loadedRecording
  if (toPlay) {
    player.load(toPlay, sessionStartTabId ?? undefined)
    replayArea.innerHTML = ''
    updateProgress(0, toPlay.frames.length)
  }
  transition(AppState.Playing)
}

btnPlayPause.addEventListener('click', () => {
  if (activeTab().state === AppState.Recorded) {
    preparePlaybackFromRecorded()
    player.play()
  } else if (activeTab().state === AppState.Playing) {
    player.pause()
    transition(AppState.Paused)
  } else if (activeTab().state === AppState.Paused) {
    transition(AppState.Playing)
    player.play()
  }
})

btnStopPlayback.addEventListener('click', () => {
  player.stop()
  transition(AppState.Recorded)
})

btnSkipEnd.addEventListener('click', () => {
  if (activeTab().state === AppState.Recorded) {
    preparePlaybackFromRecorded()
  }
  player.skipToEnd()
})

// ── Format toolbar ────────────────────────────────────────────────────────────

btnBold.addEventListener('mousedown', (e) => { e.preventDefault(); document.execCommand('bold') })
btnItalic.addEventListener('mousedown', (e) => { e.preventDefault(); document.execCommand('italic') })

// Emit alignment as an inline `text-align` style (not the legacy `align` attribute) so the
// replay's char-history extractor reads it back consistently. styleWithCSS is scoped to the
// alignment command and reset afterward, leaving bold/italic on their default <b>/<i> form.
function applyAlign(cmd: 'justifyLeft' | 'justifyCenter' | 'justifyRight'): void {
  document.execCommand('styleWithCSS', false, 'true')
  document.execCommand(cmd)
  document.execCommand('styleWithCSS', false, 'false')
}

btnAlignLeft.addEventListener('mousedown', (e) => { e.preventDefault(); applyAlign('justifyLeft') })
btnAlignCenter.addEventListener('mousedown', (e) => { e.preventDefault(); applyAlign('justifyCenter') })
btnAlignRight.addEventListener('mousedown', (e) => { e.preventDefault(); applyAlign('justifyRight') })

// Keep focus (and the caret) in the write area when checking the word count.
btnWordCount.addEventListener('mousedown', (e) => e.preventDefault())
btnWordCount.addEventListener('click', () => {
  const text = writeArea.innerText.trim()
  const words = text.length === 0 ? 0 : text.split(/\s+/).length
  showToast(`${words.toLocaleString()} word${words === 1 ? '' : 's'}`)
})

// Remember the current write-area selection before a toolbar control steals focus,
// and paint an overlay so the user still sees what they had selected.
function captureToolbarSelection(): void {
  const sel = window.getSelection()
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0)
    if (writeArea.contains(range.commonAncestorContainer)) {
      savedRange = range.cloneRange()
      showSelectionOverlay()
    }
  }
}

fontFamilySelect.addEventListener('mousedown', captureToolbarSelection)

fontFamilySelect.addEventListener('change', () => {
  const key = fontFamilySelect.value
  const css = FONT_CSS[key] ?? FONT_CSS['serif']
  activeTab().fontFamily = key

  const rangeToUse = savedRange && !savedRange.collapsed ? savedRange : null
  if (rangeToUse) {
    wrapRangeWithStyle(rangeToUse, 'fontFamily', css)
  } else {
    pendingFontFamily = key
  }

  clearSelectionOverlay()
  savedRange = null
  writeArea.focus()
})

let savedRange: Range | null = null
let selectionOverlays: HTMLDivElement[] = []

function showSelectionOverlay(): void {
  if (!savedRange || savedRange.collapsed) return
  for (const rect of Array.from(savedRange.getClientRects())) {
    const el = document.createElement('div')
    el.className = 'selection-overlay'
    el.style.left = `${rect.left}px`
    el.style.top = `${rect.top}px`
    el.style.width = `${rect.width}px`
    el.style.height = `${rect.height}px`
    document.body.appendChild(el)
    selectionOverlays.push(el)
  }
}

function clearSelectionOverlay(): void {
  for (const el of selectionOverlays) el.remove()
  selectionOverlays = []
}

fontSizeInput.addEventListener('mousedown', captureToolbarSelection)

fontSizeInput.addEventListener('focus', () => fontSizeInput.select())

function restoreWriteAreaCursor(): void {
  clearSelectionOverlay()
  writeArea.focus()
  if (savedRange) {
    const sel = window.getSelection()
    if (sel) { sel.removeAllRanges(); sel.addRange(savedRange) }
    savedRange = null
  }
}

// restoreWriteAreaCursor() moves focus to the write area, which synchronously fires
// this input's blur handler. Suppress the blur-driven apply during that hand-off so
// the size isn't applied twice (which would nest spans and emit a stray capture).
let suppressBlurApply = false

fontSizeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    const val = parseInt(fontSizeInput.value, 10)
    suppressBlurApply = true
    restoreWriteAreaCursor()
    suppressBlurApply = false
    if (!isNaN(val)) applyFontSize(val / 10)
  } else if (e.key === 'Escape') {
    fontSizeInput.value = String(Math.round(currentFontSizeRem * 10))
    suppressBlurApply = true
    restoreWriteAreaCursor()
    suppressBlurApply = false
  }
})
fontSizeInput.addEventListener('blur', () => {
  clearSelectionOverlay()
  if (suppressBlurApply) return
  const val = parseInt(fontSizeInput.value, 10)
  if (!isNaN(val)) applyFontSize(val / 10)
  else fontSizeInput.value = String(Math.round(currentFontSizeRem * 10))
})

function selectInGroup(group: NodeListOf<HTMLButtonElement>, chosen: HTMLButtonElement): void {
  group.forEach((b) => {
    b.classList.toggle('active', b === chosen)
    b.setAttribute('aria-pressed', String(b === chosen))
  })
}

speedBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const speed = parseFloat(btn.dataset.speed ?? '1')
    player.setOptions({ speedMultiplier: speed })
    selectInGroup(speedBtns, btn)
  })
})

gapBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    // parseFloat reads "Infinity" as Infinity — the "Full" preset, which caps nothing and
    // replays every pause at its true recorded length.
    const gap = parseFloat(btn.dataset.gap ?? String(DEFAULT_MAX_GAP_MS))
    if (isNaN(gap)) return
    maxGapMs = gap
    player.setOptions({ maxGapMs: gap })
    selectInGroup(gapBtns, btn)
  })
})
