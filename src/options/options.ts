import { getAllCaptures, clearAllCaptures, deleteCapture } from '../utils/db';
import type { CaptureRecord } from '../utils/types';
import { validateToken } from '../integrations/github';
import { validateJira } from '../integrations/jira';
import { validateSlack } from '../integrations/slack';
import { AI_STORAGE_KEYS, AI_DEFAULTS, type AiProvider } from '../ai/providers';

// ─── Tabs ─────────────────────────────────────────────────────────────────────

const tabs = ['general', 'shortcuts', 'integrations', 'ai', 'library', 'about'] as const;

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
  watermark: true,
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

// ─── Integrations ─────────────────────────────────────────────────────────────

const INT_KEYS = {
  github_token: 'int_github_token',
  github_repo: 'int_github_repo',
  jira_url: 'int_jira_url',
  jira_email: 'int_jira_email',
  jira_token: 'int_jira_token',
  slack_token: 'int_slack_token',
  slack_channel: 'int_slack_channel',
} as const;

async function loadIntegrations() {
  const defaults = Object.fromEntries(Object.values(INT_KEYS).map((k) => [k, '']));
  const saved = await chrome.storage.sync.get(defaults);
  (document.getElementById('int-github-token') as HTMLInputElement).value = saved[INT_KEYS.github_token] ?? '';
  (document.getElementById('int-github-repo') as HTMLInputElement).value = saved[INT_KEYS.github_repo] ?? '';
  (document.getElementById('int-jira-url') as HTMLInputElement).value = saved[INT_KEYS.jira_url] ?? '';
  (document.getElementById('int-jira-email') as HTMLInputElement).value = saved[INT_KEYS.jira_email] ?? '';
  (document.getElementById('int-jira-token') as HTMLInputElement).value = saved[INT_KEYS.jira_token] ?? '';
  (document.getElementById('int-slack-token') as HTMLInputElement).value = saved[INT_KEYS.slack_token] ?? '';
  (document.getElementById('int-slack-channel') as HTMLInputElement).value = saved[INT_KEYS.slack_channel] ?? '';
}

async function saveIntegrations() {
  await chrome.storage.sync.set({
    [INT_KEYS.github_token]: (document.getElementById('int-github-token') as HTMLInputElement).value.trim(),
    [INT_KEYS.github_repo]: (document.getElementById('int-github-repo') as HTMLInputElement).value.trim(),
    [INT_KEYS.jira_url]: (document.getElementById('int-jira-url') as HTMLInputElement).value.trim(),
    [INT_KEYS.jira_email]: (document.getElementById('int-jira-email') as HTMLInputElement).value.trim(),
    [INT_KEYS.jira_token]: (document.getElementById('int-jira-token') as HTMLInputElement).value.trim(),
    [INT_KEYS.slack_token]: (document.getElementById('int-slack-token') as HTMLInputElement).value.trim(),
    [INT_KEYS.slack_channel]: (document.getElementById('int-slack-channel') as HTMLInputElement).value.trim(),
  });
}

function setIntStatus(id: string, msg: string, ok: boolean) {
  const el = document.getElementById(id)!;
  el.textContent = msg;
  el.style.color = ok ? '#10B981' : '#F85149';
}

document.getElementById('int-github-validate')?.addEventListener('click', async () => {
  const token = (document.getElementById('int-github-token') as HTMLInputElement).value.trim();
  if (!token) { setIntStatus('int-github-status', 'Enter a token first', false); return; }
  try {
    const login = await validateToken(token);
    setIntStatus('int-github-status', `✓ Authenticated as @${login}`, true);
  } catch (e) {
    setIntStatus('int-github-status', `✗ ${(e as Error).message}`, false);
  }
});

document.getElementById('int-jira-validate')?.addEventListener('click', async () => {
  const url = (document.getElementById('int-jira-url') as HTMLInputElement).value.trim();
  const email = (document.getElementById('int-jira-email') as HTMLInputElement).value.trim();
  const token = (document.getElementById('int-jira-token') as HTMLInputElement).value.trim();
  if (!url || !email || !token) { setIntStatus('int-jira-status', 'Fill in all Jira fields first', false); return; }
  try {
    const name = await validateJira(url, email, token);
    setIntStatus('int-jira-status', `✓ Connected as ${name}`, true);
  } catch (e) {
    setIntStatus('int-jira-status', `✗ ${(e as Error).message}`, false);
  }
});

