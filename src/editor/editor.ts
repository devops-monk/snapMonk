import {
  Canvas,
  FabricImage,
  PencilBrush,
  Rect,
  Ellipse,
  Textbox,
  FabricText,
  Path,
  Point,
  type TPointerEvent,
} from 'fabric';
import { getCapture } from '../utils/db';
import type { CaptureRecord, PageInfo, SliceMeta } from '../utils/types';
import { initSharePanel } from '../integrations/share-panel';
import { initBugReportPanel } from '../ai/bug-report-panel';

// ─── State ────────────────────────────────────────────────────────────────────

type Tool = 'select' | 'arrow' | 'line' | 'rect' | 'circle' | 'text' | 'pen' | 'callout' | 'highlight' | 'blur' | 'redact' | 'step' | 'crop';

const state = {
  tool: 'select' as Tool,
  color: '#F85149',
  strokeWidth: 3,
  fontSize: 20,
  fillMode: 'outline' as 'outline' | 'filled',
  stepCounter: 1,
  zoom: 1,
  isDrawing: false,
  startPoint: { x: 0, y: 0 },
  activeShape: null as unknown,
  history: [] as string[],
  historyIndex: -1,
};

let canvas: Canvas;
let baseImageUrl = '';
let isRestoringHistory = false;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const params = new URLSearchParams(location.search);
  const captureId = params.get('id');

  if (!captureId) {
    showError('No capture ID provided.');
    return;
  }

  const record = await getCapture(captureId);
  if (!record) {
    showError('Capture not found. It may have been deleted.');
    return;
  }

  updateLoadingText('Processing image…');

  const imageUrl = await processCapture(record);
  baseImageUrl = imageUrl;

  await initCanvas(imageUrl);
  hideLoading();
  setupTools();
  setupKeyboard();
  setupZoom();
  setupExport();
  initSharePanel(renderFlatCanvas);
  initBugReportPanel(renderFlatCanvas);
  pushHistory();

  // Set filename from page title
  const filename = record.metadata.title
    .replace(/[^a-z0-9\-_\s]/gi, '')
    .trim()
    .replace(/\s+/g, '-')
    .substring(0, 60) || 'snapmonk-capture';
  (document.getElementById('filename-input') as HTMLInputElement).value = filename;
}

// ─── Image Processing ─────────────────────────────────────────────────────────

async function processCapture(record: CaptureRecord): Promise<string> {
  switch (record.type) {
    case 'visible':
    case 'region':
    case 'element': {
      const url = URL.createObjectURL(record.slices[0]!);
      if (record.metadata.crop) {
        return cropImage(url, record.metadata.crop);
      }
      return url;
    }
    case 'fullpage':
      return stitchImages(record.slices, record.metadata.pageInfo!);
  }
}

async function stitchImages(slices: Blob[], pageInfo: PageInfo): Promise<string> {
  updateLoadingText(`Stitching ${slices.length} slices…`);
  const { scrollHeight, viewportHeight, viewportWidth, devicePixelRatio: dpr, sliceMeta } = pageInfo;

  const firstBmp = await createImageBitmap(slices[0]!);
  const imgW = firstBmp.width;
  const totalH = Math.ceil(scrollHeight * dpr);

  const offscreen = new OffscreenCanvas(imgW, totalH);
  const ctx = offscreen.getContext('2d')!;

  const draw = async (bmp: ImageBitmap, meta: SliceMeta) => {
    const srcOffsetY = Math.round((meta.requestedY - meta.actualY) * dpr);
    const destY = Math.round(meta.requestedY * dpr);
    const pageH = Math.min(viewportHeight, scrollHeight - meta.requestedY);
    const copyH = Math.round(pageH * dpr);
    ctx.drawImage(bmp, 0, srcOffsetY, imgW, copyH, 0, destY, imgW, copyH);
    bmp.close();
  };

  await draw(firstBmp, sliceMeta[0]!);
  for (let i = 1; i < slices.length; i++) {
    const bmp = await createImageBitmap(slices[i]!);
    await draw(bmp, sliceMeta[i]!);
  }

  const blob = await offscreen.convertToBlob({ type: 'image/png' });
  return URL.createObjectURL(blob);
}

