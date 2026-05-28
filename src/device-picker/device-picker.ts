const DEVICE_PREFS_KEY = 'snapmonk_device_prefs';

interface DevicePrefs {
  cameraDeviceId: string;
  cameraLabel: string;
  micDeviceId: string;
  micLabel: string;
}

const videoEl = document.getElementById('dp-camera-preview') as HTMLVideoElement;
const permMsgEl = document.getElementById('dp-permission-msg') as HTMLElement;
const cameraSelect = document.getElementById('dp-camera-select') as HTMLSelectElement;
const micSelect = document.getElementById('dp-mic-select') as HTMLSelectElement;
const micLevelEl = document.getElementById('dp-mic-level') as HTMLElement;
const allowAllBtn = document.getElementById('dp-allow-all') as HTMLButtonElement;
const allowOnceBtn = document.getElementById('dp-allow-once') as HTMLButtonElement;
const denyBtn = document.getElementById('dp-deny') as HTMLButtonElement;
const permCameraRow = document.getElementById('dp-perm-camera') as HTMLElement;
const permMicRow = document.getElementById('dp-perm-mic') as HTMLElement;
const permCameraLabel = document.getElementById('dp-perm-camera-label') as HTMLElement;
const permMicLabel = document.getElementById('dp-perm-mic-label') as HTMLElement;

let currentCameraStream: MediaStream | null = null;
let micAudioCtx: AudioContext | null = null;
let micAnalyser: AnalyserNode | null = null;
let micAnimFrame = 0;

async function init() {
  // Load existing prefs so we can pre-select
  const stored = await chrome.storage.local.get(DEVICE_PREFS_KEY);
  const prefs = (stored[DEVICE_PREFS_KEY] ?? {}) as Partial<DevicePrefs>;

  try {
    // Call getUserMedia — this triggers Chrome's permission dialog IN this window
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

    // Permission granted — update UI
    permMsgEl.classList.add('hidden');
    videoEl.classList.add('active');
    currentCameraStream = stream;
    videoEl.srcObject = stream;

    permCameraRow.classList.add('granted');
    permCameraLabel.textContent = 'Camera access granted';
    permMicRow.classList.add('granted');
    permMicLabel.textContent = 'Microphone access granted';

    // Enumerate real device names now that permission is granted
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');
    const mics = devices.filter(d => d.kind === 'audioinput');

    // Populate camera dropdown
    cameraSelect.innerHTML = '';
    cameras.forEach((c, i) => {
      const opt = document.createElement('option');
      opt.value = c.deviceId;
      opt.textContent = c.label || `Camera ${i + 1}`;
      cameraSelect.appendChild(opt);
    });
    cameraSelect.disabled = false;
    if (prefs.cameraDeviceId) {
      cameraSelect.value = prefs.cameraDeviceId;
    }

    // Update permission count labels
    permCameraLabel.textContent = `Use available cameras (${cameras.length})`;
    permMicLabel.textContent = `Use available microphones (${mics.length})`;

    // Populate mic dropdown
    micSelect.innerHTML = '';
    mics.forEach((m, i) => {
      const opt = document.createElement('option');
      opt.value = m.deviceId;
      opt.textContent = m.label || `Microphone ${i + 1}`;
      micSelect.appendChild(opt);
    });
    micSelect.disabled = false;
    if (prefs.micDeviceId) {
      micSelect.value = prefs.micDeviceId;
    }

    // Start mic level meter
    startMicLevel(stream);

    // Enable buttons
    allowAllBtn.disabled = false;
    allowOnceBtn.disabled = false;

    // When camera selection changes, restart preview
    cameraSelect.addEventListener('change', () => restartCameraPreview(cameraSelect.value));

    // When mic selection changes, restart mic level meter
    micSelect.addEventListener('change', () => restartMicLevel(micSelect.value));

  } catch {
    // Permission denied
    permMsgEl.querySelector('span')!.textContent = 'Camera/mic access denied';
    permCameraRow.classList.add('denied');
    permMicRow.classList.add('denied');
    permCameraLabel.textContent = 'Camera access denied';
    permMicLabel.textContent = 'Microphone access denied';
  }
}

async function restartCameraPreview(deviceId: string) {
  if (currentCameraStream) {
    currentCameraStream.getVideoTracks().forEach(t => t.stop());
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } },
      audio: false,
    });
    // Keep the audio track from the existing stream
    const audioTracks = currentCameraStream?.getAudioTracks() ?? [];
    currentCameraStream = new MediaStream([...stream.getVideoTracks(), ...audioTracks]);
    videoEl.srcObject = new MediaStream(stream.getVideoTracks());
  } catch { /* ignore */ }
}

async function restartMicLevel(deviceId: string) {
  stopMicLevel();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } },
      video: false,
    });
    startMicLevel(stream);
  } catch { /* ignore */ }
}

function startMicLevel(stream: MediaStream) {
  stopMicLevel();
  try {
    micAudioCtx = new AudioContext();
    micAnalyser = micAudioCtx.createAnalyser();
    micAnalyser.fftSize = 256;
    const src = micAudioCtx.createMediaStreamSource(stream);
    src.connect(micAnalyser);
    const data = new Uint8Array(micAnalyser.frequencyBinCount);
    const tick = () => {
      micAnalyser!.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const pct = Math.min(100, (avg / 128) * 100 * 2);
      micLevelEl.style.width = `${pct}%`;
      micAnimFrame = requestAnimationFrame(tick);
    };
    tick();
  } catch { /* ignore */ }
}

function stopMicLevel() {
  cancelAnimationFrame(micAnimFrame);
  micAudioCtx?.close();
  micAudioCtx = null;
  micAnalyser = null;
  micLevelEl.style.width = '0%';
}

function cleanup() {
  stopMicLevel();
  currentCameraStream?.getTracks().forEach(t => t.stop());
  currentCameraStream = null;
}

async function saveAndClose(persist: boolean) {
  const cameraDeviceId = cameraSelect.value || '';
  const micDeviceId = micSelect.value || '';
  const cameraLabel = cameraSelect.options[cameraSelect.selectedIndex]?.textContent ?? '';
  const micLabel = micSelect.options[micSelect.selectedIndex]?.textContent ?? '';

  const prefs: DevicePrefs = { cameraDeviceId, cameraLabel, micDeviceId, micLabel };

  if (persist) {
    await chrome.storage.local.set({ [DEVICE_PREFS_KEY]: prefs });
  } else {
    // "Allow this time" — store in session only (overwrite prefs without persisting labels)
    await chrome.storage.local.set({ [DEVICE_PREFS_KEY]: prefs });
  }

  cleanup();
  window.close();
}

async function denyAndClose() {
  const prefs: DevicePrefs = { cameraDeviceId: '', cameraLabel: '', micDeviceId: '', micLabel: '' };
  await chrome.storage.local.set({ [DEVICE_PREFS_KEY]: prefs });
  cleanup();
  window.close();
}

allowAllBtn.addEventListener('click', () => saveAndClose(true));
allowOnceBtn.addEventListener('click', () => saveAndClose(false));
denyBtn.addEventListener('click', denyAndClose);

window.addEventListener('beforeunload', cleanup);

init();