document.getElementById('int-slack-validate')?.addEventListener('click', async () => {
  const token = (document.getElementById('int-slack-token') as HTMLInputElement).value.trim();
  if (!token) { setIntStatus('int-slack-status', 'Enter a token first', false); return; }
  try {
    const user = await validateSlack(token);
    setIntStatus('int-slack-status', `✓ Authenticated as @${user}`, true);
  } catch (e) {
    setIntStatus('int-slack-status', `✗ ${(e as Error).message}`, false);
  }
});

document.getElementById('int-save-all')?.addEventListener('click', async () => {
  await saveIntegrations();
  const fb = document.getElementById('int-save-feedback')!;
  fb.textContent = '✓ Settings saved';
  setTimeout(() => { fb.textContent = ''; }, 2500);
});

loadIntegrations();

// ─── AI Settings ──────────────────────────────────────────────────────────────

const AI_PROVIDER_SECTIONS: AiProvider[] = ['gemini', 'groq', 'openai', 'ollama'];

function showAiSection(provider: AiProvider) {
  AI_PROVIDER_SECTIONS.forEach((p) => {
    const section = document.getElementById(`ai-section-${p}`);
    if (section) section.style.display = p === provider ? 'block' : 'none';
  });
}

async function loadAiSettingsUi() {
  const defaults = {
    [AI_STORAGE_KEYS.provider]: AI_DEFAULTS.provider,
    [AI_STORAGE_KEYS.geminiKey]: '',
    [AI_STORAGE_KEYS.groqKey]: '',
    [AI_STORAGE_KEYS.openaiKey]: '',
    [AI_STORAGE_KEYS.ollamaUrl]: AI_DEFAULTS.ollamaUrl,
    [AI_STORAGE_KEYS.ollamaModel]: AI_DEFAULTS.ollamaModel,
  };
  const saved = await chrome.storage.sync.get(defaults);
  const provider = (saved[AI_STORAGE_KEYS.provider] as AiProvider) || 'gemini';

  (document.getElementById('ai-provider') as HTMLSelectElement).value = provider;
  (document.getElementById('ai-gemini-key') as HTMLInputElement).value = saved[AI_STORAGE_KEYS.geminiKey] as string;
  (document.getElementById('ai-groq-key') as HTMLInputElement).value = saved[AI_STORAGE_KEYS.groqKey] as string;
  (document.getElementById('ai-openai-key') as HTMLInputElement).value = saved[AI_STORAGE_KEYS.openaiKey] as string;
  (document.getElementById('ai-ollama-url') as HTMLInputElement).value = (saved[AI_STORAGE_KEYS.ollamaUrl] as string) || AI_DEFAULTS.ollamaUrl;
  (document.getElementById('ai-ollama-model') as HTMLInputElement).value = (saved[AI_STORAGE_KEYS.ollamaModel] as string) || AI_DEFAULTS.ollamaModel;

  showAiSection(provider);
}

document.getElementById('ai-provider')?.addEventListener('change', (e) => {
  showAiSection((e.target as HTMLSelectElement).value as AiProvider);
});

document.getElementById('ai-save')?.addEventListener('click', async () => {
  await chrome.storage.sync.set({
    [AI_STORAGE_KEYS.provider]: (document.getElementById('ai-provider') as HTMLSelectElement).value,
    [AI_STORAGE_KEYS.geminiKey]: (document.getElementById('ai-gemini-key') as HTMLInputElement).value.trim(),
    [AI_STORAGE_KEYS.groqKey]: (document.getElementById('ai-groq-key') as HTMLInputElement).value.trim(),
    [AI_STORAGE_KEYS.openaiKey]: (document.getElementById('ai-openai-key') as HTMLInputElement).value.trim(),
    [AI_STORAGE_KEYS.ollamaUrl]: (document.getElementById('ai-ollama-url') as HTMLInputElement).value.trim() || AI_DEFAULTS.ollamaUrl,
    [AI_STORAGE_KEYS.ollamaModel]: (document.getElementById('ai-ollama-model') as HTMLInputElement).value.trim() || AI_DEFAULTS.ollamaModel,
  });
  const fb = document.getElementById('ai-save-feedback')!;
  fb.textContent = '✓ AI settings saved';
  setTimeout(() => { fb.textContent = ''; }, 2500);
});

loadAiSettingsUi();

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
