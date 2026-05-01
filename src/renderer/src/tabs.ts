import { AppState } from './types'
import type { TabRuntime } from './types'

export function createTab(name?: string): TabRuntime {
  return {
    id: crypto.randomUUID(),
    name: name ?? 'Tab 1',
    editorHtml: '',
    state: AppState.Idle,
    loadedRecording: null,
    pendingPartialRecording: null,
    fontSizeRem: 1.2,
    pendingFontSize: null,
    savedRange: null,
    fontFamily: 'serif',
  }
}

export function renderTabBar(
  tabs: TabRuntime[],
  activeId: string,
  container: HTMLElement,
  callbacks: {
    onSwitch: (index: number) => void
    onClose: (tabId: string) => void
    onRename: (tabId: string, labelEl: HTMLSpanElement) => void
  }
): void {
  for (const el of Array.from(container.querySelectorAll('.doc-tab'))) {
    el.remove()
  }

  tabs.forEach((tab, index) => {
    const btn = document.createElement('button')
    btn.className = 'doc-tab'
    btn.setAttribute('role', 'tab')
    btn.dataset.tabId = tab.id
    btn.setAttribute('aria-selected', String(tab.id === activeId))

    const label = document.createElement('span')
    label.className = 'doc-tab-label'
    label.textContent = tab.name

    const closeBtn = document.createElement('span')
    closeBtn.className = 'doc-tab-close'
    closeBtn.setAttribute('aria-label', 'Close tab')
    closeBtn.setAttribute('role', 'button')
    closeBtn.tabIndex = 0
    closeBtn.textContent = '×'

    btn.appendChild(label)
    btn.appendChild(closeBtn)

    btn.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.doc-tab-close')) return
      callbacks.onSwitch(index)
    })

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      callbacks.onClose(tab.id)
    })
    closeBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        callbacks.onClose(tab.id)
      }
    })

    btn.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.doc-tab-close')) return
      callbacks.onRename(tab.id, label)
    })

    container.appendChild(btn)
  })
}

export function startRename(
  tabId: string,
  labelEl: HTMLSpanElement,
  onCommit: (tabId: string, newName: string) => void
): void {
  const originalName = labelEl.textContent ?? ''
  const input = document.createElement('input')
  input.className = 'doc-tab-rename-input'
  input.value = originalName

  labelEl.replaceWith(input)
  input.focus()
  input.select()

  let committed = false

  const commit = () => {
    if (committed) return
    committed = true
    const newName = input.value.trim() || originalName
    const span = document.createElement('span')
    span.className = 'doc-tab-label'
    span.textContent = newName
    input.replaceWith(span)
    onCommit(tabId, newName)
  }

  const cancel = () => {
    if (committed) return
    committed = true
    const span = document.createElement('span')
    span.className = 'doc-tab-label'
    span.textContent = originalName
    input.replaceWith(span)
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit() }
    else if (e.key === 'Escape') { e.preventDefault(); cancel() }
  })
  input.addEventListener('blur', commit)
}
