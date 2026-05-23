import { saveCapture, dataUrlToBlob, generateId } from '../utils/db';
import type {
  CaptureRecord,
  PageInfo,
  SliceMeta,
  PopupMessage,
  BackgroundMessage,
  CaptureType,
  CropRect,
} from '../utils/types';

// ─── Setup ────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenus();
});

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'sm-visible',
      title: 'SnapMonk: Capture Visible Area',
      contexts: ['page', 'image'],
    });
    chrome.contextMenus.create({
      id: 'sm-fullpage',
      title: 'SnapMonk: Capture Full Page',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'sm-region',
      title: 'SnapMonk: Select Region',
      contexts: ['page'],
    });
  });
}

// ─── Context Menu ─────────────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const map: Record<string, CaptureType> = {
    'sm-visible': 'visible',
    'sm-fullpage': 'fullpage',
    'sm-region': 'region',
  };
  const type = map[info.menuItemId as string];
  if (type) await dispatch(type, tab.id, tab.windowId ?? 0);
});

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const map: Record<string, CaptureType> = {
    'capture-visible': 'visible',
    'capture-fullpage': 'fullpage',
    'capture-region': 'region',
  };
  const type = map[command];
  if (type) await dispatch(type, tab.id, tab.windowId ?? 0);
});

// ─── Popup Messages ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (msg: PopupMessage | BackgroundMessage, _sender, sendResponse) => {
    if ('action' in msg) {
      handleMessage(msg as PopupMessage | BackgroundMessage)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
  },
);

async function handleMessage(msg: PopupMessage | BackgroundMessage): Promise<void> {
  if (msg.action === 'regionSelected') {
    await handleRegionCaptured(msg.rect);
    return;
  }
  if (msg.action === 'elementSelected') {
    await handleRegionCaptured(msg.rect);
    return;
  }
  const pm = msg as PopupMessage;
  await dispatch(
    pm.action === 'captureVisible'
      ? 'visible'
      : pm.action === 'captureFullPage'
        ? 'fullpage'
        : pm.action === 'captureRegion'
          ? 'region'
          : 'element',
    pm.tabId,
    pm.windowId,
  );
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

async function dispatch(type: CaptureType, tabId: number, windowId: number): Promise<void> {
  try {
    switch (type) {
      case 'visible':
        return await captureVisible(tabId, windowId);
      case 'fullpage':
        return await captureFullPage(tabId, windowId);
      case 'region':
        return await startRegionSelect(tabId, windowId);
      case 'element':
        return await startElementPick(tabId, windowId);
    }
  } catch (err) {
    console.error('[SnapMonk] Capture error:', err);
    showBadgeError(tabId);
  }
}

// ─── Capture: Visible Area ────────────────────────────────────────────────────

async function captureVisible(tabId: number, windowId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  // Give the popup time to fully close so it doesn't affect the captured viewport
  await sleep(150);
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const blob = await dataUrlToBlob(dataUrl);
  const id = generateId();

  const record: CaptureRecord = {
    id,
    type: 'visible',
    slices: [blob],
    metadata: {
      url: tab.url ?? '',
      title: tab.title ?? 'Screenshot',
      timestamp: Date.now(),
    },
  };
  await saveCapture(record);
  await openEditor(id);
}

// ─── Capture: Full Page ───────────────────────────────────────────────────────

async function captureFullPage(tabId: number, windowId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  // Give the popup time to fully close
  await sleep(150);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollHeight: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.documentElement.offsetHeight,
      ),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      scrollY: window.scrollY,
      scrollX: window.scrollX,
      devicePixelRatio: window.devicePixelRatio || 1,
    }),
  });

  const pageRaw = results[0]?.result as {
    scrollHeight: number;
    viewportHeight: number;
    viewportWidth: number;
    scrollY: number;
    scrollX: number;
    devicePixelRatio: number;
  } | undefined;

  if (!pageRaw) throw new Error('Could not read page dimensions');

  const { scrollHeight, viewportHeight, viewportWidth, scrollX, scrollY: origY, devicePixelRatio } = pageRaw;

  // Scroll to top
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => { window.scrollTo(0, 0); },
  });
  await sleep(250);

  // Read once before the loop. Chrome enforces ~2 captureVisibleTab calls/sec,
  // so we floor at 600ms to stay safely under the quota.
  const { pref_scroll_delay } = await chrome.storage.sync.get({ pref_scroll_delay: '600' });
  const scrollDelay = Math.max(600, parseInt(pref_scroll_delay as string, 10) || 600);

  const sliceBlobs: Blob[] = [];
  const sliceMeta: SliceMeta[] = [];
  let requestedY = 0;

  while (requestedY < scrollHeight) {
    const actualY = Math.min(requestedY, Math.max(0, scrollHeight - viewportHeight));

    await chrome.scripting.executeScript({
      target: { tabId },
      func: (y: number) => { window.scrollTo(0, y); },
      args: [actualY],
    });
    await sleep(scrollDelay);

    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    sliceBlobs.push(await dataUrlToBlob(dataUrl));
    sliceMeta.push({ requestedY, actualY });

    requestedY += viewportHeight;
  }

  // Restore scroll
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (x: number, y: number) => { window.scrollTo(x, y); },
    args: [scrollX, origY],
  });

  const id = generateId();
  const pageInfo: PageInfo = {
    scrollHeight,
    viewportHeight,
    viewportWidth,
    devicePixelRatio,
    sliceMeta,
  };

  const record: CaptureRecord = {
    id,
    type: 'fullpage',
    slices: sliceBlobs,
    metadata: {
      url: tab.url ?? '',
      title: tab.title ?? 'Full Page Screenshot',
      timestamp: Date.now(),
      pageInfo,
    },
  };
  await saveCapture(record);
  await openEditor(id);
}

