import { AppState } from './types'
import { basename } from './document'

let toastTimeout: ReturnType<typeof setTimeout> | null = null
let inactivityTimeout: ReturnType<typeof setTimeout> | null = null

export function switchView(view: 'write' | 'replay'): void {
  document.body.dataset.view = view

  const writeTab = document.getElementById('tab-write')!
  const replayTab = document.getElementById('tab-replay')!
  const writeView = document.getElementById('write-view')!
  const replayView = document.getElementById('replay-view')!

  const isWrite = view === 'write'
  writeTab.classList.toggle('active', isWrite)
  replayTab.classList.toggle('active', !isWrite)
  writeTab.setAttribute('aria-pressed', String(isWrite))
  replayTab.setAttribute('aria-pressed', String(!isWrite))
  writeView.setAttribute('aria-hidden', String(!isWrite))
  replayView.setAttribute('aria-hidden', String(isWrite))

  resetInactivityTimer()
}

export function applyState(state: AppState): void {
  document.body.dataset.state = state
}

export function updateProgress(index: number, total: number): void {
  const pct = total > 0 ? Math.round((index / total) * 100) : 0
  const bar = document.getElementById('progress-bar')!
  const container = document.getElementById('progress-container')!
  bar.style.width = `${pct}%`
  container.setAttribute('aria-valuenow', String(pct))
}

export function showToast(message: string, type: 'success' | 'error' = 'success'): void {
  const toast = document.getElementById('toast')!
  toast.textContent = message
  toast.className = `visible ${type}`

  if (toastTimeout) clearTimeout(toastTimeout)
  toastTimeout = setTimeout(() => {
    toast.className = ''
    toast.textContent = ''
  }, 3000)
}

// Badge at the top of the writing column: the open file's name, or "Untitled" until it has
// one on disk, with a dot while the in-memory document is ahead of the saved copy.
export function setDocTitle(filePath: string | null, dirty: boolean): void {
  const badge = document.getElementById('doc-badge')!
  const name = document.getElementById('doc-badge-name')!

  name.textContent = filePath ? basename(filePath) : 'Untitled'
  badge.classList.toggle('untitled', filePath === null)
  badge.classList.toggle('dirty', dirty)
}

export function updateStats(typed: number, pasted: number, overwrite: number): void {
  const stats = document.getElementById('char-stats')!
  const total = typed + pasted + overwrite

  if (total === 0) {
    stats.classList.remove('has-data')
    return
  }

  stats.classList.add('has-data')
  document.getElementById('seg-typed')!.style.width = `${(typed / total) * 100}%`
  document.getElementById('seg-pasted')!.style.width = `${(pasted / total) * 100}%`
  document.getElementById('seg-overwrite')!.style.width = `${(overwrite / total) * 100}%`

  const pct = (n: number) => `${Math.round((n / total) * 100)}%`
  document.getElementById('stat-typed-val')!.textContent = typed > 0 ? `typed ${pct(typed)}` : ''
  document.getElementById('stat-pasted-val')!.textContent = pasted > 0 ? `pasted ${pct(pasted)}` : ''
  document.getElementById('stat-overwrite-val')!.textContent = overwrite > 0 ? `overwrite ${pct(overwrite)}` : ''
}

export function setupInactivityHiding(): void {
  const events = ['mousemove', 'keydown', 'mousedown', 'touchstart']
  for (const evt of events) {
    document.addEventListener(evt, resetInactivityTimer, { passive: true })
  }
  resetInactivityTimer()
}

function resetInactivityTimer(): void {
  document.body.classList.remove('controls-hidden')
  if (inactivityTimeout) clearTimeout(inactivityTimeout)
  inactivityTimeout = setTimeout(() => {
    if (document.body.dataset.view === 'write') {
      document.body.classList.add('controls-hidden')
    }
  }, 2000)
}
