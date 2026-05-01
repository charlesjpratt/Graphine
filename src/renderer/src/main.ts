import { Recorder } from './recorder'
import { Player } from './player'
import { switchView, applyState, updateProgress, showToast, setupInactivityHiding, updateStats } from './ui'
import { AppState } from './types'
import type { Recording, TabRuntime, GraphineDocument } from './types'
import { createTab, renderTabBar, startRename } from './tabs'
import { setupMinimap } from './minimap'

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
let currentFilePath: string | null = null

const activeTab = () => tabs[activeTabIndex]

player.onProgress((index, total) => updateProgress(index, total))
player.onStats((typed, pasted, overwrite) => updateStats(typed, pasted, overwrite))
player.onComplete(() => {
  transition(AppState.Recorded)
  showToast('Playback complete')
})

function updateReplayAvailable(): void {
  document.body.dataset.replayAvailable = activeTab().loadedRecording !== null ? 'true' : 'false'
}

function transition(next: AppState): void {
  activeTab().state = next
  applyState(next)

  const hasRecording = activeTab().loadedRecording !== null
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
  const frames = [...base.frames, ...append.frames]
  const lastFrame = frames[frames.length - 1]
  const firstLine = textFromHtml(lastFrame.v).split('\n')[0].trim()
  return {
    version: 1,
    meta: {
      title: firstLine.slice(0, 80),
      createdAt: base.meta.createdAt,
      durationMs: base.meta.durationMs + append.meta.durationMs,
      frameCount: frames.length,
    },
    frames,
  }
}

function wrapV1AsDocument(recording: Recording): GraphineDocument {
  const id = crypto.randomUUID()
  return {
    version: 2,
    tabs: [{
      id,
      name: recording.meta.title ? recording.meta.title.slice(0, 20) : 'Tab 1',
      editorHtml: recording.frames.at(-1)?.v ?? '',
      recording,
    }],
    activeTabId: id,
  }
}

function buildDocumentPayload(): GraphineDocument {
  activeTab().editorHtml = writeArea.innerHTML
  return {
    version: 2,
    tabs: tabs.map(t => ({
      id: t.id,
      name: t.name,
      editorHtml: t.editorHtml,
      recording: t.loadedRecording,
      fontFamily: t.fontFamily,
    })),
    activeTabId: activeTab().id,
  }
}

const tabBarCallbacks = {
  onSwitch: (index: number) => switchActiveTab(index),
  onClose: (tabId: string) => doCloseTab(tabId),
  onRename: (tabId: string, labelEl: HTMLSpanElement) => {
    startRename(tabId, labelEl, (id, newName) => {
      const t = tabs.find(t => t.id === id)
      if (t) {
        t.name = newName
        // Re-render so the tab shows the new name even if renderTabBar isn't called
      }
    })
  },
}

