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

  // Default the active button to match the native recorded format.
  const isNativeMP4 = originalMimeType.startsWith('video/mp4');
  selectedFormat = isNativeMP4 ? 'mp4' : 'webm';
  document.querySelectorAll('.pv-fmt-btn').forEach(b => {
    const btn = b as HTMLButtonElement;
    btn.classList.toggle('active', btn.dataset['fmt'] === selectedFormat);
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

  video.addEventListener('canplay', () => {
    loadingEl.classList.add('hidden');
    video.classList.add('visible');
    // Seek slightly off 0 to render first frame (WebM without cue headers shows black).
    // Only safe to seek here, after the browser has confirmed it can play.
    if (video.currentTime === 0 && video.seekable.length > 0) {
      video.currentTime = 0.1;
    }
  }, { once: true });

  let retried = false;
  video.addEventListener('error', () => {
    // On first failure, revoke the old URL and recreate it — intermittent decode errors
    // often resolve on a fresh object URL from the same in-memory blob.
    if (!retried && recordingBlob) {
      retried = true;
      URL.revokeObjectURL(video.src);
      video.src = URL.createObjectURL(recordingBlob);
      video.load();
      return;
    }
    loadingEl.classList.remove('hidden');
    video.classList.remove('visible');
    loadingEl.innerHTML = '<span style="color:#ef4444;font-size:14px;">Failed to load video.</span>';
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
    triggerDownload(recordingBlob, `snapmonk-recording-${Date.now()}.${selectedFormat}`);
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