async function cropImage(
  url: string,
  crop: { x: number; y: number; width: number; height: number },
): Promise<string> {
  const img = await loadImg(url);
  const offscreen = new OffscreenCanvas(crop.width, crop.height);
  const ctx = offscreen.getContext('2d')!;
  ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  const blob = await offscreen.convertToBlob({ type: 'image/png' });
  return URL.createObjectURL(blob);
}

// ─── Canvas Init ──────────────────────────────────────────────────────────────

async function initCanvas(imageUrl: string) {
  const img = await loadImg(imageUrl);
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(img.naturalWidth / dpr);
  const H = Math.round(img.naturalHeight / dpr);

  canvas = new Canvas('editor-canvas', {
    width: W,
    height: H,
    selection: true,
    preserveObjectStacking: true,
  });

  const bgImage = await FabricImage.fromURL(imageUrl);
  bgImage.set({
    selectable: false,
    evented: false,
    scaleX: W / img.naturalWidth,
    scaleY: H / img.naturalHeight,
  });
  canvas.backgroundImage = bgImage;
  canvas.renderAll();

  requestAnimationFrame(() => fitToScreen());
}

// ─── Tools ────────────────────────────────────────────────────────────────────

function setupTools() {
  // Tool buttons
  document.querySelectorAll<HTMLButtonElement>('.tool-btn[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset['tool'] as Tool));
  });

  // Color swatches
  document.querySelectorAll<HTMLDivElement>('.swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
      sw.classList.add('active');
      state.color = sw.dataset['color']!;
      syncPenBrush();
      updateActiveObjectColor();
    });
  });

  // Custom color picker
  const customColorInput = document.getElementById('custom-color') as HTMLInputElement;
  customColorInput.addEventListener('input', () => {
    state.color = customColorInput.value;
    document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
    syncPenBrush();
    updateActiveObjectColor();
  });

  // Fill toggle
  document.getElementById('btn-fill-outline')?.addEventListener('click', () => {
    state.fillMode = 'outline';
    document.getElementById('btn-fill-outline')?.classList.add('active');
    document.getElementById('btn-fill-filled')?.classList.remove('active');
  });
  document.getElementById('btn-fill-filled')?.addEventListener('click', () => {
    state.fillMode = 'filled';
    document.getElementById('btn-fill-filled')?.classList.add('active');
    document.getElementById('btn-fill-outline')?.classList.remove('active');
  });

  // Stroke slider
  const strokeSlider = document.getElementById('stroke-slider') as HTMLInputElement;
  strokeSlider.addEventListener('input', () => {
    state.strokeWidth = Number(strokeSlider.value);
    (document.getElementById('stroke-val') as HTMLSpanElement).textContent =
      `${state.strokeWidth}px`;
    syncPenBrush();
    updateActiveObjectStroke();
  });

  // Font size slider
  const fontSlider = document.getElementById('fontsize-slider') as HTMLInputElement;
  fontSlider.addEventListener('input', () => {
    state.fontSize = Number(fontSlider.value);
    (document.getElementById('fontsize-val') as HTMLSpanElement).textContent =
      `${state.fontSize}px`;
  });

  // Delete selected
  document.getElementById('btn-delete')?.addEventListener('click', deleteSelected);

  // Canvas mouse events
  canvas.on('mouse:down', onMouseDown);
  canvas.on('mouse:move', onMouseMove);
  canvas.on('mouse:up', onMouseUp);
  canvas.on('object:added', () => pushHistory());
  canvas.on('object:modified', () => pushHistory());
  canvas.on('object:removed', () => pushHistory());
}