async function doSave(): Promise<void> {
  const tab = activeTab()
  const newRecording = recorder.stop()

  let tabRecording: Recording | null = tab.loadedRecording
  if (tab.pendingPartialRecording) {
    tabRecording = tabRecording
      ? mergeRecording(tabRecording, tab.pendingPartialRecording)
      : tab.pendingPartialRecording
  }
  if (newRecording.frames.length > 0) {
    tabRecording = tabRecording
      ? mergeRecording(tabRecording, newRecording)
      : newRecording
  }

  const hasAnyContent = tabRecording !== null
    || tabs.some((t, i) => i !== activeTabIndex && t.loadedRecording !== null)
  if (!hasAnyContent) {
    showToast('Nothing recorded yet', 'error')
    recorder.start()
    return
  }

  // Temporarily update tab for payload building; revert on failure
  const prevLoaded = tab.loadedRecording
  const prevPending = tab.pendingPartialRecording
  tab.loadedRecording = tabRecording
  tab.pendingPartialRecording = null
  tab.editorHtml = writeArea.innerHTML

  const json = JSON.stringify(buildDocumentPayload(), null, 2)

  try {
    if (currentFilePath) {
      await window.electronAPI.writeToPath(currentFilePath, json)
      updateReplayAvailable()
      transition(AppState.Recorded)
      showToast(`Saved to ${currentFilePath.split('/').pop()}`)
    } else {
      const refRecording = tabRecording ?? tabs.find(t => t.loadedRecording !== null)?.loadedRecording
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
        tab.loadedRecording = prevLoaded
        tab.pendingPartialRecording = prevPending
        recorder.start()
      }
    }
  } catch {
    tab.loadedRecording = prevLoaded
    tab.pendingPartialRecording = prevPending
    showToast('Failed to save recording', 'error')
    recorder.start()
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
    showToast(err instanceof Error ? err.message : 'Failed to open recording', 'error')
    return
  }
  if (!result) return

  try {
    const data = JSON.parse(result.content) as { version?: unknown; frames?: unknown; tabs?: unknown }

    let doc: GraphineDocument
    if (data.version === 1 && Array.isArray(data.frames)) {
      doc = wrapV1AsDocument(data as Recording)
    } else if (data.version === 2 && Array.isArray(data.tabs)) {
      doc = data as GraphineDocument
    } else {
      showToast('Invalid recording file', 'error')
      return
    }

    currentFilePath = result.filePath
    tabs = doc.tabs.map(t => ({
      id: t.id,
      name: t.name,
      editorHtml: t.editorHtml,
      state: t.recording ? AppState.Recorded : AppState.Idle,
      loadedRecording: t.recording,
      pendingPartialRecording: null,
      fontSizeRem: 1.2,
      pendingFontSize: null,
      savedRange: null,
      fontFamily: t.fontFamily ?? 'serif',
    }))

    const activeIdx = tabs.findIndex(t => t.id === doc.activeTabId)
    activeTabIndex = activeIdx >= 0 ? activeIdx : 0

    const tab = activeTab()
    writeArea.innerHTML = tab.editorHtml
    replayArea.innerHTML = ''

    if (tab.loadedRecording) {
      player.load(tab.loadedRecording)
      updateProgress(0, tab.loadedRecording.frames.length)
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

function doNew(): void {
  const hasUnsaved = tabs.some(t => t.pendingPartialRecording !== null)
    || (activeTab().state === AppState.Recording && recorder.frameCount > 0)

  if (hasUnsaved) {
    if (!confirm('Discard unsaved recording and start a new document?')) return
  }

  if (activeTab().state === AppState.Recording) recorder.reset()
  else if (activeTab().state === AppState.Playing || activeTab().state === AppState.Paused) player.stop()

  currentFilePath = null
  tabs = [createTab('Tab 1')]
  activeTabIndex = 0
  pendingFontFamily = null

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
  activeTab().editorHtml = writeArea.innerHTML
  activeTab().fontSizeRem = currentFontSizeRem
  const tabNumber = tabs.length + 1
  tabs.push(createTab(`Tab ${tabNumber}`))
  switchActiveTab(tabs.length - 1)
}

function doCloseTab(tabId: string): void {
  if (tabs.length <= 1) return

  const idx = tabs.findIndex(t => t.id === tabId)
  if (idx === -1) return

  const tab = tabs[idx]
  const isDirty = (idx === activeTabIndex && tab.state === AppState.Recording && recorder.frameCount > 0)
    || tab.pendingPartialRecording !== null
  if (isDirty && !confirm(`Close "${tab.name}" and discard unsaved changes?`)) return

  if (idx === activeTabIndex) {
    const targetIdx = idx > 0 ? idx - 1 : 1

    if (tab.state === AppState.Recording) recorder.reset()
    else if (tab.state === AppState.Playing || tab.state === AppState.Paused) player.stop()

    tabs.splice(idx, 1)
    activeTabIndex = Math.min(targetIdx, tabs.length - 1)

    const incoming = activeTab()
    writeArea.innerHTML = incoming.editorHtml
    replayArea.innerHTML = ''
    currentFontSizeRem = incoming.fontSizeRem
    pendingFontSize = incoming.pendingFontSize
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

  if (outgoing.state === AppState.Recording) {
    const partial = recorder.stop()
    if (partial.frames.length > 0) {
      outgoing.pendingPartialRecording = outgoing.pendingPartialRecording
        ? mergeRecording(outgoing.pendingPartialRecording, partial)
        : partial
    }
    outgoing.state = AppState.Idle
  } else if (outgoing.state === AppState.Playing || outgoing.state === AppState.Paused) {
    player.stop()
    outgoing.state = AppState.Recorded
  }

  outgoing.editorHtml = writeArea.innerHTML
  outgoing.fontSizeRem = currentFontSizeRem
  outgoing.pendingFontSize = pendingFontSize
  outgoing.savedRange = savedRange
  outgoing.fontFamily = fontFamilySelect.value

  activeTabIndex = toIndex
  const incoming = activeTab()

  writeArea.innerHTML = incoming.editorHtml
  replayArea.innerHTML = ''
  currentFontSizeRem = incoming.fontSizeRem
  pendingFontSize = incoming.pendingFontSize
  savedRange = incoming.savedRange
  fontSizeInput.value = String(Math.round(currentFontSizeRem * 10))
  syncFontSelect(incoming.fontFamily)

  if (incoming.loadedRecording) {
    player.load(incoming.loadedRecording)
    updateProgress(0, incoming.loadedRecording.frames.length)
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
    case 'new': doNew(); break
    case 'view:write': switchView('write'); break
    case 'view:replay': switchView('replay'); break
    case 'font:increase': applyFontSizeChange(FONT_STEP); break
    case 'font:decrease': applyFontSizeChange(-FONT_STEP); break
  }
})

// ── Write controls ────────────────────────────────────────────────────────────

writeArea.addEventListener('input', () => {
  if (activeTab().state === AppState.Idle || activeTab().state === AppState.Recorded) {
    recorder.start()
    recorder.captureNow()
    transition(AppState.Recording)
  }
})

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

btnPlayPause.addEventListener('click', () => {
  if (activeTab().state === AppState.Recorded) {
    if (activeTab().loadedRecording) {
      player.load(activeTab().loadedRecording!)
      replayArea.innerHTML = ''
      updateProgress(0, activeTab().loadedRecording!.frames.length)
    }
    transition(AppState.Playing)
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
  if (activeTab().state === AppState.Recorded && activeTab().loadedRecording) {
    player.load(activeTab().loadedRecording!)
    replayArea.innerHTML = ''
    updateProgress(0, activeTab().loadedRecording!.frames.length)
    transition(AppState.Playing)
  }
  player.skipToEnd()
})

// ── Format toolbar ────────────────────────────────────────────────────────────

btnBold.addEventListener('mousedown', (e) => { e.preventDefault(); document.execCommand('bold') })
btnItalic.addEventListener('mousedown', (e) => { e.preventDefault(); document.execCommand('italic') })

fontFamilySelect.addEventListener('mousedown', () => {
  const sel = window.getSelection()
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0)
    if (writeArea.contains(range.commonAncestorContainer)) {
      savedRange = range.cloneRange()
      showSelectionOverlay()
    }
  }
})

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

fontSizeInput.addEventListener('mousedown', () => {
  const sel = window.getSelection()
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0)
    if (writeArea.contains(range.commonAncestorContainer)) {
      savedRange = range.cloneRange()
      showSelectionOverlay()
    }
  }
})

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

fontSizeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    const val = parseInt(fontSizeInput.value, 10)
    restoreWriteAreaCursor()
    if (!isNaN(val)) applyFontSize(val / 10)
  } else if (e.key === 'Escape') {
    fontSizeInput.value = String(Math.round(currentFontSizeRem * 10))
    restoreWriteAreaCursor()
  }
})
fontSizeInput.addEventListener('blur', () => {
  clearSelectionOverlay()
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
