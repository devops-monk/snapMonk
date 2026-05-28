import type { RecorderMessage, RecordingOptions } from '../utils/types';

// Guard: only inject once
if (!(window as unknown as Record<string, boolean>)['__snapmonk_recorder__']) {
  (window as unknown as Record<string, boolean>)['__snapmonk_recorder__'] = true;
  initRecorder();
}

// ─── State ────────────────────────────────────────────────────────────────────

interface RecorderState {
  mediaRecorder: MediaRecorder | null;
  screenStream: MediaStream | null;
  webcamStream: MediaStream | null;
  micStream: MediaStream | null;
  audioCtx: AudioContext | null;
  chunks: Blob[];
  startTime: number;
  pausedAt: number;
  totalPausedMs: number;
  timerInterval: ReturnType<typeof setInterval> | null;
  isPaused: boolean;
  options: RecordingOptions | null;
}

const rec: RecorderState = {
  mediaRecorder: null,
  screenStream: null,
  webcamStream: null,
  micStream: null,
  audioCtx: null,
  chunks: [],
  startTime: 0,
  pausedAt: 0,
  totalPausedMs: 0,
  timerInterval: null,
  isPaused: false,
  options: null,
};

// ─── Message listener ─────────────────────────────────────────────────────────

function initRecorder() {
  chrome.runtime.onMessage.addListener((msg: RecorderMessage, _sender, sendResponse) => {
    if (msg.action === 'beginRecording' && msg.options) {
      startRecording(msg.options, msg.startTime)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    if (msg.action === 'stopRecording') {
      stopRecording();
      sendResponse({ ok: true });
    }
  });
}

// ─── Start Recording ──────────────────────────────────────────────────────────

async function startRecording(options: RecordingOptions, passedStartTime?: number): Promise<void> {
  rec.options = options;

  // Request mic and webcam BEFORE the countdown and screen picker so that:
  // 1. The user gesture from "Start Recording" is still live for getUserMedia
  // 2. The webcam bubble can appear immediately once recording begins
  // 3. Permission failures surface before we enter the countdown
  // Resolution → pixel dimensions
  const RES_MAP: Record<string, { w: number; h: number }> = {
    '480p': { w: 854, h: 480 },
    '720p': { w: 1280, h: 720 },
    '1080p': { w: 1920, h: 1080 },
    '2k': { w: 2560, h: 1440 },
    '4k': { w: 3840, h: 2160 },
  };
  const resDims = RES_MAP[options.resolution ?? '1080p'] ?? { w: 1920, h: 1080 };

  if (options.mic) {
    try {
      const micConstraints: MediaStreamConstraints = {
        audio: options.micDeviceId ? { deviceId: { exact: options.micDeviceId } } : true,
        video: false,
      };
      rec.micStream = await navigator.mediaDevices.getUserMedia(micConstraints);
    } catch {
      rec.micStream = null;
    }
  }

  if (options.webcam || options.mode === 'camera') {
    try {
      const camConstraints: MediaTrackConstraints = {
        width: { ideal: resDims.w },
        height: { ideal: resDims.h },
        facingMode: options.mode === 'camera' ? 'user' : 'user',
        ...(options.cameraDeviceId ? { deviceId: { exact: options.cameraDeviceId } } : {}),
      };
      rec.webcamStream = await navigator.mediaDevices.getUserMedia({
        video: camConstraints,
        audio: false,
      });
    } catch {
      rec.webcamStream = null;
    }
  }

  if (options.countdownSeconds > 0) {
    await showCountdown(options.countdownSeconds);
  }

  // Camera-only mode — record directly from webcam, no screen capture needed
  if (options.mode === 'camera') {
    if (!rec.webcamStream) {
      rec.micStream?.getTracks().forEach(t => t.stop());
      rec.micStream = null;
      return;
    }
    rec.screenStream = rec.webcamStream;
    rec.webcamStream = null;
  } else {
    // Map the user's mode choice to Chrome's displaySurface hint
    const displaySurface = options.mode === 'tab' ? 'browser'
      : options.mode === 'window' ? 'window'
      : 'monitor';

    try {
      rec.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 30, max: 60 },
          width: { ideal: resDims.w },
          height: { ideal: resDims.h },
          displaySurface,
        } as MediaTrackConstraints,
        audio: options.systemAudio !== false,
        // Include the calling tab in the picker (hidden by default to avoid mirror loops)
        // and hint Chrome to pre-select it when in tab mode
        ...(options.mode === 'tab' ? {
          preferCurrentTab: true,
          selfBrowserSurface: 'include',
        } : {}),
      } as DisplayMediaStreamOptions);
    } catch {
      rec.micStream?.getTracks().forEach((t) => t.stop());
      rec.webcamStream?.getTracks().forEach((t) => t.stop());
      rec.micStream = null;
      rec.webcamStream = null;
      return;
    }
  }

  rec.screenStream.getVideoTracks()[0]?.addEventListener('ended', () => stopRecording());

  // Inject webcam bubble now that we have the screen stream and are about to record
  if (rec.webcamStream) {
    injectWebcamBubble(rec.webcamStream);
  }

  // Mix all audio sources into a single track via AudioContext.
  rec.audioCtx = new AudioContext({ latencyHint: 'playback', sampleRate: 48000 });
  const mixDest = rec.audioCtx.createMediaStreamDestination();

  if (options.systemAudio !== false) {
    for (const track of rec.screenStream.getAudioTracks()) {
      rec.audioCtx.createMediaStreamSource(new MediaStream([track])).connect(mixDest);
    }
  }
  if (rec.micStream) {
    for (const track of rec.micStream.getAudioTracks()) {
      rec.audioCtx.createMediaStreamSource(new MediaStream([track])).connect(mixDest);
    }
  }

  const combinedStream = new MediaStream([
    ...rec.screenStream.getVideoTracks(),
    ...mixDest.stream.getAudioTracks(),
  ]);

  const mimeType = getSupportedMimeType(true);
  rec.chunks = [];
  rec.mediaRecorder = new MediaRecorder(combinedStream, {
    mimeType,
    audioBitsPerSecond: 128000,
  });
  rec.mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) rec.chunks.push(e.data);
  };
  rec.mediaRecorder.onstop = () => finalizeRecording();
  // 250ms chunks — smaller slices prevent audio gaps from buffer underruns
  rec.mediaRecorder.start(250);

  rec.startTime = passedStartTime ?? Date.now();
  rec.pausedAt = 0;
  rec.totalPausedMs = 0;
  rec.isPaused = false;
  injectToolbar();
}

