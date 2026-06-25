import type { Frame, FrameDelta, Recording } from './types'

// ── Frame delta codec ──────────────────────────────────────────────────────────
//
// Frames are stored as either a full-HTML "keyframe" (Frame.v) or a delta against
// the previously reconstructed HTML (Frame.d). Keyframes are emitted for the first
// frame of a recording and for baseline/tab-switch frames; everything else is a
// small delta. This keeps a large paste stored once instead of once per edit frame.

// Common-prefix/suffix diff. prefixLen = shared leading chars; prevEnd/currEnd mark
// where the shared trailing run begins in each string. The changed span is
// prev[prefixLen..prevEnd) replaced by curr[prefixLen..currEnd).
export function diffRange(
  prev: string,
  curr: string,
): { prefixLen: number; prevEnd: number; currEnd: number } {
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
  return { prefixLen, prevEnd, currEnd }
}

// p = shared prefix length, r = chars removed after the prefix, i = inserted substring.
// Reconstruct via prev.slice(0,p) + i + prev.slice(p+r).
export function buildDelta(prevHtml: string, currHtml: string): FrameDelta {
  const { prefixLen, prevEnd, currEnd } = diffRange(prevHtml, currHtml)
  return { p: prefixLen, r: prevEnd - prefixLen, i: currHtml.slice(prefixLen, currEnd) }
}

export function applyDelta(prevHtml: string, d: FrameDelta): string {
  return prevHtml.slice(0, d.p) + d.i + prevHtml.slice(d.p + d.r)
}

// A recording's title is its first non-empty line, capped at 80 chars.
export function titleFromText(text: string): string {
  return text.split('\n')[0].trim().slice(0, 80)
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
