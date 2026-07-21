export interface FrameDelta {
  p: number;  // common-prefix length
  r: number;  // chars removed after the prefix
  i: string;  // inserted substring
}

// The user's intent behind a delta frame, recorded from the native InputEvent.inputType
// at capture time. Replay reads this to classify provenance (typed/pasted/overwrite/move)
// directly instead of inferring it from before/after snapshots. Optional: frames recorded
// before intent existed (and structural keyframes) carry none, and replay falls back to the
// size-based heuristic for those.
//   type       — insertText / paragraph / line break: ordinary typing
//   paste      — insertFromPaste: bulk insert from the clipboard
//   drop       — insertFromDrop: text relocated by a drag-move (never an overwrite)
//   replace    — insertReplacementText: e.g. autocorrect swapping a word in place
//   deleteEdit — deleteContentBackward/Forward, deleteWord*: a backspace-style correction
//   deleteCut  — deleteByCut / deleteByDrag: a structural removal, not a correction
//   format     — formatBold/Italic/etc: styling change, no text added or removed
export type EditIntent =
  | 'type'
  | 'paste'
  | 'drop'
  | 'replace'
  | 'deleteEdit'
  | 'deleteCut'
  | 'format';

export interface Frame {
  t: number;
  v?: string;        // full-HTML keyframe (first frame, baseline, tab-switch, legacy v1)
  d?: FrameDelta;    // delta against previously reconstructed HTML
  intent?: EditIntent;  // recorded edit intent for this delta (absent on legacy/keyframes)
  tabSwitch?: { toTabId: string; toTabName: string };
  baseline?: boolean;
}

export interface RecordingMeta {
  title: string;
  createdAt: string;
  durationMs: number;
  frameCount: number;
}

export interface Recording {
  version: 1 | 2;
  meta: RecordingMeta;
  frames: Frame[];
}

export const enum AppState {
  Idle = 'idle',
  Recording = 'recording',
  Recorded = 'recorded',
  Playing = 'playing',
  Paused = 'paused',
}

export interface PlaybackOptions {
  speedMultiplier: number;
  maxGapMs: number;
}

export interface Tab {
  id: string
  name: string
  editorHtml: string
  recording: Recording | null
  fontFamily?: string
}

export interface GraphineDocument {
  version: 3
  tabs: Tab[]
  activeTabId: string
  sessionRecording: Recording | null
  sessionStartTabId?: string
}

export interface TabRuntime {
  id: string
  name: string
  editorHtml: string
  state: AppState
  loadedRecording: Recording | null
  fontSizeRem: number
  pendingFontSize: number | null
  pendingFontFamily: string | null
  fontFamily: string
}
