import type { PopupMessage, RecordingOptions, RecorderMessage, RecordingFormat } from '../utils/types';

// ─── Wake service worker on popup open ───────────────────────────────────────
// MV3 service workers go dormant between uses. Sending a ping immediately when
// the popup opens ensures the worker is fully awake before the user clicks a
// capture button — preventing the "first click does nothing" bug.
chrome.runtime.sendMessage({ action: 'ping' }).catch(() => {});

// ─── Tab switching ────────────────────────────────────────────────────────────

function switchPanel(name: 'capture' | 'record') {
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset['panel'] === name);
  });
  (document.getElementById('panel-capture') as HTMLDivElement).style.display =
    name === 'capture' ? '' : 'none';
  (document.getElementById('panel-record') as HTMLDivElement).style.display =
    name === 'record' ? '' : 'none';
}

document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () =>
    switchPanel(btn.dataset['panel'] as 'capture' | 'record'),
  );
});

// ─── Capture helpers ──────────────────────────────────────────────────────────

async function getActiveTab(): Promise<{ tabId: number; windowId: number } | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId) return null;
  return { tabId: tab.id, windowId: tab.windowId };
}

async function sendCapture(action: PopupMessage['action']): Promise<void> {
  const tab = await getActiveTab();
  if (!tab) return;
  window.close();
  chrome.runtime.sendMessage<PopupMessage>({
    action,
    tabId: tab.tabId,
    windowId: tab.windowId,
  }).catch(() => {});
}

document.getElementById('btn-visible')?.addEventListener('click', () => sendCapture('captureVisible'));
document.getElementById('btn-fullpage')?.addEventListener('click', () => sendCapture('captureFullPage'));
document.getElementById('btn-region')?.addEventListener('click', () => sendCapture('captureRegion'));
document.getElementById('btn-element')?.addEventListener('click', () => sendCapture('captureElement'));

document.getElementById('btn-options')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('btn-library')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html?tab=library') });
});

// ─── Recording state ──────────────────────────────────────────────────────────

const STORAGE_KEY = 'snapmonk_recording_state';

interface RecordingState {
  active: boolean;
  startTime: number;
  tabId: number;
}

function showOptions() {
  document.getElementById('record-options')!.style.display = '';
  document.getElementById('record-active')!.style.display = 'none';
}

function showActiveRecording(startTime: number) {
  // Auto-switch to Record tab so the user can see the timer
  switchPanel('record');

  document.getElementById('record-options')!.style.display = 'none';
  document.getElementById('record-active')!.style.display = '';

  const timerEl = document.getElementById('rec-live-timer') as HTMLSpanElement;
  const update = () => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    timerEl.textContent =
      `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  };
  update();
  const interval = setInterval(update, 500);
  window.addEventListener('unload', () => clearInterval(interval));
}

async function initRecordingUI() {
  const stored = await chrome.storage.local.get(STORAGE_KEY) as Record<string, RecordingState>;
  const state = stored[STORAGE_KEY] as RecordingState | undefined;
  if (state?.active) {
    showActiveRecording(state.startTime);
  }
}

// ─── Mode selector ────────────────────────────────────────────────────────────

let selectedMode: RecordingOptions['mode'] = 'tab';
let selectedFormat: RecordingFormat = 'webm';

document.querySelectorAll<HTMLButtonElement>('.mode-card').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedMode = btn.dataset['mode'] as RecordingOptions['mode'];
    document.querySelectorAll<HTMLButtonElement>('.mode-card').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
  });
});

document.querySelectorAll<HTMLButtonElement>('.fmt-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedFormat = btn.dataset['format'] as RecordingFormat;
    document.querySelectorAll<HTMLButtonElement>('.fmt-btn').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
  });
});

// ─── Start recording ──────────────────────────────────────────────────────────

document.getElementById('btn-record-start')?.addEventListener('click', async () => {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id || !activeTab.windowId) return;

  if (!activeTab.url || activeTab.url.startsWith('chrome')) {
    const btn = document.getElementById('btn-record-start') as HTMLButtonElement;
    const orig = btn.textContent ?? '';
    btn.textContent = 'Switch to a web page first';
    btn.style.background = '#F85149';
    setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 3000);
    return;
  }

  const tab = { tabId: activeTab.id, windowId: activeTab.windowId };

  const options: RecordingOptions = {
    mode: selectedMode,
    webcam: (document.getElementById('opt-webcam') as HTMLInputElement).checked,
    mic: (document.getElementById('opt-mic') as HTMLInputElement).checked,
    format: selectedFormat,
  };

  await chrome.storage.local.set({
    [STORAGE_KEY]: { active: true, startTime: Date.now(), tabId: tab.tabId } satisfies RecordingState,
  });

  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.tabId },
      files: ['src/recorder/recorder-toolbar.css'],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.tabId },
      files: ['src/recorder/recorder-toolbar.js'],
    });

    const msg: RecorderMessage = { action: 'beginRecording', options };
    await chrome.tabs.sendMessage(tab.tabId, msg);

    showActiveRecording(Date.now());
  } catch (err) {
    await chrome.storage.local.remove(STORAGE_KEY);
    console.error('[SnapMonk] Recording start failed:', err);
  }
});

// ─── Stop recording from popup ────────────────────────────────────────────────

document.getElementById('btn-record-stop')?.addEventListener('click', async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEY) as Record<string, RecordingState>;
  const state = stored[STORAGE_KEY] as RecordingState | undefined;
  if (!state?.tabId) return;

  try {
    await chrome.tabs.update(state.tabId, { active: true });
    await chrome.tabs.sendMessage(state.tabId, { action: 'stopRecording' });
  } catch {
    await chrome.storage.local.remove(STORAGE_KEY);
    showOptions();
  }
});

// ─── Listen for recording-stopped notification ────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'recordingStopped' || msg.action === 'recordingError') {
    chrome.storage.local.remove(STORAGE_KEY);
    showOptions();
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

initRecordingUI();