// ─── Stop Recording ───────────────────────────────────────────────────────────

function stopRecording() {
  clearInterval(rec.timerInterval ?? 0);
  removeOverlays();

  if (!rec.mediaRecorder || rec.mediaRecorder.state === 'inactive') {
    // Already stopped (e.g. Chrome's native "Stop sharing" button was used and
    // finalizeRecording already ran). Just ensure streams are released.
    releaseStreams();
    notifyBackground('recordingStopped');
    return;
  }

  // Stop the recorder; let onstop → finalizeRecording handle stream teardown
  // AFTER all buffered chunks have been flushed. Stopping tracks here would
  // cause the last chunk to be empty/missing.
  rec.mediaRecorder.stop();
}

function releaseStreams() {
  rec.screenStream?.getTracks().forEach((t) => t.stop());
  rec.webcamStream?.getTracks().forEach((t) => t.stop());
  rec.micStream?.getTracks().forEach((t) => t.stop());
  rec.audioCtx?.close();
}

function notifyBackground(action: string) {
  chrome.runtime.sendMessage({ action }).catch(() => {});
}

async function finalizeRecording() {
  const mimeType = getSupportedMimeType(true);
  const blob = new Blob(rec.chunks, { type: mimeType });

  releaseStreams();
  resetRecState();

  // openPreviewPage sends the recording to the background, which stores it in
  // the extension's IndexedDB and opens the preview tab. It also clears the
  // recording state (replaces the separate recordingStopped notification).
  await openPreviewPage(blob, mimeType);
}

async function openPreviewPage(blob: Blob, mimeType: string) {
  const durationSecs = rec.startTime > 0
    ? (Date.now() - rec.startTime - rec.totalPausedMs) / 1000
    : 0;
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  // Base64-encode in chunks — strings survive Chrome's extension IPC (JSON-based)
  // intact; raw TypedArrays get mangled into plain objects on the receiving end.
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const base64 = btoa(binary);
  chrome.runtime.sendMessage({
    action: 'saveRecording',
    base64,
    mimeType,
    createdAt: Date.now(),
    duration: durationSecs,
  }).catch(() => {});
}


function resetRecState() {
  rec.mediaRecorder = null;
  rec.screenStream = null;
  rec.webcamStream = null;
  rec.micStream = null;
  rec.audioCtx = null;
  rec.chunks = [];
}

// ─── Toolbar Overlay ──────────────────────────────────────────────────────────

function injectToolbar() {
  removeToolbar();

  const root = document.createElement('div');
  root.className = 'sm-rec-root';
  root.id = 'sm-rec-root';

  const toolbar = document.createElement('div');
  toolbar.className = 'sm-rec-toolbar';

  // Dot
  const dot = document.createElement('div');
  dot.className = 'sm-rec-dot';

  // Label
  const label = document.createElement('span');
  label.className = 'sm-rec-label';
  label.textContent = 'REC';

  // Timer
  const timer = document.createElement('span');
  timer.className = 'sm-rec-timer';
  timer.id = 'sm-rec-timer';
  timer.textContent = '00:00';

  // Sep
  const sep = document.createElement('div');
  sep.className = 'sm-rec-sep';

  // Pause button
  const pauseBtn = document.createElement('button');
  pauseBtn.className = 'sm-rec-btn sm-rec-btn-pause';
  pauseBtn.id = 'sm-rec-pause';
  pauseBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 24 24">
      <path d="M6 4h4v16H6zm8 0h4v16h-4z"/>
    </svg>
    Pause
  `;
  pauseBtn.addEventListener('click', togglePause);

  // Stop button
  const stopBtn = document.createElement('button');
  stopBtn.className = 'sm-rec-btn sm-rec-btn-stop';
  stopBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 24 24">
      <rect x="4" y="4" width="16" height="16" rx="2"/>
    </svg>
    Stop & Save
  `;
  stopBtn.addEventListener('click', () => {
    if (stopBtn.disabled) return;
    stopBtn.disabled = true;
    stopBtn.textContent = 'Stopping…';
    stopRecording();
  });

  // Logo
  const logo = document.createElement('span');
  logo.className = 'sm-rec-logo';
  logo.textContent = '⚡ SnapMonk';

  toolbar.append(dot, label, timer, sep, pauseBtn, stopBtn, logo);
  root.appendChild(toolbar);
  document.body.appendChild(root);

  // Start timer
  clearInterval(rec.timerInterval ?? 0);
  rec.timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - rec.startTime - rec.totalPausedMs) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    const timerEl = document.getElementById('sm-rec-timer');
    if (timerEl) timerEl.textContent = `${mins}:${secs}`;
  }, 500);
}

