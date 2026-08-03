import type { PopupMessage, RecordingOptions, RecorderMessage, RecordingFormat, RecordingResolution } from '../utils/types';

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

function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  const restrictedPrefixes = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'brave://'];
  if (restrictedPrefixes.some((p) => url.startsWith(p))) return true;
  // Chrome Web Store pages cannot be scripted by extensions
  const restrictedHosts = ['chrome.google.com', 'chromewebstore.google.com'];
  try {
    const host = new URL(url).hostname;
    if (restrictedHosts.includes(host)) return true;
  } catch { /* invalid URL */ }
  return false;
}

async function getActiveTab(): Promise<{ tabId: number; windowId: number; url?: string } | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId) return null;
  return { tabId: tab.id, windowId: tab.windowId, url: tab.url };
}

// ─── Restricted-page popover ──────────────────────────────────────────────────

let popoverDismissTimer: ReturnType<typeof setTimeout> | null = null;
let popoverOutsideHandler: ((e: MouseEvent) => void) | null = null;

function hideRestrictPopover(): void {
  const popover = document.getElementById('restrict-popover') as HTMLElement;
  popover.classList.remove('visible');
  if (popoverDismissTimer) { clearTimeout(popoverDismissTimer); popoverDismissTimer = null; }
  if (popoverOutsideHandler) { document.removeEventListener('click', popoverOutsideHandler); popoverOutsideHandler = null; }
}

function showRestrictPopover(triggerEl: HTMLElement): void {
  const popover = document.getElementById('restrict-popover') as HTMLElement;
  const arrow = popover.querySelector<HTMLElement>('.restrict-popover-arrow')!;
  const GAP = 8;
  const popoverLeft = 12; // matches left:12px in CSS

  // Measure popover height off-screen before positioning
  popover.style.top = '-9999px';
  popover.style.visibility = 'hidden';
  popover.classList.add('visible');
  const popoverH = popover.offsetHeight;
  popover.classList.remove('visible');
  popover.style.visibility = '';

  const rect = triggerEl.getBoundingClientRect();

  // Flip above trigger if not enough room below
  const flipUp = rect.bottom + GAP + popoverH > window.innerHeight;
  popover.classList.toggle('flip-up', flipUp);

  popover.style.top = flipUp
    ? `${rect.top - GAP - popoverH}px`
    : `${rect.bottom + GAP}px`;

  // Center arrow on the trigger button
  const arrowCenter = rect.left + rect.width / 2 - popoverLeft;
  arrow.style.left = `${Math.max(10, Math.min(arrowCenter - 6, 280))}px`;

  popover.classList.add('visible');

  // Auto-dismiss after 5 s
  if (popoverDismissTimer) clearTimeout(popoverDismissTimer);
  popoverDismissTimer = setTimeout(hideRestrictPopover, 5000);

  // Dismiss on any click outside the popover
  if (popoverOutsideHandler) document.removeEventListener('click', popoverOutsideHandler);
  popoverOutsideHandler = (e: MouseEvent) => {
    if (!popover.contains(e.target as Node)) hideRestrictPopover();
  };
  // Delay one tick so the current click doesn't immediately dismiss it
  setTimeout(() => document.addEventListener('click', popoverOutsideHandler!), 0);
}

document.getElementById('btn-popover-goto-record')?.addEventListener('click', () => {
  hideRestrictPopover();
  switchPanel('record');
});

async function sendCapture(action: PopupMessage['action'], triggerEl: HTMLElement): Promise<void> {
  const tab = await getActiveTab();
  if (!tab) return;

  if (isRestrictedUrl(tab.url)) {
    showRestrictPopover(triggerEl);
    return;
  }

  window.close();
  chrome.runtime.sendMessage<PopupMessage>({
    action,
    tabId: tab.tabId,
    windowId: tab.windowId,
  }).catch(() => {});
}

