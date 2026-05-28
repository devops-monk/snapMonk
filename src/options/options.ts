import { getAllCaptures, clearAllCaptures, deleteCapture } from '../utils/db';
import type { CaptureRecord } from '../utils/types';

// ─── Tabs ─────────────────────────────────────────────────────────────────────

const tabs = ['general', 'shortcuts', 'library', 'about'] as const;

function setActiveTab(tab: string) {
  tabs.forEach((t) => {
    document.getElementById(`tab-${t}`)!.style.display = t === tab ? 'block' : 'none';
    document.querySelector(`[data-tab="${t}"]`)?.classList.toggle('active', t === tab);
  });
  if (tab === 'library') loadLibrary();
}

document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => setActiveTab(btn.dataset['tab']!));
});

// Check if opened with ?tab=library
const startTab = new URLSearchParams(location.search).get('tab') ?? 'general';
setActiveTab(startTab);

// ─── Settings (chrome.storage.sync) ──────────────────────────────────────────

interface Prefs {
  format: string;
  jpgQuality: string;
  scrollDelay: string;
  watermark: boolean;
  openEditor: boolean;
}

const defaults: Prefs = {
  format: 'png',
  jpgQuality: '0.92',
  scrollDelay: '250',
  watermark: false,
  openEditor: true,
};

async function loadPrefs() {
  const saved = (await chrome.storage.sync.get(defaults)) as Prefs;
  (document.getElementById('pref-format') as HTMLSelectElement).value = saved.format;
  (document.getElementById('pref-jpg-quality') as HTMLSelectElement).value = saved.jpgQuality;
  (document.getElementById('pref-scroll-delay') as HTMLSelectElement).value = saved.scrollDelay;
  (document.getElementById('pref-watermark') as HTMLInputElement).checked = saved.watermark;
  (document.getElementById('pref-open-editor') as HTMLInputElement).checked = saved.openEditor;
}

async function savePrefs() {
  const prefs: Prefs = {
    format: (document.getElementById('pref-format') as HTMLSelectElement).value,
    jpgQuality: (document.getElementById('pref-jpg-quality') as HTMLSelectElement).value,
    scrollDelay: (document.getElementById('pref-scroll-delay') as HTMLSelectElement).value,
    watermark: (document.getElementById('pref-watermark') as HTMLInputElement).checked,
    openEditor: (document.getElementById('pref-open-editor') as HTMLInputElement).checked,
  };
  await chrome.storage.sync.set(prefs);
}

['pref-format', 'pref-jpg-quality', 'pref-scroll-delay'].forEach((id) => {
  document.getElementById(id)?.addEventListener('change', savePrefs);
});
['pref-watermark', 'pref-open-editor'].forEach((id) => {
  document.getElementById(id)?.addEventListener('change', savePrefs);
});

loadPrefs();

// ─── Shortcuts link ───────────────────────────────────────────────────────────

document.getElementById('link-shortcuts')?.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ─── Library ──────────────────────────────────────────────────────────────────

async function loadLibrary() {
  const grid = document.getElementById('library-grid')!;
  const empty = document.getElementById('library-empty')!;
  const records = await getAllCaptures();

  // Clear existing cards (keep empty state)
  grid.querySelectorAll('.capture-card').forEach((el) => el.remove());

  if (records.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  // Render newest first
  const sorted = [...records].sort((a, b) => b.metadata.timestamp - a.metadata.timestamp);

  for (const record of sorted) {
    const card = await buildCard(record);
    grid.appendChild(card);
  }
}

async function buildCard(record: CaptureRecord): Promise<HTMLDivElement> {
  const card = document.createElement('div');
  card.className = 'capture-card';
  card.dataset['id'] = record.id;

  // Thumbnail
  const imgEl = document.createElement('img');
  imgEl.alt = record.metadata.title;
  const blobUrl = URL.createObjectURL(record.slices[0]!);
  imgEl.src = blobUrl;
  imgEl.onload = () => URL.revokeObjectURL(blobUrl);
  card.appendChild(imgEl);

  // Info
  const info = document.createElement('div');
  info.className = 'card-info';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = record.metadata.title || 'Untitled';
  info.appendChild(title);

  const meta = document.createElement('div');
  const date = new Date(record.metadata.timestamp);
  meta.textContent = `${record.type} · ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  info.appendChild(meta);

  // Actions
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:6px;margin-top:6px;';

  const openBtn = document.createElement('button');
  openBtn.textContent = 'Open';
  openBtn.style.cssText = 'flex:1;padding:4px;background:#21262D;border:1px solid #30363D;border-radius:5px;color:#E6EDF3;font-size:11px;cursor:pointer;';
  openBtn.addEventListener('click', () => {
    const url = chrome.runtime.getURL(`src/editor/editor.html?id=${record.id}`);
    chrome.tabs.create({ url });
  });

  const delBtn = document.createElement('button');
  delBtn.textContent = 'Delete';
  delBtn.style.cssText = 'padding:4px 8px;background:transparent;border:1px solid #30363D;border-radius:5px;color:#F85149;font-size:11px;cursor:pointer;';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await deleteCapture(record.id);
    card.remove();
    const remaining = document.querySelectorAll('.capture-card').length;
    if (remaining === 0) {
      document.getElementById('library-empty')!.style.display = 'block';
    }
  });

  actions.appendChild(openBtn);
  actions.appendChild(delBtn);
  info.appendChild(actions);
  card.appendChild(info);

  return card;
}

document.getElementById('btn-clear-all')?.addEventListener('click', async () => {
  if (!confirm('Delete all captures? This cannot be undone.')) return;
  await clearAllCaptures();
  loadLibrary();
});
