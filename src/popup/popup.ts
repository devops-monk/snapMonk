import type { PopupMessage, RecordingOptions, RecorderMessage } from '../utils/types';

// ─── Tab helpers ──────────────────────────────────────────────────────────────

async function getActiveTab(): Promise<{ tabId: number; windowId: number } | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId) return null;
  return { tabId: tab.id, windowId: tab.windowId };
}

function setStatus(visible: boolean, text = '') {
  const badge = document.getElementById('status-badge') as HTMLDivElement;
  const label = document.getElementById('status-text') as HTMLSpanElement;
  badge.style.display = visible ? 'flex' : 'none';
  label.textContent = text;
}

// ─── Screenshot capture ───────────────────────────────────────────────────────

async function sendCapture(action: PopupMessage['action']): Promise<void> {
  const tab = await getActiveTab();
  if (!tab) return;

  // Close the popup BEFORE capturing so it doesn't affect the viewport snapshot
  window.close();

  // Fire and forget — popup is already closing so we can't await the response
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

// ─── Recording ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'snapmonk_recording_state';

interface RecordingState {
  active: boolean;
  startTime: number;
  tabId: number;
}

// Determine which panels to show based on stored recording state
async function initRecordingUI() {
  const stored = await chrome.storage.local.get(STORAGE_KEY) as Record<string, RecordingState>;
  const state = stored[STORAGE_KEY] as RecordingState | undefined;

  if (state?.active) {
    showActiveRecording(state.startTime);
  }
}

function showOptions() {
  document.getElementById('record-options')!.style.display = 'block';
  document.getElementById('record-active')!.style.display = 'none';
  (document.getElementById('btn-record-label') as HTMLSpanElement).textContent = 'Record Screen';
}

function showActiveRecording(startTime: number) {
  document.getElementById('record-options')!.style.display = 'none';
  document.getElementById('record-active')!.style.display = 'block';
  (document.getElementById('btn-record-label') as HTMLSpanElement).textContent = 'Recording active…';

  // Update timer every 500ms while popup is open
  const timerEl = document.getElementById('rec-live-timer') as HTMLSpanElement;
  const update = () => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    timerEl.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  };
  update();
  const interval = setInterval(update, 500);
  // Clear when popup unloads
  window.addEventListener('unload', () => clearInterval(interval));
}

// ─── Mode selector ────────────────────────────────────────────────────────────

let selectedMode: RecordingOptions['mode'] = 'tab';

document.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedMode = btn.dataset['mode'] as RecordingOptions['mode'];
    document.querySelectorAll('.mode-btn').forEach((b) => {
      const isActive = b === btn;
      (b as HTMLElement).style.background = isActive ? '#21262D' : 'transparent';
      (b as HTMLElement).style.color = isActive ? '#E6EDF3' : '#8B949E';
      (b as HTMLElement).style.borderColor = isActive ? '#7C3AED' : '#30363D';
    });
  });
});

// Toggle panel open/close
document.getElementById('btn-record-toggle')?.addEventListener('click', async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEY) as Record<string, RecordingState>;
  const state = stored[STORAGE_KEY] as RecordingState | undefined;

  if (state?.active) {
    // Already recording — show active panel
    showActiveRecording(state.startTime);
  } else {
    const optionsPanel = document.getElementById('record-options') as HTMLDivElement;
    optionsPanel.style.display = optionsPanel.style.display === 'none' ? 'block' : 'none';
  }
});

// ─── Start recording ──────────────────────────────────────────────────────────

document.getElementById('btn-record-start')?.addEventListener('click', async () => {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id || !activeTab.windowId) return;

  if (!activeTab.url || activeTab.url.startsWith('chrome')) {
    const label = document.getElementById('btn-record-label') as HTMLSpanElement;
    const orig = label.textContent ?? '';
    label.textContent = 'Switch to a web page first';
    label.style.color = '#F85149';
    setTimeout(() => { label.textContent = orig; label.style.color = ''; }, 3000);
    return;
  }

  const tab = { tabId: activeTab.id, windowId: activeTab.windowId };

  const options: RecordingOptions = {
    mode: selectedMode,
    webcam: (document.getElementById('opt-webcam') as HTMLInputElement).checked,
    mic: (document.getElementById('opt-mic') as HTMLInputElement).checked,
    format: 'webm',
  };

  // Save recording state (including tabId so we can stop from popup)
  await chrome.storage.local.set({
    [STORAGE_KEY]: { active: true, startTime: Date.now(), tabId: tab.tabId } satisfies RecordingState,
  });

  // Inject the recorder toolbar into the tab, then send the begin message.
  // The user gesture from clicking "Start Recording" propagates through
  // chrome.tabs.sendMessage (Chrome 112+), allowing getDisplayMedia in the content script.
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
    await chrome.tabs.sendMessage(state.tabId, { action: 'stopRecording' });
  } catch {
    // Tab may have navigated — just clear the state
    await chrome.storage.local.remove(STORAGE_KEY);
    showOptions();
  }
});

// ─── Listen for recording-stopped notification from toolbar ───────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'recordingStopped' || msg.action === 'recordingError') {
    chrome.storage.local.remove(STORAGE_KEY);
    showOptions();
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

initRecordingUI();
