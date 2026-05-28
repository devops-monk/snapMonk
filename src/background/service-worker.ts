import { saveCapture, dataUrlToBlob, generateId, savePendingRecording } from '../utils/db';
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

  const action = (msg as { action: string }).action;

  // Content script sends the finished recording blob here; we store it in the
  // extension's IndexedDB (same origin as preview.html) then open the preview.
  if (action === 'saveRecording') {
    const m = msg as { base64: string; mimeType: string; createdAt: number; duration: number };
    const binary = atob(m.base64);
    const uint8 = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) uint8[i] = binary.charCodeAt(i);
    const blob = new Blob([uint8], { type: m.mimeType });
    await savePendingRecording({ blob, mimeType: m.mimeType, createdAt: m.createdAt, duration: m.duration });
    await chrome.storage.local.remove('snapmonk_recording_state');
    const url = chrome.runtime.getURL('src/preview/preview.html');
    await chrome.tabs.create({ url });
    return;
  }

  // When the recorder toolbar finishes (or errors), clear the recording state
  // so the popup shows the correct UI even if it was closed during recording.
  if (action === 'recordingStopped' || action === 'recordingError') {
    await chrome.storage.local.remove('snapmonk_recording_state');
    return;
  }

  // Legacy: direct openPreviewPage request (kept as fallback)
  if (action === 'openPreviewPage') {
    const url = chrome.runtime.getURL('src/preview/preview.html');
    await chrome.tabs.create({ url });
    return;
  }

  // Ignore any other non-capture messages that pass through the generic listener.
  const pm = msg as PopupMessage;
  if (!['captureVisible', 'captureFullPage', 'captureRegion', 'captureElement'].includes(pm.action)) {
    return;
  }
  if (!pm.tabId) return;

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

// ─── Restricted-URL guard ─────────────────────────────────────────────────────

function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  const restrictedPrefixes = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'brave://'];
  if (restrictedPrefixes.some((p) => url.startsWith(p))) return true;
  const restrictedHosts = ['chrome.google.com', 'chromewebstore.google.com'];
  try {
    if (restrictedHosts.includes(new URL(url).hostname)) return true;
  } catch { /* invalid URL */ }
  return false;
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

