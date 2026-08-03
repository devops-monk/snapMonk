import type { RecorderMessage, RecordingOptions, RecordingFormat } from '../utils/types';

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
  // Keep references to the Web Audio nodes for the whole recording — an unreferenced
  // MediaStreamAudioSourceNode can be garbage-collected mid-recording, silently
  // cutting the mic/system audio.
  audioNodes: AudioNode[];
  chunks: Blob[];
  mimeType: string;
  transferId: string;
  seq: number;
  pendingSends: Promise<void>[];
  streaming: boolean;
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
  audioNodes: [],
  chunks: [],
  mimeType: '',
  transferId: '',
  seq: 0,
  pendingSends: [],
  streaming: false,
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

  // Gather the audio sources the user enabled.
  const audioSources: MediaStreamTrack[] = [];
  if (options.systemAudio !== false) audioSources.push(...rec.screenStream.getAudioTracks());
  if (rec.micStream) audioSources.push(...rec.micStream.getAudioTracks());

  let audioTracks: MediaStreamTrack[] = [];
  if (audioSources.length === 1) {
    // Single source → use the track directly. Avoids the Web Audio graph entirely,
    // which Chrome throttles/suspends when the recorder's tab is in the background
    // (the usual cause of sound cutting out mid-recording).
    audioTracks = audioSources;
  } else if (audioSources.length > 1) {
    // Multiple sources must be mixed into one track via an AudioContext. Resume it
    // immediately (it can start suspended) and re-resume on any state change so it
    // keeps producing audio even if the tab is backgrounded.
    rec.audioCtx = new AudioContext({ latencyHint: 'playback', sampleRate: 48000 });
    const mixDest = rec.audioCtx.createMediaStreamDestination();
    rec.audioNodes = [mixDest]; // hold references so nodes aren't GC'd mid-recording
    for (const track of audioSources) {
      const src = rec.audioCtx.createMediaStreamSource(new MediaStream([track]));
      src.connect(mixDest);
      rec.audioNodes.push(src);
    }
    await rec.audioCtx.resume().catch(() => {});
    rec.audioCtx.addEventListener('statechange', () => {
      if (rec.audioCtx?.state === 'suspended') rec.audioCtx.resume().catch(() => {});
    });
    audioTracks = mixDest.stream.getAudioTracks();
  }

  const combinedStream = new MediaStream([
    ...rec.screenStream.getVideoTracks(),
    ...audioTracks,
  ]);

  const mimeType = getSupportedMimeType(options.format);
  rec.mimeType = mimeType;
  rec.chunks = [];
  rec.seq = 0;
  rec.pendingSends = [];
  rec.transferId = `rec-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Quality: pick a healthy video bitrate per resolution (MediaRecorder's default
  // is often too low). Because recordings now stream to disk, bigger is fine.
  const BITRATE: Record<string, number> = {
    '480p': 1_500_000, '720p': 3_000_000, '1080p': 6_000_000, '2k': 12_000_000, '4k': 24_000_000,
  };
  const videoBitsPerSecond = BITRATE[options.resolution ?? '1080p'] ?? 6_000_000;

  // Try to stream the recording to disk (IndexedDB via the background). If the
  // handoff can't start, fall back to buffering in memory and transferring at
  // the end.
  rec.streaming = await sendRec({ action: 'recStart', transferId: rec.transferId });

  rec.mediaRecorder = new MediaRecorder(combinedStream, {
    mimeType,
    audioBitsPerSecond: 128000,
    videoBitsPerSecond,
  });
  rec.mediaRecorder.ondataavailable = (e) => {
    if (e.data.size === 0) return;
    if (rec.streaming) {
      // Stream to disk and free the chunk from memory — recording length is now
      // bounded by disk, not RAM.
      rec.pendingSends.push(streamChunk(rec.transferId, rec.seq++, e.data));
    } else {
      rec.chunks.push(e.data);
    }
  };
  rec.mediaRecorder.onerror = (e) => {
    console.error('[SnapMonk] MediaRecorder error:', e);
    stopRecording();
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
  const mimeType = rec.mimeType || getSupportedMimeType(rec.options?.format ?? 'mp4');
  const createdAt = Date.now();
  const duration = rec.startTime > 0 ? (Date.now() - rec.startTime - rec.totalPausedMs) / 1000 : 0;
  const streaming = rec.streaming;
  const transferId = rec.transferId;
  const pending = rec.pendingSends.slice();
  const memChunks = rec.chunks.slice();

  releaseStreams();
  resetRecState();

  if (streaming) {
    try {
      const results = await Promise.allSettled(pending);
      if (results.some((r) => r.status === 'rejected')) throw new Error('a slice failed to save');
      const done = await chrome.runtime.sendMessage({
        action: 'recEnd', transferId, mimeType, createdAt, duration,
      });
      if (!done?.ok) throw new Error('finish rejected');
    } catch {
      // Disk handoff failed — abandon it and, if we still hold anything in
      // memory, hand the file to the user directly rather than losing it.
      chrome.runtime.sendMessage({ action: 'recAbort', transferId }).catch(() => {});
      if (memChunks.length) directDownload(new Blob(memChunks, { type: mimeType }), mimeType);
    }
  } else {
    // Fallback path: buffer was kept in memory; transfer it at the end.
    await openPreviewPage(new Blob(memChunks, { type: mimeType }), mimeType, createdAt, duration);
  }
}

// Fire a message to the background and report whether it acked ok.
async function sendRec(msg: unknown): Promise<boolean> {
  try {
    const res = await chrome.runtime.sendMessage(msg);
    return !!(res as { ok?: boolean } | undefined)?.ok;
  } catch {
    return false;
  }
}

// Stream one recorded slice to disk, retrying if the service worker was asleep.
async function streamChunk(transferId: string, seq: number, data: Blob): Promise<void> {
  const base64 = bytesToBase64(new Uint8Array(await data.arrayBuffer()));
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await sendRec({ action: 'recChunk', transferId, seq, base64 })) return;
    await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
  }
  throw new Error(`slice ${seq} failed to save`);
}

// Base64-encode a byte slice (strings survive Chrome's JSON-based IPC intact;
// raw TypedArrays get mangled into plain objects on the receiving end).
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const SUB = 8192;
  for (let i = 0; i < bytes.length; i += SUB) {
    binary += String.fromCharCode(...bytes.subarray(i, i + SUB));
  }
  return btoa(binary);
}

// Fallback: if the handoff to the background fails, hand the file straight to the
// user so a recording is never silently lost.
function directDownload(blob: Blob, mimeType: string) {
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `snapmonk-recording-${Date.now()}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