document.getElementById('btn-visible')?.addEventListener('click', (e) => sendCapture('captureVisible', e.currentTarget as HTMLElement));
document.getElementById('btn-fullpage')?.addEventListener('click', (e) => sendCapture('captureFullPage', e.currentTarget as HTMLElement));
document.getElementById('btn-region')?.addEventListener('click', (e) => sendCapture('captureRegion', e.currentTarget as HTMLElement));
document.getElementById('btn-element')?.addEventListener('click', (e) => sendCapture('captureElement', e.currentTarget as HTMLElement));

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
let selectedFormat: RecordingFormat = 'mp4';
let selectedResolution: RecordingResolution = '1080p';
let countdownSeconds = 3;

document.querySelectorAll<HTMLButtonElement>('.mode-card').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedMode = btn.dataset['mode'] as RecordingOptions['mode'];
    document.querySelectorAll<HTMLButtonElement>('.mode-card').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
    updateModeUI();
  });
});

function updateModeUI() {
  const systemSoundRow = document.getElementById('row-system-sound');
  const webcamRow = document.getElementById('row-webcam');
  const cameraRow = document.getElementById('row-camera');
  // System sound only makes sense for screen capture modes
  if (systemSoundRow) systemSoundRow.style.display = selectedMode === 'camera' ? 'none' : '';
  // Webcam overlay only for screen capture
  if (webcamRow) webcamRow.style.display = selectedMode === 'camera' ? 'none' : '';
  // Camera device row always visible (needed for webcam overlay + camera mode)
}

(document.getElementById('opt-resolution') as HTMLSelectElement)?.addEventListener('change', (e) => {
  selectedResolution = (e.target as HTMLSelectElement).value as RecordingResolution;
});

(document.getElementById('opt-format') as HTMLSelectElement)?.addEventListener('change', (e) => {
  selectedFormat = (e.target as HTMLSelectElement).value as RecordingFormat;
});

// ─── Countdown spinner ────────────────────────────────────────────────────────

function updateCountdownDisplay() {
  const el = document.getElementById('countdown-val');
  if (el) el.textContent = String(countdownSeconds);
}

document.getElementById('btn-countdown-down')?.addEventListener('click', () => {
  if (countdownSeconds > 1) { countdownSeconds--; updateCountdownDisplay(); }
});
document.getElementById('btn-countdown-up')?.addEventListener('click', () => {
  if (countdownSeconds < 10) { countdownSeconds++; updateCountdownDisplay(); }
});

// ─── Annotate local / clipboard image ────────────────────────────────────────

document.getElementById('btn-annotate-image')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/annotate/annotate.html') });
  window.close();
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

  const countdownEnabled = (document.getElementById('opt-countdown') as HTMLInputElement).checked;
  const options: RecordingOptions = {
    mode: selectedMode,
    webcam: (document.getElementById('opt-webcam') as HTMLInputElement).checked,
    mic: (document.getElementById('opt-mic') as HTMLInputElement).checked,
    format: selectedFormat,
    resolution: selectedResolution,
    systemAudio: (document.getElementById('opt-system-audio') as HTMLInputElement).checked,
    countdownSeconds: countdownEnabled ? countdownSeconds : 0,
  };

  const startTime = Date.now();
  await chrome.storage.local.set({
    [STORAGE_KEY]: { active: true, startTime, tabId: tab.tabId } satisfies RecordingState,
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

    const msg: RecorderMessage = { action: 'beginRecording', options, startTime };
    await chrome.tabs.sendMessage(tab.tabId, msg);

    showActiveRecording(startTime);
  } catch (err) {
    await chrome.storage.local.remove(STORAGE_KEY);
    console.error('[SnapMonk] Recording start failed:', err);
  }
});

// ─── Stop recording from popup ────────────────────────────────────────────────

document.getElementById('btn-record-stop')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-record-stop') as HTMLButtonElement;
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Stopping…';

  const stored = await chrome.storage.local.get(STORAGE_KEY) as Record<string, RecordingState>;
  const state = stored[STORAGE_KEY] as RecordingState | undefined;
  if (!state?.tabId) { btn.disabled = false; return; }

  try {
    // Do NOT call tabs.update here — switching tabs closes the popup mid-await,
    // which silently drops the sendMessage call and requires a second click.
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
updateModeUI();
