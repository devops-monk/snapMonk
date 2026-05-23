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
        return captureVisible(tabId, windowId);
      case 'fullpage':
        return captureFullPage(tabId, windowId);
      case 'region':
        return startRegionSelect(tabId);
      case 'element':
        return startElementPick(tabId);
    }
  } catch (err) {
    console.error('[SnapMonk] Capture error:', err);
    showBadgeError(tabId);
  }
}

// ─── Capture: Visible Area ────────────────────────────────────────────────────

async function captureVisible(tabId: number, windowId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
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

  const [{ result: raw }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollHeight: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      ),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      scrollY: window.scrollY,
      scrollX: window.scrollX,
      devicePixelRatio: window.devicePixelRatio || 1,
    }),
  });

  const pageRaw = raw as {
    scrollHeight: number;
    viewportHeight: number;
    viewportWidth: number;
    scrollY: number;
    scrollX: number;
    devicePixelRatio: number;
  };

  const { scrollHeight, viewportHeight, viewportWidth, scrollX, scrollY: origY, devicePixelRatio } = pageRaw;

  // Scroll to top
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => { window.scrollTo(0, 0); },
  });
  await sleep(250);

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
    await sleep(180);

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

async function startRegionSelect(tabId: number): Promise<void> {
  await injectOverlay(tabId);
  await chrome.tabs.sendMessage(tabId, { action: 'showRegionOverlay' });
}

async function startElementPick(tabId: number): Promise<void> {
  await injectOverlay(tabId);
  await chrome.tabs.sendMessage(tabId, { action: 'showElementPicker' });
}

async function handleRegionCaptured(rect: CropRect): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId) return;

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const blob = await dataUrlToBlob(dataUrl);
  const id = generateId();

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
