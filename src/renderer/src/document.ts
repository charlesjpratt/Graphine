import type { Recording, GraphineDocument } from './types'
import { lastFrameHtml, titleFromText } from './frameCodec'

// Last path segment, handling both separators (Electron gives us native paths).
export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

export function buildDefaultName(createdAt: string): string {
  const d = new Date(createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `graphine-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.grph`
}

export function textFromHtml(html: string): string {
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  return tmp.textContent ?? ''
}

export function mergeRecording(base: Recording, append: Recording): Recording {
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

export function wrapV1AsDocument(recording: Recording): GraphineDocument {
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
