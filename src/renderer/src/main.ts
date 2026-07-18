import { Recorder } from './recorder'
import { Player } from './player'
import { buildExportHtml } from './pdfExport'
import { switchView, applyState, updateProgress, showToast, setupInactivityHiding, updateStats } from './ui'
import { AppState } from './types'
import type { Recording, Tab, TabRuntime, GraphineDocument } from './types'
import { createTab, renderTabBar, startRename } from './tabs'
import { setupMinimap } from './minimap'
import { lastFrameHtml, titleFromText } from './frameCodec'

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
const btnBold = document.getElementById('btn-bold') as HTMLButtonElement
const btnItalic = document.getElementById('btn-italic') as HTMLButtonElement
const fontSizeInput = document.getElementById('font-size-input') as HTMLInputElement
const docTabBar = document.getElementById('doc-tab-bar') as HTMLDivElement
const btnAddTab = document.getElementById('btn-add-tab') as HTMLButtonElement
const tabSidebar = document.getElementById('tab-sidebar') as HTMLElement
const btnSidebarToggle = document.getElementById('btn-sidebar-toggle') as HTMLButtonElement
const fontFamilySelect = document.getElementById('font-family-select') as HTMLSelectElement

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
const player = new Player(replayArea, { speedMultiplier: 1, maxGapMs: 3000 })

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
  if (idx === -1) return
  activeTabIndex = idx
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

function buildDefaultName(createdAt: string): string {
  const d = new Date(createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `graphine-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.grph`
}

function textFromHtml(html: string): string {
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  return tmp.textContent ?? ''
}

function mergeRecording(base: Recording, append: Recording): Recording {
  // Concatenation stays seamless: append's first frame is always a keyframe.
  const frames = [...base.frames, ...append.frames]
  const merged: Recording = {
    version: 2,
    meta: {
      title: base.meta.title,
      createdAt: base.meta.createdAt,
      durationMs: base.meta.durationMs + append.meta.durationMs,
      frameCount: frames.length,
    },
    frames,
  }
  merged.meta.title = titleFromText(textFromHtml(lastFrameHtml(merged)))
  return merged
}

function wrapV1AsDocument(recording: Recording): GraphineDocument {
  const id = crypto.randomUUID()
  return {
    version: 3,
    tabs: [{
      id,
      name: recording.meta.title ? recording.meta.title.slice(0, 20) : 'Tab 1',
      editorHtml: lastFrameHtml(recording),
      recording: null,
    }],
    activeTabId: id,
    sessionRecording: recording,
  }
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
    })
  },
}

async function doSave(): Promise<void> {
  const tab = activeTab()
  const newRecording = recorder.stop()

  // Build session recording (spans all tabs; used for playback)
  const prevSessionRecording = sessionRecording
  if (newRecording.frames.length > 0) {
    sessionRecording = prevSessionRecording
      ? mergeRecording(prevSessionRecording, newRecording)
      : newRecording
  }

  // Per-tab recording (backward compat for single-tab scenarios)
  let tabRecording: Recording | null = tab.loadedRecording
  if (newRecording.frames.length > 0) {
    tabRecording = tabRecording
      ? mergeRecording(tabRecording, newRecording)
      : newRecording
  }

  const hasAnyContent = sessionRecording !== null
    || tabRecording !== null
    || tabs.some((t, i) => i !== activeTabIndex && t.loadedRecording !== null)
  if (!hasAnyContent) {
    showToast('Nothing recorded yet', 'error')
    recorder.resume()
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
      updateReplayAvailable()
      transition(AppState.Recorded)
      showToast(`Saved to ${currentFilePath.split('/').pop()}`)
    } else {
      const refRecording = sessionRecording ?? tabRecording ?? tabs.find(t => t.loadedRecording !== null)?.loadedRecording
      const defaultName = refRecording
        ? buildDefaultName(refRecording.meta.createdAt)
        : 'graphine-document.grph'
      const savedPath = await window.electronAPI.saveRecording(json, defaultName)
      if (savedPath) {
        currentFilePath = savedPath
        updateReplayAvailable()
        transition(AppState.Recorded)
        showToast(`Saved to ${savedPath.split('/').pop()}`)
      } else {
        // Save dialog cancelled — keep recording so nothing typed is lost.
        sessionRecording = prevSessionRecording
        tab.loadedRecording = prevLoaded
        recorder.resume()
      }
    }
  } catch {
    sessionRecording = prevSessionRecording
    tab.loadedRecording = prevLoaded
    showToast('Failed to save recording', 'error')
    recorder.resume()
  }
}

