import type { ContentMessage, BackgroundMessage, CropRect } from '../utils/types';

// Guard: only inject once
if (!(window as unknown as Record<string, boolean>)['__snapmonk_overlay__']) {
  (window as unknown as Record<string, boolean>)['__snapmonk_overlay__'] = true;
  initOverlay();
}

function initOverlay() {
  try {
    chrome.runtime.onMessage.addListener((msg: ContentMessage) => {
      if (msg.action === 'showRegionOverlay') startRegionSelect();
      if (msg.action === 'showElementPicker') startElementPick();
      if (msg.action === 'cancelOverlay') teardown();
    });
  } catch {
    // Extension context invalidated (e.g. extension reloaded while tab was open)
  }
}

// ─── Region Selection ─────────────────────────────────────────────────────────

function startRegionSelect() {
  teardown();
  const overlay = createOverlay('region');

  let startX = 0, startY = 0;
  let selection: HTMLDivElement | null = null;
  let isDrawing = false;

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    isDrawing = true;
    startX = e.clientX;
    startY = e.clientY;
    selection = document.createElement('div');
    selection.className = 'sm-selection';
    overlay.appendChild(selection);
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!isDrawing || !selection) return;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    Object.assign(selection.style, {
      left: `${x}px`, top: `${y}px`,
      width: `${w}px`, height: `${h}px`,
    });
    updateHint(selection, w, h);
  };

  const onMouseUp = (e: MouseEvent) => {
    if (!isDrawing || !selection) return;
    isDrawing = false;
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    if (w < 10 || h < 10) { teardown(); return; }

    const dpr = window.devicePixelRatio || 1;
    const rect: CropRect = {
      x: Math.min(e.clientX, startX) * dpr,
      y: Math.min(e.clientY, startY) * dpr,
      width: w * dpr,
      height: h * dpr,
      devicePixelRatio: dpr,
    };
    teardown();
    // Wait for the browser to repaint without the overlay before screenshotting
    setTimeout(() => sendToBackground({ action: 'regionSelected', rect }), 200);
  };

  overlay.addEventListener('mousedown', onMouseDown);
  overlay.addEventListener('mousemove', onMouseMove);
  overlay.addEventListener('mouseup', onMouseUp);
  overlay.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') teardown();
  });
  overlay.tabIndex = 0;
  overlay.focus();
}

// ─── Element Picker ───────────────────────────────────────────────────────────

function startElementPick() {
  teardown();
  createOverlay('element');

  const highlight = document.createElement('div');
  highlight.className = 'sm-element-highlight';
  document.body.appendChild(highlight);

  let lastEl: Element | null = null;

  const onMouseMove = (e: MouseEvent) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === lastEl || el.classList.contains('sm-overlay')) return;
    lastEl = el;
    const r = el.getBoundingClientRect();
    Object.assign(highlight.style, {
      left: `${r.left + window.scrollX}px`,
      top: `${r.top + window.scrollY}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  };

  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.classList.contains('sm-overlay')) { teardown(); return; }
    const r = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const rect: CropRect = {
      x: r.left * dpr,
      y: r.top * dpr,
      width: r.width * dpr,
      height: r.height * dpr,
      devicePixelRatio: dpr,
    };
    highlight.remove();
    teardown();
    sendToBackground({ action: 'elementSelected', rect });
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('click', onClick, { capture: true, once: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { highlight.remove(); teardown(); }
  }, { once: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let activeOverlay: HTMLDivElement | null = null;

function createOverlay(mode: 'region' | 'element'): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.className = `sm-overlay sm-overlay--${mode}`;
  overlay.id = 'sm-overlay';
  document.body.appendChild(overlay);
  activeOverlay = overlay;
  return overlay;
}

function teardown() {
  document.getElementById('sm-overlay')?.remove();
  document.querySelector('.sm-element-highlight')?.remove();
  activeOverlay = null;
}

function updateHint(el: HTMLDivElement, w: number, h: number) {
  let hint = el.querySelector('.sm-hint') as HTMLDivElement | null;
  if (!hint) {
    hint = document.createElement('div');
    hint.className = 'sm-hint';
    el.appendChild(hint);
  }
  hint.textContent = `${Math.round(w)} × ${Math.round(h)}`;
}

function sendToBackground(msg: BackgroundMessage) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {
      setTimeout(() => { try { chrome.runtime.sendMessage(msg); } catch {} }, 300);
    });
  } catch {}
}