function setTool(tool: Tool) {
  state.tool = tool;

  document.querySelectorAll('.tool-btn[data-tool]').forEach((b) => b.classList.remove('active'));
  document.querySelector(`[data-tool="${tool}"]`)?.classList.add('active');

  // Contextual property panels
  const shapeStyle = document.getElementById('shape-style') as HTMLDivElement;
  const fontsizeSection = document.getElementById('fontsize-section') as HTMLDivElement;
  shapeStyle.style.display = (tool === 'rect' || tool === 'circle') ? '' : 'none';
  fontsizeSection.style.display = (tool === 'text' || tool === 'callout') ? '' : 'none';

  if (tool === 'select') {
    canvas.isDrawingMode = false;
    canvas.selection = true;
    canvas.forEachObject((o) => { o.selectable = true; });
  } else if (tool === 'pen') {
    canvas.isDrawingMode = true;
    if (!canvas.freeDrawingBrush) {
      canvas.freeDrawingBrush = new PencilBrush(canvas);
    }
    canvas.freeDrawingBrush.color = state.color;
    canvas.freeDrawingBrush.width = state.strokeWidth;
    canvas.selection = false;
  } else {
    canvas.isDrawingMode = false;
    canvas.selection = false;
    canvas.forEachObject((o) => { o.selectable = false; });
    canvas.discardActiveObject();
    canvas.renderAll();
  }
}

function syncPenBrush() {
  if (state.tool !== 'pen' || !canvas.freeDrawingBrush) return;
  canvas.freeDrawingBrush.color = state.color;
  canvas.freeDrawingBrush.width = state.strokeWidth;
}

// ─── Mouse Drawing ────────────────────────────────────────────────────────────

function getCanvasPoint(e: TPointerEvent): Point {
  return canvas.getScenePoint(e);
}

function onMouseDown(opt: { e: TPointerEvent }) {
  if (state.tool === 'select' || state.tool === 'pen' || state.tool === 'callout') return;
  state.isDrawing = true;
  const p = getCanvasPoint(opt.e);
  state.startPoint = { x: p.x, y: p.y };
  state.activeShape = null;

  if (state.tool === 'text') {
    addText(p.x, p.y);
    state.isDrawing = false;
  } else if (state.tool === 'callout') {
    addCallout(p.x, p.y);
    state.isDrawing = false;
  } else if (state.tool === 'step') {
    addStep(p.x, p.y);
    state.isDrawing = false;
  }
}

function onMouseMove(opt: { e: TPointerEvent }) {
  if (!state.isDrawing) return;
  const p = getCanvasPoint(opt.e);
  const { x: sx, y: sy } = state.startPoint;

  if (state.activeShape) {
    canvas.remove(state.activeShape as never);
  }

  let shape: unknown = null;

  switch (state.tool) {
    case 'arrow':
      shape = makeArrow(sx, sy, p.x, p.y);
      break;
    case 'line':
      shape = makeLine(sx, sy, p.x, p.y);
      break;
    case 'rect':
      shape = makeRect(sx, sy, p.x - sx, p.y - sy);
      break;
    case 'circle':
      shape = makeEllipse(sx, sy, p.x, p.y);
      break;
    case 'highlight':
      shape = makeHighlight(sx, sy, p.x - sx, p.y - sy);
      break;
    case 'blur':
    case 'redact':
      shape = makeDashedPreview(sx, sy, p.x - sx, p.y - sy);
      break;
    case 'crop':
      shape = makeCropPreview(sx, sy, p.x - sx, p.y - sy);
      break;
  }

  if (shape) {
    canvas.add(shape as never);
    state.activeShape = shape;
    canvas.renderAll();
  }
}

