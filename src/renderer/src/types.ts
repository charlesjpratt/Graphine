export interface FrameDelta {
  p: number;  // common-prefix length
  r: number;  // chars removed after the prefix
  i: string;  // inserted substring
}

export interface Frame {
  t: number;
  v?: string;        // full-HTML keyframe (first frame, baseline, tab-switch, legacy v1)
  d?: FrameDelta;    // delta against previously reconstructed HTML
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
