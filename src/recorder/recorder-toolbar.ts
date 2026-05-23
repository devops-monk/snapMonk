import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
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
  timerInterval: null,
  isPaused: false,
  options: null,
};

// ─── Message listener ─────────────────────────────────────────────────────────

function initRecorder() {
  chrome.runtime.onMessage.addListener((msg: RecorderMessage, _sender, sendResponse) => {
    if (msg.action === 'beginRecording' && msg.options) {
      startRecording(msg.options)
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

async function startRecording(options: RecordingOptions): Promise<void> {
  rec.options = options;

  // Request mic and webcam BEFORE the countdown and screen picker so that:
  // 1. The user gesture from "Start Recording" is still live for getUserMedia
  // 2. The webcam bubble can appear immediately once recording begins
  // 3. Permission failures surface before we enter the countdown
  if (options.mic) {
    try {
      rec.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      rec.micStream = null;
    }
  }

  if (options.webcam) {
    try {
      rec.webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 320, facingMode: 'user' },
        audio: false,
      });
    } catch {
      rec.webcamStream = null;
    }
  }

  await showCountdown(3);

  // Map the user's mode choice to Chrome's displaySurface hint so the picker
  // pre-selects the right source. 'monitor' (desktop) lets the user switch
  // tabs freely; 'browser' (tab) only captures the specific tab chosen.
  const displaySurface = options.mode === 'tab' ? 'browser'
    : options.mode === 'window' ? 'window'
    : 'monitor';

  try {
    rec.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 60 },
        width: { ideal: screen.width },
        height: { ideal: screen.height },
        displaySurface,
      } as MediaTrackConstraints,
      audio: true,
    });
  } catch {
    // User cancelled — clean up any streams already acquired
    rec.micStream?.getTracks().forEach((t) => t.stop());
    rec.webcamStream?.getTracks().forEach((t) => t.stop());
    rec.micStream = null;
    rec.webcamStream = null;
    return;
  }

  rec.screenStream.getVideoTracks()[0]?.addEventListener('ended', () => stopRecording());

  // Inject webcam bubble now that we have the screen stream and are about to record
  if (rec.webcamStream) {
    injectWebcamBubble(rec.webcamStream);
  }

  // MediaRecorder only records the first audio track it finds, so we must mix
  // all audio sources (system + mic) into a single track via AudioContext.
  rec.audioCtx = new AudioContext();
  const mixDest = rec.audioCtx.createMediaStreamDestination();

  for (const track of rec.screenStream.getAudioTracks()) {
    rec.audioCtx.createMediaStreamSource(new MediaStream([track])).connect(mixDest);
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

  const mimeType = getSupportedMimeType(options.format === 'mp4');
  rec.chunks = [];
  rec.mediaRecorder = new MediaRecorder(combinedStream, { mimeType });
  rec.mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) rec.chunks.push(e.data);
  };
  rec.mediaRecorder.onstop = () => finalizeRecording();
  rec.mediaRecorder.start(1000);

  rec.startTime = Date.now();
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
  const mimeType = getSupportedMimeType();
  const webmBlob = new Blob(rec.chunks, { type: mimeType });
  const format = rec.options?.format ?? 'webm';

  releaseStreams();
  resetRecState();

  if (format === 'mp4') {
    await convertAndDownloadMp4(webmBlob);
  } else {
    triggerDownload(webmBlob, `snapmonk-recording-${formatTimestamp()}.webm`);
    notifyBackground('recordingStopped');
  }
}

async function convertAndDownloadMp4(webmBlob: Blob) {
  const overlay = showConvertingOverlay();
  try {
    const ffmpeg = new FFmpeg();
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    await ffmpeg.writeFile('input.webm', await fetchFile(webmBlob));
    // -c copy remuxes without re-encoding (fast). Works when source is H.264,
    // which is what getSupportedMimeType picks when MP4 is the target format.
    await ffmpeg.exec(['-i', 'input.webm', '-c', 'copy', '-movflags', '+faststart', 'output.mp4']);
    const data = await ffmpeg.readFile('output.mp4') as Uint8Array;
    const mp4Blob = new Blob([data.buffer], { type: 'video/mp4' });
    triggerDownload(mp4Blob, `snapmonk-recording-${formatTimestamp()}.mp4`);
  } catch (err) {
    console.error('[SnapMonk] MP4 conversion failed, saving as WebM:', err);
    triggerDownload(webmBlob, `snapmonk-recording-${formatTimestamp()}.webm`);
  } finally {
    overlay.remove();
    notifyBackground('recordingStopped');
  }
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function showConvertingOverlay(): HTMLDivElement {
  const el = document.createElement('div');
  el.id = 'sm-converting';
  Object.assign(el.style, {
    position: 'fixed', inset: '0', zIndex: '2147483647',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.75)', color: '#fff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: '16px', gap: '12px',
  });
  el.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" style="animation:sm-spin 1s linear infinite">
      <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/>
    </svg>
    <span>Converting to MP4…</span>
    <span style="font-size:12px;opacity:0.6;">This may take a moment</span>
    <style>@keyframes sm-spin{to{transform:rotate(360deg)}}</style>
  `;
  document.body.appendChild(el);
  return el;
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
  stopBtn.addEventListener('click', stopRecording);

  // Logo
  const logo = document.createElement('span');
  logo.className = 'sm-rec-logo';
  logo.textContent = '⚡ SnapMonk';

  toolbar.append(dot, label, timer, sep, pauseBtn, stopBtn, logo);
  root.appendChild(toolbar);
  document.body.appendChild(root);

  // Start timer
  rec.timerInterval = setInterval(() => {
    if (!rec.isPaused) {
      const elapsed = Math.floor((Date.now() - rec.startTime) / 1000);
      const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const secs = String(elapsed % 60).padStart(2, '0');
      const timerEl = document.getElementById('sm-rec-timer');
      if (timerEl) timerEl.textContent = `${mins}:${secs}`;
    }
  }, 500);
}

function togglePause() {
  if (!rec.mediaRecorder) return;
  const btn = document.getElementById('sm-rec-pause') as HTMLButtonElement;

  if (rec.isPaused) {
    rec.mediaRecorder.resume();
    rec.isPaused = false;
    rec.startTime = Date.now() - (rec.mediaRecorder.state === 'recording' ? 0 : 0);
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 24 24">
        <path d="M6 4h4v16H6zm8 0h4v16h-4z"/>
      </svg>
      Pause
    `;
  } else {
    rec.mediaRecorder.pause();
    rec.isPaused = true;
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

function getSupportedMimeType(preferH264 = false): string {
  // When targeting MP4, prefer H.264 so ffmpeg can remux (container-swap)
  // instead of re-encoding — making conversion near-instant.
  const h264Types = [
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=avc1,opus',
  ];
  const defaultTypes = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
  ];
  const candidates = preferH264
    ? [...h264Types, ...defaultTypes]
    : defaultTypes;
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/webm';
}

function formatTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