async function onMouseUp(opt: { e: TPointerEvent }) {
  if (!state.isDrawing) return;
  state.isDrawing = false;
  const p = getCanvasPoint(opt.e);
  const { x: sx, y: sy } = state.startPoint;

  const x = Math.min(sx, p.x);
  const y = Math.min(sy, p.y);
  const w = Math.abs(p.x - sx);
  const h = Math.abs(p.y - sy);

  if ((state.tool === 'blur' || state.tool === 'redact' || state.tool === 'crop') && state.activeShape) {
    canvas.remove(state.activeShape as never);
    state.activeShape = null;
    if (w > 4 && h > 4) {
      if (state.tool === 'blur') await applyBlur(x, y, w, h);
      else if (state.tool === 'redact') applyRedact(x, y, w, h);
      else if (state.tool === 'crop') await applyCrop(x, y, w, h);
    }
    return;
  }

  if (state.activeShape) {
    (state.activeShape as { selectable: boolean }).selectable = true;
    canvas.setActiveObject(state.activeShape as never);
    canvas.renderAll();
    state.activeShape = null;
  }
}

// ─── Shape Factories ──────────────────────────────────────────────────────────

function makeArrow(x1: number, y1: number, x2: number, y2: number): Path {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 2) return new Path('', { selectable: false });

  const angle = Math.atan2(dy, dx);
  const headLen = Math.max(14, state.strokeWidth * 4.5);
  const headAngle = 0.42; // ~24 degrees

  const tx = x2, ty = y2;
  const wx1 = tx - headLen * Math.cos(angle - headAngle);
  const wy1 = ty - headLen * Math.sin(angle - headAngle);
  const wx2 = tx - headLen * Math.cos(angle + headAngle);
  const wy2 = ty - headLen * Math.sin(angle + headAngle);

  const d = `M ${x1} ${y1} L ${tx} ${ty} M ${wx1} ${wy1} L ${tx} ${ty} L ${wx2} ${wy2}`;

  return new Path(d, {
    stroke: state.color,
    strokeWidth: state.strokeWidth,
    fill: 'transparent',
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
    selectable: false,
    objectCaching: false,
  });
}

function makeRect(x: number, y: number, w: number, h: number): Rect {
  const filled = state.fillMode === 'filled';
  return new Rect({
    left: Math.min(x, x + w),
    top: Math.min(y, y + h),
    width: Math.abs(w),
    height: Math.abs(h),
    stroke: state.color,
    strokeWidth: filled ? 0 : state.strokeWidth,
    fill: filled ? state.color : 'transparent',
    strokeUniform: true,
    selectable: false,
  });
}

function makeEllipse(x1: number, y1: number, x2: number, y2: number): Ellipse {
  const rx = Math.abs(x2 - x1) / 2;
  const ry = Math.abs(y2 - y1) / 2;
  const filled = state.fillMode === 'filled';
  return new Ellipse({
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    rx,
    ry,
    stroke: state.color,
    strokeWidth: filled ? 0 : state.strokeWidth,
    fill: filled ? state.color : 'transparent',
    strokeUniform: true,
    selectable: false,
  });
}

function makeHighlight(x: number, y: number, w: number, h: number): Rect {
  return new Rect({
    left: Math.min(x, x + w),
    top: Math.min(y, y + h),
    width: Math.abs(w),
    height: Math.abs(h),
    fill: hexToRgba(state.color, 0.35),
    stroke: 'transparent',
    selectable: false,
  });
}

function makeDashedPreview(x: number, y: number, w: number, h: number): Rect {
  return new Rect({
    left: Math.min(x, x + w),
    top: Math.min(y, y + h),
    width: Math.abs(w),
    height: Math.abs(h),
    fill: 'transparent',
    stroke: '#fff',
    strokeWidth: 2,
    strokeDashArray: [6, 4],
    selectable: false,
  });
}

function makeCropPreview(x: number, y: number, w: number, h: number): Rect {
  const lx = Math.min(x, x + w), ly = Math.min(y, y + h);
  const aw = Math.abs(w), ah = Math.abs(h);
  return new Rect({
    left: lx, top: ly, width: aw, height: ah,
    fill: 'rgba(0,0,0,0.35)',
    stroke: '#fff',
    strokeWidth: 1.5,
    strokeDashArray: [5, 3],
    selectable: false,
  });
}