// ─── Capture: Region / Element ────────────────────────────────────────────────

// Store which tab started region/element selection so we capture the right one
let pendingRegionTabId = 0;
let pendingRegionWindowId = 0;

async function startRegionSelect(tabId: number, windowId: number): Promise<void> {
  pendingRegionTabId = tabId;
  pendingRegionWindowId = windowId;
  await injectOverlay(tabId);
  await chrome.tabs.sendMessage(tabId, { action: 'showRegionOverlay' });
}

async function startElementPick(tabId: number, windowId: number): Promise<void> {
  pendingRegionTabId = tabId;
  pendingRegionWindowId = windowId;
  await injectOverlay(tabId);
  await chrome.tabs.sendMessage(tabId, { action: 'showElementPicker' });
}

async function handleRegionCaptured(rect: CropRect): Promise<void> {
  // Use the stored tab from when region select started — service worker has no "currentWindow"
  const tabId = pendingRegionTabId;
  const windowId = pendingRegionWindowId;
  if (!tabId || !windowId) return;

  const tab = await chrome.tabs.get(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const blob = await dataUrlToBlob(dataUrl);
  const id = generateId();

  pendingRegionTabId = 0;
  pendingRegionWindowId = 0;

  const record: CaptureRecord = {
    id,
    type: 'region',
    slices: [blob],
    metadata: {
      url: tab.url ?? '',
      title: tab.title ?? 'Region Screenshot',
      timestamp: Date.now(),
      crop: rect,
    },
  };
  await saveCapture(record);
  await openEditor(id);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function injectOverlay(tabId: number): Promise<void> {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['src/content/overlay.css'],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/content/overlay.js'],
  });
}

async function openEditor(captureId: string): Promise<void> {
  const url = chrome.runtime.getURL(`src/editor/editor.html?id=${captureId}`);
  await chrome.tabs.create({ url });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function showBadgeError(tabId: number): void {
  chrome.action.setBadgeText({ tabId, text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#F85149' });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 3000);
}
