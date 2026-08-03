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

// In-flight chunked recording transfers (transferId → assembled byte parts).
// Chunked handoff removes the single-message size cap so recordings are limited
// by memory/disk, not by Chrome's IPC message size.
const recTransfers = new Map<string, { mimeType: string; createdAt: number; duration: number; parts: Uint8Array[] }>();

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const u8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
  return u8;
}

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

  // Chunked recording handoff — the recorder streams the finished blob in slices
  // (recStart → recChunk* → recEnd) so arbitrarily large recordings get through.
  if (action === 'recStart') {
    const m = msg as unknown as { transferId: string; mimeType: string; createdAt: number; duration: number };
    recTransfers.set(m.transferId, { mimeType: m.mimeType, createdAt: m.createdAt, duration: m.duration, parts: [] });
    return;
  }
  if (action === 'recChunk') {
    const m = msg as unknown as { transferId: string; seq: number; base64: string };
    const t = recTransfers.get(m.transferId);
    if (!t) throw new Error('unknown transfer'); // rejected → recorder falls back to direct download
    t.parts[m.seq] = base64ToBytes(m.base64);
    return;
  }
  if (action === 'recEnd') {
    const m = msg as unknown as { transferId: string };
    const t = recTransfers.get(m.transferId);
    if (!t) throw new Error('unknown transfer');
    recTransfers.delete(m.transferId);
    const blob = new Blob(t.parts as BlobPart[], { type: t.mimeType });
    await savePendingRecording({ blob, mimeType: t.mimeType, createdAt: t.createdAt, duration: t.duration });
    await chrome.storage.local.remove('snapmonk_recording_state');
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/preview/preview.html') });
    return;
  }
  if (action === 'recAbort') {
    recTransfers.delete((msg as unknown as { transferId: string }).transferId);
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

  // Prepare the page for a clean capture, then measure the STABILIZED height:
  //  1. Freeze animations/transitions, force instant scrolling, hide scrollbars.
  //  2. Pre-scroll top→bottom to trigger lazy-loaded images/content, waiting for
  //     images to decode — this is what makes long pages come out complete and
  //     sharp instead of half-loaded.
  //  3. Re-measure the (now stable) scroll height and scroll back to top.
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

      // Freeze the page so scroll positions are exact and nothing animates mid-shot.
      const style = document.createElement('style');
      style.id = 'sm-capture-style';
      style.textContent =
        'html{scroll-behavior:auto !important;}' +
        '*,*::before,*::after{animation-play-state:paused !important;transition:none !important;caret-color:transparent !important;}' +
        '::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important;}' +
        'html{scrollbar-width:none !important;}';
      document.documentElement.appendChild(style);

      // Detect a primary inner scrollable container for SPA-style pages (Jira, GitLab, etc.)
      // where the document body doesn't scroll but a large inner element does.
      function detectInnerScroller() {
        const docSH = Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight,
          document.documentElement.offsetHeight,
        );
        if (docSH > window.innerHeight + 50) return null; // page scrolls normally
        let best: HTMLElement | null = null;
        let bestSH = 0;
        document.querySelectorAll<HTMLElement>('*').forEach((el) => {
          const oy = window.getComputedStyle(el).overflowY;
          if (oy !== 'auto' && oy !== 'scroll') return;
          if (el.scrollHeight <= el.clientHeight + 50) return;
          if (el.clientHeight < window.innerHeight * 0.3) return;
          if (el.scrollHeight > bestSH) { bestSH = el.scrollHeight; best = el; }
        });
        if (!best) return null;
        (best as HTMLElement).setAttribute('data-sm-scroller', '1');
        return best as HTMLElement;
      }

      const inner = detectInnerScroller();
      const docSH = () => Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.documentElement.offsetHeight,
      );
      const getSH = () => (inner ? inner.scrollHeight : docSH());
      const vh = inner ? inner.clientHeight : window.innerHeight;
      const setY = (y: number) => { if (inner) inner.scrollTop = y; else window.scrollTo(0, y); };
      const getY = () => (inner ? inner.scrollTop : window.scrollY);

      const origY = getY();

      // Pre-scroll to trigger lazy loading; the page can grow as content loads.
      let sh = getSH();
      for (let y = 0; y < sh + vh; y += Math.round(vh * 0.9)) {
        setY(y);
        await nap(90);
        sh = getSH();
        if (y > 40000) break; // safety cap for pathologically long pages
      }
      // Wait for images to finish decoding (bounded).
      const pending = Array.from(document.images).filter((im) => !im.complete);
      await Promise.race([
        Promise.all(pending.map((im) => im.decode().catch(() => undefined))),
        nap(1500),
      ]);
      sh = getSH();
      setY(0);
      await nap(150);

      return {
        scrollHeight: sh,
        viewportHeight: vh,
        viewportWidth: inner ? inner.clientWidth : window.innerWidth,
        windowScrollY: inner ? window.scrollY : origY,
        windowScrollX: window.scrollX,
        containerScrollTop: inner ? origY : 0,
        devicePixelRatio: window.devicePixelRatio || 1,
        containerRect: inner
          ? (() => {
              const r = inner.getBoundingClientRect();
              return { top: r.top, left: r.left, width: inner.clientWidth, height: inner.clientHeight };
            })()
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
  await sleep(200);

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

    const dataUrl = await captureVisibleTabSafe(windowId);
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

  // Restore scroll positions, remove the marker attribute, and drop the capture
  // style so the page returns exactly to how the user left it.
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (wx: number, wy: number, containerTop: number, inner: boolean) => {
      if (inner) {
        const el = document.querySelector('[data-sm-scroller]') as HTMLElement | null;
        if (el) { el.scrollTop = containerTop; el.removeAttribute('data-sm-scroller'); }
      }
      window.scrollTo(wx, wy);
      document.getElementById('sm-capture-style')?.remove();
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

// captureVisibleTab is rate-limited by Chrome (~2 calls/sec). On a full-page
// capture with many slices we can still trip it, so retry with backoff instead
// of dropping a slice (which would leave a gap in the stitched image).
async function captureVisibleTabSafe(windowId: number): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      lastErr = err;
      await sleep(700 + attempt * 300);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('captureVisibleTab failed');
}

function showBadgeError(tabId: number): void {
  chrome.action.setBadgeText({ tabId, text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#F85149' });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 3000);
}