function makeLine(x1: number, y1: number, x2: number, y2: number): Path {
  return new Path(`M ${x1} ${y1} L ${x2} ${y2}`, {
    stroke: state.color,
    strokeWidth: state.strokeWidth,
    fill: 'transparent',
    strokeLineCap: 'round',
    selectable: false,
    objectCaching: false,
  });
}

function applyRedact(x: number, y: number, w: number, h: number) {
  const rect = new Rect({
    left: x, top: y, width: w, height: h,
    fill: state.color,
    stroke: 'transparent',
    selectable: true,
  });
  canvas.add(rect);
  canvas.setActiveObject(rect);
  canvas.renderAll();
}

async function applyCrop(x: number, y: number, w: number, h: number) {
  const flat = renderFlatCanvas();
  const dpr = window.devicePixelRatio || 1;
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = Math.round(w * dpr);
  cropCanvas.height = Math.round(h * dpr);
  const ctx = cropCanvas.getContext('2d')!;
  ctx.drawImage(flat, x * dpr, y * dpr, w * dpr, h * dpr, 0, 0, cropCanvas.width, cropCanvas.height);

  await new Promise<void>((resolve) => {
    cropCanvas.toBlob(async (blob) => {
      if (!blob) { resolve(); return; }
      const url = URL.createObjectURL(blob);
      baseImageUrl = url;
      await initCanvas(url);
      state.history = [];
      state.historyIndex = -1;
      pushHistory();
      setTool('select');
      resolve();
    }, 'image/png');
  });
}

function addCallout(x: number, y: number) {
  const text = new Textbox('Label', {
    left: x,
    top: y,
    fontSize: state.fontSize,
    fill: state.color,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontWeight: '700',
    backgroundColor: hexToRgba(state.color, 0.14),
    editable: true,
    selectable: true,
    width: 160,
    padding: 10,
  });
  canvas.add(text);
  canvas.setActiveObject(text);
  text.enterEditing();
  text.selectAll();
  canvas.renderAll();
  setTool('select');
}

async function addText(x: number, y: number) {
  const text = new Textbox('Type here…', {
    left: x,
    top: y,
    fontSize: state.fontSize,
    fill: state.color,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontWeight: '600',
    editable: true,
    selectable: true,
    width: 200,
  });
  canvas.add(text);
  canvas.setActiveObject(text);
  text.enterEditing();
  text.selectAll();
  canvas.renderAll();
  setTool('select');
}

function addStep(x: number, y: number) {
  const r = 22;
  const circle = new Ellipse({
    rx: r, ry: r,
    fill: state.color,
    stroke: 'transparent',
    originX: 'center', originY: 'center',
  });
  const label = new FabricText(String(state.stepCounter), {
    fontSize: 20,
    fill: '#fff',
    fontWeight: '700',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    originX: 'center', originY: 'center',
  });
  const group = new Group([circle, label], {
    left: x - r, top: y - r, selectable: true,
  });
  canvas.add(group);
  canvas.setActiveObject(group);
  canvas.renderAll();
  state.stepCounter++;
}

async function applyBlur(x: number, y: number, w: number, h: number) {
  const bgEl = canvas.backgroundImage as FabricImage | undefined;
  if (!bgEl) return;

  const srcImg = bgEl.getElement() as HTMLImageElement;
  const pixelSize = Math.max(6, Math.min(w, h) / 8);

  const small = document.createElement('canvas');
  small.width = Math.ceil(w / pixelSize);
  small.height = Math.ceil(h / pixelSize);
  const sCtx = small.getContext('2d')!;
  sCtx.imageSmoothingEnabled = false;
  sCtx.drawImage(srcImg, x, y, w, h, 0, 0, small.width, small.height);

  const pixelated = document.createElement('canvas');
  pixelated.width = w;
  pixelated.height = h;
  const pCtx = pixelated.getContext('2d')!;
  pCtx.imageSmoothingEnabled = false;
  pCtx.drawImage(small, 0, 0, w, h);

  const blurImg = await FabricImage.fromURL(pixelated.toDataURL());
  blurImg.set({ left: x, top: y, selectable: true, evented: true });
  canvas.add(blurImg);
  canvas.setActiveObject(blurImg);
  canvas.renderAll();
}

