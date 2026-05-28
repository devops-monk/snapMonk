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

export type RecordingMode = 'tab' | 'desktop' | 'window' | 'camera';
export type RecordingFormat = 'webm' | 'mp4';
export type RecordingResolution = '480p' | '720p' | '1080p' | '2k' | '4k';

export interface RecordingOptions {
  mode: RecordingMode;
  webcam: boolean;
  mic: boolean;
  format: RecordingFormat;
  resolution: RecordingResolution;
  systemAudio: boolean;
  countdownSeconds: number;
  cameraDeviceId?: string;
  micDeviceId?: string;
}

export interface RecorderMessage {
  action: 'beginRecording' | 'stopRecording';
  options?: RecordingOptions;
  startTime?: number;
}

export interface PendingRecording {
  id: string;
  blob: Blob;
  mimeType: string;
  createdAt: number;
  duration: number;
}

export interface RecordingStateMessage {
  action: 'recordingStarted' | 'recordingStopped' | 'recordingError';
  error?: string;
}
