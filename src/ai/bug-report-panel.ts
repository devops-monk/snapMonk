import {
  generateBugReport,
  loadAiSettings,
  PROVIDER_LABELS,
  PROVIDER_BADGE_COLOR,
  type AiSettings,
} from './providers';

// ─── Public init ─────────────────────────────────────────────────────────────

export function initBugReportPanel(getCanvas: () => HTMLCanvasElement) {
  const btn = document.getElementById('btn-ai-report') as HTMLButtonElement;
  btn.addEventListener('click', () => openPanel(getCanvas));
}

// ─── Panel lifecycle ──────────────────────────────────────────────────────────

function openPanel(getCanvas: () => HTMLCanvasElement) {
  document.getElementById('sm-ai-backdrop')?.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'sm-ai-backdrop';
  backdrop.className = 'sm-ai-backdrop';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closePanel();
  });

  buildPanel(getCanvas).then((panel) => {
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('open'));
  });
}

function closePanel() {
  const bd = document.getElementById('sm-ai-backdrop');
  if (!bd) return;
  bd.classList.remove('open');
  bd.addEventListener('transitionend', () => bd.remove(), { once: true });
}

// ─── Panel DOM ────────────────────────────────────────────────────────────────

async function buildPanel(getCanvas: () => HTMLCanvasElement): Promise<HTMLElement> {
  const settings = await loadAiSettings();

  const panel = el('div', 'sm-ai-panel');

  // Header
  const header = el('div', 'sm-ai-header');
  const providerColor = PROVIDER_BADGE_COLOR[settings.provider];
  header.innerHTML = `
    <span class="sm-ai-title">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z"/></svg>
      AI Bug Report
      <span class="sm-ai-provider-badge" style="background:${providerColor}20;color:${providerColor};border:1px solid ${providerColor}40;">${PROVIDER_LABELS[settings.provider]}</span>
    </span>
    <button class="sm-ai-close" title="Close">×</button>
  `;
  header.querySelector('.sm-ai-close')!.addEventListener('click', closePanel);
  panel.appendChild(header);

  // Body
  const body = el('div', 'sm-ai-body');
  panel.appendChild(body);

  renderBody(body, settings, getCanvas);
  return panel;
}

function renderBody(
  body: HTMLElement,
  settings: AiSettings,
  getCanvas: () => HTMLCanvasElement,
) {
  body.innerHTML = '';

  // Generate button area
  const generateArea = el('div', 'sm-ai-generate-area');

  const hint = el('p', 'sm-ai-hint');
  hint.textContent = `SnapMonk will analyze your annotated screenshot and generate a structured bug report using ${PROVIDER_LABELS[settings.provider]}.`;
  generateArea.appendChild(hint);

  const generateBtn = document.createElement('button');
  generateBtn.className = 'sm-ai-generate-btn';
  generateBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z"/></svg>
    Generate Bug Report
  `;
  generateArea.appendChild(generateBtn);
  body.appendChild(generateArea);

  // Settings shortcut
  const settingsLink = el('div', 'sm-ai-settings-link');
  settingsLink.innerHTML = `<a href="#" id="sm-ai-open-settings">⚙️ Change AI provider in Settings</a>`;
  settingsLink.querySelector('#sm-ai-open-settings')!.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  body.appendChild(settingsLink);

  // Output area (hidden initially)
  const outputArea = el('div', 'sm-ai-output-area');
  outputArea.style.display = 'none';
  body.appendChild(outputArea);

  generateBtn.addEventListener('click', async () => {
    generateBtn.disabled = true;
    generateBtn.textContent = 'Analyzing…';
    outputArea.style.display = 'none';

    try {
      const canvas = getCanvas();
      const blob = await canvasToBlob(canvas);
      const markdown = await generateBugReport(settings, blob);

      outputArea.style.display = 'block';
      renderOutput(outputArea, markdown);
      generateBtn.disabled = false;
      generateBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z"/></svg>
        Regenerate
      `;
    } catch (err) {
      outputArea.style.display = 'block';
      outputArea.innerHTML = `<div class="sm-ai-error">✗ ${(err as Error).message}</div>`;
      generateBtn.disabled = false;
      generateBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z"/></svg>
        Try Again
      `;
    }
  });
}

function renderOutput(container: HTMLElement, markdown: string) {
  container.innerHTML = '';

  // Toolbar
  const toolbar = el('div', 'sm-ai-output-toolbar');

  const label = el('span', 'sm-ai-output-label');
  label.textContent = 'Bug Report';
  toolbar.appendChild(label);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'sm-ai-copy-btn';
  copyBtn.textContent = 'Copy Markdown';
  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(markdown);
    copyBtn.textContent = '✓ Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy Markdown'; }, 2000);
  });
  toolbar.appendChild(copyBtn);
  container.appendChild(toolbar);

  // Rendered markdown (simple conversion)
  const content = el('div', 'sm-ai-output-content');
  content.innerHTML = markdownToHtml(markdown);
  container.appendChild(content);
}

// ─── Tiny markdown renderer (headings, bold, lists) ──────────────────────────

function markdownToHtml(md: string): string {
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^(\d+)\. (.+)$/gm, '<li><span class="sm-ai-step">$1</span>$2</li>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]+?<\/li>)(?=\n*(?:<li>|$))/g, (m) => `<ul>${m}</ul>`)
    .replace(/<\/ul>\n*<ul>/g, '')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^(?!<[hup])(.+)$/gm, '<p>$1</p>')
    .replace(/<p><\/p>/g, '');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Canvas toBlob failed'));
    }, 'image/png');
  });
}

function el(tag: string, className: string): HTMLDivElement {
  const e = document.createElement(tag) as HTMLDivElement;
  e.className = className;
  return e;
}