async function dispatch(type: CaptureType, tabId: number, windowId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isRestrictedUrl(tab.url)) {
      showBadgeError(tabId);
      return;
    }
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
  // Close popup → refocus window → wait for tab to repaint at full viewport size.
  // A fixed sleep isn't enough because the popup overlay can occlude the right
  // side and the tab's render cache needs two animation frames to fully refresh.
  await sleep(200);
  await chrome.windows.update(windowId, { focused: true });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  }).catch(() => {});
  await sleep(50);
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
    func: () => {
      // Detect a primary inner scrollable container for SPA-style pages (Jira, GitLab, etc.)
      // where the document body doesn't scroll but a large inner element does.
      function detectInnerScroller() {
        const docScrollHeight = Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight,
          document.documentElement.offsetHeight,
        );
        if (docScrollHeight > window.innerHeight + 50) return null; // page scrolls normally

        let best: HTMLElement | null = null;
        let bestScrollHeight = 0;
        document.querySelectorAll<HTMLElement>('*').forEach((el) => {
          const oy = window.getComputedStyle(el).overflowY;
          if (oy !== 'auto' && oy !== 'scroll') return;
          const sh = el.scrollHeight;
          const ch = el.clientHeight;
          if (sh <= ch + 50) return;           // not meaningfully scrollable
          if (ch < window.innerHeight * 0.3) return; // too small to be main content
          if (sh > bestScrollHeight) { bestScrollHeight = sh; best = el; }
        });
        if (!best) return null;
        best.setAttribute('data-sm-scroller', '1');
        const rect = best.getBoundingClientRect();
        return {
          scrollHeight: best.scrollHeight,
          clientHeight: best.clientHeight,
          clientWidth: best.clientWidth,
          scrollTop: best.scrollTop,
          rectTop: rect.top,
          rectLeft: rect.left,
        };
      }

      const inner = detectInnerScroller();
      const docScrollHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.documentElement.offsetHeight,
      );
      return {
        scrollHeight: inner?.scrollHeight ?? docScrollHeight,
        viewportHeight: inner?.clientHeight ?? window.innerHeight,
        viewportWidth: inner?.clientWidth ?? window.innerWidth,
        windowScrollY: window.scrollY,
        windowScrollX: window.scrollX,
        containerScrollTop: inner?.scrollTop ?? 0,
        devicePixelRatio: window.devicePixelRatio || 1,
        // Rect to crop each screenshot to (null = full viewport / window scroll mode)
        containerRect: inner
          ? { top: inner.rectTop, left: inner.rectLeft, width: inner.clientWidth, height: inner.clientHeight }
          : null,
      };
    },
  });

  const pageRaw = results[0]?.result as {
    scrollHeight: number;
    viewportHeight: number;
    viewportWidth: number;
    windowScrollY: number;
    windowScrollX: number;
    containerScrollTop: number;
    devicePixelRatio: number;
    containerRect: { top: number; left: number; width: number; height: number } | null;
  } | undefined;

  if (!pageRaw) throw new Error('Could not read page dimensions');

  const {
    scrollHeight, viewportHeight, viewportWidth,
    windowScrollX, windowScrollY,
    containerScrollTop,
    devicePixelRatio,
    containerRect,
  } = pageRaw;

  const useInnerScroller = !!containerRect;

  // Scroll to top (container or window)
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (inner: boolean) => {
      if (inner) {
        (document.querySelector('[data-sm-scroller]') as HTMLElement | null)?.scrollTo?.(0, 0)
          ?? ((document.querySelector('[data-sm-scroller]') as HTMLElement | null)
            && ((document.querySelector('[data-sm-scroller]') as HTMLElement).scrollTop = 0));
      } else {
        window.scrollTo(0, 0);
      }
    },
    args: [useInnerScroller],
  });
  await sleep(250);

  // Read once before the loop. Chrome enforces ~2 captureVisibleTab calls/sec,
  // so we floor at 600ms to stay safely under the quota.
  const { pref_scroll_delay } = await chrome.storage.sync.get({ pref_scroll_delay: '600' });
  const scrollDelay = Math.max(600, parseInt(pref_scroll_delay as string, 10) || 600);

  const sliceBlobs: Blob[] = [];
  const sliceMeta: SliceMeta[] = [];
  let requestedY = 0;
  let fixedHidden = false;

  while (requestedY < scrollHeight) {
    const actualY = Math.min(requestedY, Math.max(0, scrollHeight - viewportHeight));

    await chrome.scripting.executeScript({
      target: { tabId },
      func: (y: number, inner: boolean) => {
        if (inner) {
          const el = document.querySelector('[data-sm-scroller]') as HTMLElement | null;
          if (el) el.scrollTop = y;
        } else {
          window.scrollTo(0, y);
        }
      },
      args: [actualY, useInnerScroller],
    });
    await sleep(scrollDelay);

    // For window-scroll mode: hide fixed/sticky elements from the second slice onward
    // so they don't repeat when stitched. For inner-scroller mode we crop them out anyway.
    if (!useInnerScroller && requestedY > 0 && !fixedHidden) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          document.querySelectorAll<HTMLElement>('*').forEach((el) => {
            const pos = window.getComputedStyle(el).position;
            if (pos === 'fixed' || pos === 'sticky') {
              el.dataset['smVis'] = el.style.visibility;
              el.style.setProperty('visibility', 'hidden', 'important');
            }
          });
        },
      });
      fixedHidden = true;
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    const blob = containerRect
      ? await cropToRect(dataUrl, containerRect, devicePixelRatio)
      : await dataUrlToBlob(dataUrl);
    sliceBlobs.push(blob);
    sliceMeta.push({ requestedY, actualY });

    requestedY += viewportHeight;
  }

  // Restore fixed/sticky elements (window scroll mode only)
  if (fixedHidden) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        document.querySelectorAll<HTMLElement>('[data-sm-vis]').forEach((el) => {
          el.style.visibility = el.dataset['smVis'] ?? '';
          delete el.dataset['smVis'];
        });
      },
    });
  }

  // Restore scroll positions and remove marker attribute
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (wx: number, wy: number, containerTop: number, inner: boolean) => {
      if (inner) {
        const el = document.querySelector('[data-sm-scroller]') as HTMLElement | null;
        if (el) { el.scrollTop = containerTop; el.removeAttribute('data-sm-scroller'); }
      }
      window.scrollTo(wx, wy);
    },
    args: [windowScrollX, windowScrollY, containerScrollTop, useInnerScroller],
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

async function cropToRect(
  dataUrl: string,
  rect: { top: number; left: number; width: number; height: number },
  dpr: number,
): Promise<Blob> {
  const src = await dataUrlToBlob(dataUrl);
  const bmp = await createImageBitmap(src);
  const x = Math.round(rect.left * dpr);
  const y = Math.round(rect.top * dpr);
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, x, y, w, h, 0, 0, w, h);
  bmp.close();
  return canvas.convertToBlob({ type: 'image/png' });
}

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