// ─── History (Undo/Redo) ──────────────────────────────────────────────────────

function pushHistory() {
  if (isRestoringHistory) return;
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(JSON.stringify(canvas.toJSON(['selectable', 'evented'])));
  state.historyIndex = state.history.length - 1;
  updateHistoryButtons();
}

async function undo() {
  if (state.historyIndex <= 0) return;
  state.historyIndex--;
  await restoreHistory();
}

async function redo() {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex++;
  await restoreHistory();
}

async function restoreHistory() {
  const json = state.history[state.historyIndex];
  if (!json) return;

  isRestoringHistory = true;
  try {
    await canvas.loadFromJSON(JSON.parse(json));
    const img = await FabricImage.fromURL(baseImageUrl);
    img.set({
      selectable: false, evented: false,
      scaleX: canvas.width! / img.width!,
      scaleY: canvas.height! / img.height!,
    });
    canvas.backgroundImage = img;
    canvas.renderAll();
  } finally {
    isRestoringHistory = false;
  }

  updateHistoryButtons();
}

function updateHistoryButtons() {
  const undoBtn = document.getElementById('btn-undo') as HTMLButtonElement;
  const redoBtn = document.getElementById('btn-redo') as HTMLButtonElement;
  undoBtn.disabled = state.historyIndex <= 0;
  redoBtn.disabled = state.historyIndex >= state.history.length - 1;
}

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────────

function setupKeyboard() {
  document.addEventListener('keydown', async (e) => {
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key === 'z') { e.preventDefault(); await undo(); }
    if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); await redo(); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (document.activeElement?.tagName !== 'INPUT' &&
          !(document.activeElement as HTMLElement)?.isContentEditable) {
        deleteSelected();
      }
    }

    // Tool shortcuts
    const toolMap: Record<string, Tool> = {
      v: 'select', a: 'arrow', l: 'line', r: 'rect', c: 'circle',
      t: 'text', p: 'pen', q: 'callout',
      h: 'highlight', b: 'blur', d: 'redact',
      s: 'step', x: 'crop',
    };
    if (!ctrl && !e.altKey && toolMap[e.key]) setTool(toolMap[e.key]!);
  });

  document.getElementById('btn-undo')?.addEventListener('click', undo);
  document.getElementById('btn-redo')?.addEventListener('click', redo);
}

// ─── Zoom ─────────────────────────────────────────────────────────────────────

function setupZoom() {
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => setZoom(state.zoom + 0.1));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => setZoom(state.zoom - 0.1));
  document.getElementById('btn-zoom-fit')?.addEventListener('click', fitToScreen);

  canvas.on('mouse:wheel', (opt) => {
    opt.e.preventDefault();
    const delta = (opt.e as WheelEvent).deltaY;
    setZoom(state.zoom - delta / 1000);
  });
}

function setZoom(zoom: number) {
  state.zoom = Math.max(0.1, Math.min(5, zoom));
  const container = document.getElementById('canvas-container') as HTMLDivElement;
  container.style.transform = `scale(${state.zoom})`;
  container.style.transformOrigin = 'top left';
  (document.getElementById('zoom-label') as HTMLSpanElement).textContent =
    `${Math.round(state.zoom * 100)}%`;
}