function togglePause() {
  if (!rec.mediaRecorder) return;
  const btn = document.getElementById('sm-rec-pause') as HTMLButtonElement;

  if (rec.isPaused) {
    rec.mediaRecorder.resume();
    rec.isPaused = false;
    // Accumulate the time we were paused so elapsed time stays accurate
    if (rec.pausedAt > 0) {
      rec.totalPausedMs += Date.now() - rec.pausedAt;
      rec.pausedAt = 0;
    }
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 24 24">
        <path d="M6 4h4v16H6zm8 0h4v16h-4z"/>
      </svg>
      Pause
    `;
  } else {
    rec.mediaRecorder.pause();
    rec.isPaused = true;
    rec.pausedAt = Date.now();
    const dot = document.querySelector('.sm-rec-dot') as HTMLElement;
    if (dot) dot.style.animationPlayState = 'paused';
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 24 24">
        <path d="M8 5v14l11-7z"/>
      </svg>
      Resume
    `;
  }
}

// ─── Webcam Bubble ────────────────────────────────────────────────────────────

function injectWebcamBubble(stream: MediaStream) {
  removeWebcamBubble();

  const bubble = document.createElement('div');
  bubble.className = 'sm-webcam-bubble';
  bubble.id = 'sm-webcam-bubble';

  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;

  const labelEl = document.createElement('div');
  labelEl.className = 'sm-webcam-label';
  labelEl.textContent = '📹 Webcam';

  bubble.appendChild(video);
  bubble.appendChild(labelEl);
  document.body.appendChild(bubble);

  makeDraggable(bubble);

  // Resize handle: double-click to cycle sizes
  const sizes = [120, 160, 220];
  let sizeIdx = 1;
  bubble.addEventListener('dblclick', () => {
    sizeIdx = (sizeIdx + 1) % sizes.length;
    const s = sizes[sizeIdx]!;
    bubble.style.width = `${s}px`;
    bubble.style.height = `${s}px`;
  });
}

function makeDraggable(el: HTMLElement) {
  let offsetX = 0, offsetY = 0, startX = 0, startY = 0;

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX - el.getBoundingClientRect().left;
    startY = e.clientY - el.getBoundingClientRect().top;

    const onMove = (ev: MouseEvent) => {
      offsetX = ev.clientX - startX;
      offsetY = ev.clientY - startY;
      el.style.left = `${offsetX}px`;
      el.style.top = `${offsetY}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ─── Countdown ────────────────────────────────────────────────────────────────

function showCountdown(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    let n = seconds;

    const overlay = document.createElement('div');
    overlay.className = 'sm-countdown-overlay';
    overlay.id = 'sm-countdown';
    document.body.appendChild(overlay);

    const tick = () => {
      overlay.innerHTML = `<div class="sm-countdown-number">${n}</div>`;
      n--;
      if (n < 0) {
        overlay.remove();
        resolve();
      } else {
        setTimeout(tick, 1000);
      }
    };
    tick();
  });
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

function removeToolbar() {
  document.getElementById('sm-rec-root')?.remove();
}

function removeWebcamBubble() {
  const bubble = document.getElementById('sm-webcam-bubble');
  if (bubble) {
    const video = bubble.querySelector('video') as HTMLVideoElement;
    if (video?.srcObject) {
      (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
    }
    bubble.remove();
  }
}

function removeOverlays() {
  removeToolbar();
  removeWebcamBubble();
  document.getElementById('sm-countdown')?.remove();
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function getSupportedMimeType(forMp4 = false): string {
  if (forMp4) {
    // Chrome 130+ can record natively to MP4 — no conversion needed at all.
    // Fall back to H.264-in-WebM so ffmpeg only has to remux (not re-encode).
    const mp4Candidates = [
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=h264,opus',
      'video/webm;codecs=avc1,opus',
    ];
    const found = mp4Candidates.find((t) => MediaRecorder.isTypeSupported(t));
    if (found) return found;
  }
  const defaults = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
  ];
  return defaults.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/webm';
}

function formatTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