async function doOpen(): Promise<void> {
  if (activeTab().state === AppState.Recording && recorder.frameCount > 0) {
    const save = confirm('Save current recording before opening?')
    if (save) {
      await doSave()
      if (activeTab().state === AppState.Recording) return
      await new Promise<void>(resolve => setTimeout(resolve, 400))
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
    tabs = doc.tabs.map(t => ({
      id: t.id,
      name: t.name,
      editorHtml: t.editorHtml,
      state: (t.recording !== null || loadedSession !== null) ? AppState.Recorded : AppState.Idle,
      loadedRecording: t.recording,
      fontSizeRem: 1.2,
      pendingFontSize: null,
      pendingFontFamily: null,
      savedRange: null,
      fontFamily: t.fontFamily ?? 'serif',
    }))

    tabSeq = Math.max(tabSeq, tabs.length)

    const activeIdx = tabs.findIndex(t => t.id === doc.activeTabId)
    activeTabIndex = activeIdx >= 0 ? activeIdx : 0

    const tab = activeTab()
    writeArea.innerHTML = tab.editorHtml
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
  // Active-document scope: prefer the tab's own recording; fall back to the session.
  const tabRec = activeTab().loadedRecording
  const rec = tabRec ?? sessionRecording
  if (!rec) {
    showToast('Save or record before exporting', 'error')
    return
  }

  // Reproduce the exact end-of-replay colored state via a throwaway Player on a
  // detached element, so the PDF matches what the replay shows.
  const scratch = document.createElement('div')
  const exporter = new Player(scratch, { speedMultiplier: 1, maxGapMs: 3000 })
  exporter.load(rec, tabRec ? undefined : (sessionStartTabId ?? undefined))
  exporter.skipToEnd()
  const history = exporter.getHistory()

  const title = rec.meta.title || titleFromText(textFromHtml(lastFrameHtml(rec))) || 'Untitled document'
  const safeName = (title || 'graphine-document').replace(/[/\\:*?"<>|]/g, '-').slice(0, 80)
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
  sessionRecording = null
  sessionStartTabId = null
  tabs = [createTab('Tab 1')]
  tabSeq = 1
  activeTabIndex = 0

  // Reset all font/selection state to the fresh tab's defaults, matching what
  // switchActiveTab/doCloseTab do when moving between tabs.
  currentFontSizeRem = activeTab().fontSizeRem
  pendingFontSize = null
  pendingFontFamily = null
  savedRange = null
  fontSizeInput.value = String(Math.round(currentFontSizeRem * 10))

  writeArea.innerHTML = ''
  replayArea.innerHTML = ''
  writeArea.contentEditable = 'true'
  writeArea.focus()

  syncFontSelect(activeTab().fontFamily)
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
  activeTab().editorHtml = writeArea.innerHTML
  activeTab().fontSizeRem = currentFontSizeRem
  tabs.push(createTab(`Tab ${++tabSeq}`))
  switchActiveTab(tabs.length - 1)
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
    writeArea.innerHTML = incoming.editorHtml
    replayArea.innerHTML = ''
    currentFontSizeRem = incoming.fontSizeRem
    pendingFontSize = incoming.pendingFontSize
    pendingFontFamily = incoming.pendingFontFamily
    savedRange = incoming.savedRange
    fontSizeInput.value = String(Math.round(currentFontSizeRem * 10))
    syncFontSelect(incoming.fontFamily)

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

  outgoing.editorHtml = writeArea.innerHTML
  outgoing.fontSizeRem = currentFontSizeRem
  outgoing.pendingFontSize = pendingFontSize
  outgoing.pendingFontFamily = pendingFontFamily
  outgoing.savedRange = savedRange
  outgoing.fontFamily = fontFamilySelect.value

  activeTabIndex = toIndex
  const incoming = activeTab()

  writeArea.innerHTML = incoming.editorHtml
  replayArea.innerHTML = ''

  if (outgoing.state === AppState.Recording) {
    recorder.captureNow(true)  // baseline frame for incoming tab — resets diff anchor
    incoming.state = AppState.Recording
  }
  currentFontSizeRem = incoming.fontSizeRem
  pendingFontSize = incoming.pendingFontSize
  pendingFontFamily = incoming.pendingFontFamily
  savedRange = incoming.savedRange
  fontSizeInput.value = String(Math.round(currentFontSizeRem * 10))
  syncFontSelect(incoming.fontFamily)

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

  writeArea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
}

function applyFontSize(targetRem: number): void {
  currentFontSizeRem = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(targetRem * 10) / 10))
  fontSizeInput.value = String(Math.round(currentFontSizeRem * 10))

  const sel = window.getSelection()
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
  const inWriteArea = range && writeArea.contains(range.commonAncestorContainer)

  if (range && !range.collapsed && inWriteArea) {
    const fragment = range.extractContents()
    const span = document.createElement('span')
    span.style.fontSize = `${currentFontSizeRem}rem`
    span.appendChild(fragment)
    range.insertNode(span)
    const newRange = document.createRange()
    newRange.selectNodeContents(span)
    sel!.removeAllRanges()
    sel!.addRange(newRange)
    if (activeTab().state === AppState.Recording) recorder.captureNow()
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
syncFontSelect(activeTab().fontFamily)
setupMinimap(writeScroll, writeArea, minimapCanvas)

document.execCommand('defaultParagraphSeparator', false, 'br')

if (window.electronAPI.platform === 'darwin') {
  document.body.dataset.platform = 'darwin'
}

window.electronAPI.onFullscreenChange((isFullscreen) => {
  document.body.dataset.fullscreen = String(isFullscreen)
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

writeArea.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((pendingFontSize !== null || pendingFontFamily !== null) && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
    e.preventDefault()
    insertCharWithStyles(e.key, pendingFontSize, pendingFontFamily)
    pendingFontSize = null
    pendingFontFamily = null
    return
  }
  if (!(e.metaKey || e.ctrlKey)) return
  if (e.key === 'b') {
    e.preventDefault()
    document.execCommand('bold')
  } else if (e.key === 'i') {
    e.preventDefault()
    document.execCommand('italic')
  }
})

// Paste as plain text so line breaks become literal '\n' text nodes (matching
// typed Enter under white-space: pre-wrap) instead of Chromium's default <br>/div
// HTML — which double-counts breaks on replay (innerText sees both \n and <br>).
writeArea.addEventListener('paste', (e: ClipboardEvent) => {
  e.preventDefault()
  const text = e.clipboardData?.getData('text/plain') ?? ''
  if (!text) return
  const normalized = text.replace(/\r\n?/g, '\n')

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

  writeArea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }))
})

btnStopSave.addEventListener('click', doSave)
btnOpenHeader.addEventListener('click', doOpen)
btnNew.addEventListener('click', doNew)
document.getElementById('btn-save-for-replay')!.addEventListener('click', doSave)
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
  activeTabIndex = startIdx
  writeArea.innerHTML = activeTab().editorHtml
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
    const fragment = rangeToUse.extractContents()
    const span = document.createElement('span')
    span.style.fontFamily = css
    span.appendChild(fragment)
    rangeToUse.insertNode(span)
    const newRange = document.createRange()
    newRange.selectNodeContents(span)
    const sel = window.getSelection()
    if (sel) { sel.removeAllRanges(); sel.addRange(newRange) }
    if (activeTab().state === AppState.Recording) recorder.captureNow()
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

speedBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const speed = parseFloat(btn.dataset.speed ?? '1')
    player.setOptions({ speedMultiplier: speed })
    speedBtns.forEach((b) => {
      b.classList.toggle('active', b === btn)
      b.setAttribute('aria-pressed', String(b === btn))
    })
  })
})
