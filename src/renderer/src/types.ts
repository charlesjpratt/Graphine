export interface Frame {
  t: number;
  v: string;
}

export interface RecordingMeta {
  title: string;
  createdAt: string;
  durationMs: number;
  frameCount: number;
}

export interface Recording {
  version: 1;
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
  version: 2
  tabs: Tab[]
  activeTabId: string
}

export interface TabRuntime {
  id: string
  name: string
  editorHtml: string
  state: AppState
  loadedRecording: Recording | null
  pendingPartialRecording: Recording | null
  fontSizeRem: number
  pendingFontSize: number | null
  savedRange: Range | null
  fontFamily: string
}
