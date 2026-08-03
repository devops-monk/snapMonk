import { getPendingRecording, deletePendingRecording } from '../utils/db';

const video = document.getElementById('pv-video') as HTMLVideoElement;
const loadingEl = document.getElementById('pv-loading') as HTMLElement;
const createTimeEl = document.getElementById('pv-create-time') as HTMLElement;
const durationEl = document.getElementById('pv-duration') as HTMLElement;
const sizeEl = document.getElementById('pv-size') as HTMLElement;
const downloadBtn = document.getElementById('pv-download-btn') as HTMLButtonElement;

let recordingBlob: Blob | null = null;
let selectedFormat = 'webm';
let originalMimeType = 'video/webm';
let storedDuration = 0;

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function fmtDuration(secs: number): string {
  if (!isFinite(secs) || isNaN(secs) || secs <= 0) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function init() {
  const entry = await getPendingRecording();

  if (!entry) {
    loadingEl.innerHTML = '<span style="color:#ef4444;font-size:14px;">No recording found.</span>';
    return;
  }

  storedDuration = entry.duration ?? 0;
  recordingBlob = entry.blob;
  originalMimeType = entry.mimeType;

  // The download must match the ACTUAL recorded container, otherwise the file is
  // mislabeled and won't play (e.g. a WebM named .mp4). Reflect the true format
  // and disable the other button — pick the format up front in the popup instead.
  const container = originalMimeType.includes('mp4') ? 'mp4' : 'webm';
  selectedFormat = container;
  document.querySelectorAll('.pv-fmt-btn').forEach(b => {
    const btn = b as HTMLButtonElement;
    const match = btn.dataset['fmt'] === container;
    btn.classList.toggle('active', match);
    btn.disabled = !match;
    btn.style.opacity = match ? '' : '0.4';
    btn.style.cursor = match ? '' : 'not-allowed';
    btn.title = match ? '' : `Recorded as ${container.toUpperCase()} — choose ${btn.dataset['fmt']!.toUpperCase()} in the popup before recording to export that format.`;
  });

  const url = URL.createObjectURL(recordingBlob);

  createTimeEl.textContent = fmtDate(entry.createdAt);
  sizeEl.textContent = fmtSize(recordingBlob.size);

  // Show stored duration immediately (WebM often has Infinity in the header)
  if (storedDuration > 0) {
    durationEl.textContent = fmtDuration(storedDuration);
  }

  // Set src after wiring events so no events are missed
  video.src = url;
  video.load();

  video.addEventListener('loadedmetadata', () => {
    if (isFinite(video.duration) && video.duration > 0) {
      durationEl.textContent = fmtDuration(video.duration);
    }
  });

  const isMp4 = originalMimeType.includes('mp4');
  video.addEventListener('canplay', () => {
    loadingEl.classList.add('hidden');
    video.classList.add('visible');
    // WebM recorded without cue headers renders a black first frame, so we nudge
    // currentTime to force a paint. MP4 doesn't need this, and seeking a freshly
    // muxed fragmented MP4 this early can throw and (wrongly) fire `error` — so
    // skip it for MP4 and guard it for WebM.
    if (!isMp4 && video.currentTime === 0 && video.seekable.length > 0) {
      try { video.currentTime = 0.1; } catch { /* first frame will paint on play */ }
    }
  }, { once: true });

  let attempts = 0;
  video.addEventListener('error', () => {
    attempts++;
    // Transient decode stalls on freshly-muxed MediaRecorder output usually clear
    // on a fresh object URL; retry a couple of times with a short backoff.
    if (attempts <= 2 && recordingBlob) {
      setTimeout(() => {
        URL.revokeObjectURL(video.src);
        video.src = URL.createObjectURL(recordingBlob!);
        video.load();
      }, 250 * attempts);
      return;
    }
    // The blob itself is valid and downloadable even if the inline preview can't
    // decode it — reassure the user instead of blocking them.
    loadingEl.classList.remove('hidden');
    video.classList.remove('visible');
    loadingEl.innerHTML =
      '<span style="color:#fca5a5;font-size:13px;">Preview couldn\'t load, but your recording is fine — click Download to save it.</span>';
  });

  // Clean up from IndexedDB after loading into memory
  await deletePendingRecording();
}

// Format selector
document.querySelectorAll<HTMLButtonElement>('.pv-fmt-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    selectedFormat = btn.dataset['fmt']!;
    document.querySelectorAll('.pv-fmt-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// Speed control
document.querySelectorAll<HTMLButtonElement>('.pv-speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const speed = parseFloat(btn.dataset['speed']!);
    video.playbackRate = speed;
    document.querySelectorAll('.pv-speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

const DOWNLOAD_ICON = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg>`;

// Download
downloadBtn.addEventListener('click', async () => {
  if (!recordingBlob) return;

  downloadBtn.disabled = true;
  downloadBtn.textContent = 'Preparing…';

  try {
    // Always use the true container extension so the file is never mislabeled.
    const ext = originalMimeType.includes('mp4') ? 'mp4' : 'webm';
    triggerDownload(recordingBlob, `snapmonk-recording-${Date.now()}.${ext}`);
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.innerHTML = `${DOWNLOAD_ICON} Download`;
  }
});

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

init();
