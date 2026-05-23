export type CaptureType = 'visible' | 'region' | 'fullpage' | 'element';

export interface SliceMeta {
  requestedY: number;
  actualY: number;
}

export interface PageInfo {
  scrollHeight: number;
  viewportHeight: number;
  viewportWidth: number;
  devicePixelRatio: number;
  sliceMeta: SliceMeta[];
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface CaptureMeta {
  url: string;
  title: string;
  timestamp: number;
  pageInfo?: PageInfo;
  crop?: CropRect;
}

export interface CaptureRecord {
  id: string;
  type: CaptureType;
  slices: Blob[];
  metadata: CaptureMeta;
}

export type CaptureAction =
  | 'captureVisible'
  | 'captureFullPage'
  | 'captureRegion'
  | 'captureElement';

export interface PopupMessage {
  action: CaptureAction;
  tabId: number;
  windowId: number;
}

export interface RegionSelectedMessage {
  action: 'regionSelected';
  rect: CropRect;
}

export interface ElementSelectedMessage {
  action: 'elementSelected';
  rect: CropRect;
}

export interface OverlayMessage {
  action: 'showRegionOverlay' | 'showElementPicker' | 'cancelOverlay';
}

export type ContentMessage = OverlayMessage | RecorderMessage;
export type BackgroundMessage = RegionSelectedMessage | ElementSelectedMessage;

// ─── Recording ───────────────────────────────────────────────────────────────

export type RecordingMode = 'tab' | 'desktop' | 'window';
export type RecordingFormat = 'webm' | 'mp4';

export interface RecordingOptions {
  mode: RecordingMode;
  webcam: boolean;
  mic: boolean;
  format: RecordingFormat;
}

export interface RecorderMessage {
  action: 'beginRecording' | 'stopRecording';
  options?: RecordingOptions;
}

export interface RecordingStateMessage {
  action: 'recordingStarted' | 'recordingStopped' | 'recordingError';
  error?: string;
}