function fitToScreen() {
  const wrap = document.getElementById('canvas-wrap') as HTMLDivElement;
  const padding = 48;
  const maxW = wrap.clientWidth - padding;
  const maxH = wrap.clientHeight - padding;
  const scaleW = maxW / canvas.width!;
  const scaleH = maxH / canvas.height!;
  setZoom(Math.min(scaleW, scaleH, 1));
}

// ─── Delete ───────────────────────────────────────────────────────────────────

function deleteSelected() {
  const active = canvas.getActiveObjects();
  if (active.length) {
    canvas.remove(...active);
    canvas.discardActiveObject();
    canvas.renderAll();
    pushHistory();
  }
}

// ─── Color/Stroke update for selected objects ─────────────────────────────────

function updateActiveObjectColor() {
  const active = canvas.getActiveObject();
  if (!active) return;
  if ('stroke' in active && active.stroke !== 'transparent') {
    active.set({ stroke: state.color });
  }
  if ('fill' in active && active.fill !== 'transparent') {
    active.set({ fill: state.color });
  }
  canvas.renderAll();
}

function updateActiveObjectStroke() {
  const active = canvas.getActiveObject();
  if (!active) return;
  if ('strokeWidth' in active) {
    active.set({ strokeWidth: state.strokeWidth });
    canvas.renderAll();
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

function setupExport() {
  document.getElementById('btn-copy')?.addEventListener('click', copyToClipboard);
  document.getElementById('btn-download-png')?.addEventListener('click', () => downloadAs('png'));
  document.getElementById('btn-download-jpg')?.addEventListener('click', () => downloadAs('jpg'));
  document.getElementById('btn-download-pdf')?.addEventListener('click', downloadAsPdf);
}

function getFilename(): string {
  return (document.getElementById('filename-input') as HTMLInputElement).value || 'snapmonk-capture';
}

function renderFlatCanvas(): HTMLCanvasElement {
  canvas.discardActiveObject();
  canvas.renderAll();
  return canvas.toCanvasElement(window.devicePixelRatio || 1);
}

async function copyToClipboard() {
  const el = renderFlatCanvas();
  el.toBlob(async (blob) => {
    if (!blob) return;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    flashFeedback('Copied!');
  });
}

function downloadAs(format: 'png' | 'jpg') {
  const el = renderFlatCanvas();
  const mimeType = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const quality = format === 'jpg' ? 0.92 : 1;
  const dataUrl = el.toDataURL(mimeType, quality);
  triggerDownload(dataUrl, `${getFilename()}.${format}`);
}

function downloadAsPdf() {
  const el = renderFlatCanvas();
  const dataUrl = el.toDataURL('image/png');
  const win = window.open('', '_blank')!;
  win.document.write(
    `<!DOCTYPE html><html><head><title>${getFilename()}</title>` +
    `<style>*{margin:0;padding:0;}img{width:100vw;height:100vh;object-fit:contain;}</style>` +
    `</head><body><img src="${dataUrl}"></body></html>`
  );
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 250);
}

function triggerDownload(dataUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

function flashFeedback(msg: string) {
  const btn = document.getElementById('btn-copy') as HTMLButtonElement;
  const orig = btn.textContent ?? '';
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = orig; }, 1500);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function hexToRgba(hex: string, alpha: number): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return `rgba(255,0,0,${alpha})`;
  const [, r, g, b] = result;
  return `rgba(${parseInt(r!, 16)},${parseInt(g!, 16)},${parseInt(b!, 16)},${alpha})`;
}

function updateLoadingText(text: string) {
  const el = document.getElementById('loading-text');
  if (el) el.textContent = text;
}

function hideLoading() {
  const overlay = document.getElementById('loading-overlay') as HTMLDivElement;
  overlay.style.display = 'none';
}

function showError(msg: string) {
  const overlay = document.getElementById('loading-overlay') as HTMLDivElement;
  overlay.innerHTML = `<p style="color:#F85149;font-size:14px;">${msg}</p>`;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

init().catch((err) => showError(String(err)));
