import type { Frame, FrameDelta, Recording } from './types'

// ── Frame delta codec ──────────────────────────────────────────────────────────
//
// Frames are stored as either a full-HTML "keyframe" (Frame.v) or a delta against
// the previously reconstructed HTML (Frame.d). Keyframes are emitted for the first
// frame of a recording and for baseline/tab-switch frames; everything else is a
// small delta. This keeps a large paste stored once instead of once per edit frame.

// Common-prefix/suffix diff: p = shared prefix length, r = chars removed after the
// prefix, i = inserted substring. Reconstruct via prev.slice(0,p) + i + prev.slice(p+r).
export function buildDelta(prevHtml: string, currHtml: string): FrameDelta {
  let p = 0
  while (p < prevHtml.length && p < currHtml.length && prevHtml[p] === currHtml[p]) p++
  let prevEnd = prevHtml.length
  let currEnd = currHtml.length
  while (prevEnd > p && currEnd > p && prevHtml[prevEnd - 1] === currHtml[currEnd - 1]) {
    prevEnd--
    currEnd--
  }
  return { p, r: prevEnd - p, i: currHtml.slice(p, currEnd) }
}

export function applyDelta(prevHtml: string, d: FrameDelta): string {
  return prevHtml.slice(0, d.p) + d.i + prevHtml.slice(d.p + d.r)
}

// Reconstruct a frame's full HTML given the previously reconstructed HTML.
// Keyframes are self-contained; deltas apply onto prevHtml.
export function frameToHtml(frame: Frame, prevHtml: string): string {
  return frame.v != null ? frame.v : applyDelta(prevHtml, frame.d ?? { p: 0, r: 0, i: '' })
}

// Reconstruct the final frame's full HTML by walking forward from the nearest
// preceding keyframe. Keyframes are sparse, so this scans only a short tail.
export function lastFrameHtml(recording: Recording): string {
  const frames = recording.frames
  if (frames.length === 0) return ''
  let start = frames.length - 1
  while (start > 0 && frames[start].v == null) start--
  let html = ''
  for (let i = start; i < frames.length; i++) html = frameToHtml(frames[i], html)
  return html
}