// Fallback handoff (used when streaming-to-disk couldn't start): buffer the whole
// blob and transfer it in slices at the end.
async function openPreviewPage(blob: Blob, mimeType: string, createdAt: number, duration: number) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const transferId = `rec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const CHUNK = 3 * 512 * 1024; // 1.5 MB per slice — clean base64 boundary, ~2 MB/message

  try {
    if (!(await sendRec({ action: 'recStart', transferId }))) throw new Error('start rejected');
    for (let i = 0, seq = 0; i < bytes.length; i += CHUNK, seq++) {
      if (!(await sendRec({ action: 'recChunk', transferId, seq, base64: bytesToBase64(bytes.subarray(i, i + CHUNK)) }))) {
        throw new Error('chunk rejected');
      }
    }
    if (!(await sendRec({ action: 'recEnd', transferId, mimeType, createdAt, duration }))) {
      throw new Error('finish rejected');
    }
  } catch {
    directDownload(blob, mimeType);
    chrome.runtime.sendMessage({ action: 'recAbort', transferId }).catch(() => {});
  }
}


function resetRecState() {
  rec.mediaRecorder = null;
  rec.screenStream = null;
  rec.webcamStream = null;
  rec.micStream = null;
  rec.audioNodes.forEach((n) => n.disconnect());
  rec.audioNodes = [];
  rec.audioCtx?.close().catch(() => {});
  rec.audioCtx = null;
  rec.chunks = [];
  rec.pendingSends = [];
  rec.seq = 0;
  rec.streaming = false;
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
    // The audio mixer can suspend while paused/backgrounded — wake it back up.
    if (rec.audioCtx?.state === 'suspended') rec.audioCtx.resume().catch(() => {});
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

function getSupportedMimeType(format: RecordingFormat): string {
  // Record natively in the container the user chose so the file always plays and
  // is never mislabeled. MP4 (H.264/AAC) plays everywhere incl. QuickTime/Windows
  // and Chrome records real MP4 since v130; WebM (VP9/VP8) is Chrome's classic
  // codec. Each list falls back to the other container if the browser can't do
  // the preferred one.
  const mp4 = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
  ];
  const webm = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const candidates = format === 'mp4' ? [...mp4, ...webm] : [...webm, ...mp4];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/webm';
}

function formatTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
