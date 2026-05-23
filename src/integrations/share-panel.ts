import { uploadScreenshot, commentOnIssue } from './github';
import { attachToJira, commentOnJira } from './jira';
import { uploadToSlack, resolveChannelId } from './slack';

// ─── Settings keys ────────────────────────────────────────────────────────────

const KEYS = {
  github_token: 'int_github_token',
  github_repo: 'int_github_repo',
  jira_url: 'int_jira_url',
  jira_email: 'int_jira_email',
  jira_token: 'int_jira_token',
  slack_token: 'int_slack_token',
  slack_channel: 'int_slack_channel',
} as const;

type Settings = Record<(typeof KEYS)[keyof typeof KEYS], string>;

async function loadSettings(): Promise<Settings> {
  const defaults = Object.fromEntries(Object.values(KEYS).map((k) => [k, '']));
  const stored = await chrome.storage.sync.get(defaults);
  return stored as Settings;
}

// ─── Canvas export helper ─────────────────────────────────────────────────────

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Canvas toBlob failed'));
    }, 'image/png');
  });
}

// ─── Panel injection ──────────────────────────────────────────────────────────

export function initSharePanel(getCanvas: () => HTMLCanvasElement) {
  const btn = document.getElementById('btn-share') as HTMLButtonElement;
  btn.addEventListener('click', () => openPanel(getCanvas));
}

function openPanel(getCanvas: () => HTMLCanvasElement) {
  document.getElementById('sm-share-backdrop')?.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'sm-share-backdrop';
  backdrop.className = 'sm-share-backdrop';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closePanel();
  });

  const panel = buildPanel(getCanvas);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  // Animate in
  requestAnimationFrame(() => backdrop.classList.add('open'));
}

function closePanel() {
  const bd = document.getElementById('sm-share-backdrop');
  if (!bd) return;
  bd.classList.remove('open');
  bd.addEventListener('transitionend', () => bd.remove(), { once: true });
}

// ─── Panel DOM ────────────────────────────────────────────────────────────────

function buildPanel(getCanvas: () => HTMLCanvasElement): HTMLElement {
  const panel = el('div', 'sm-share-panel');

  // Header
  const header = el('div', 'sm-share-header');
  header.innerHTML = `
    <span class="sm-share-title">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z"/></svg>
      Share Screenshot
    </span>
    <button class="sm-share-close" title="Close">×</button>
  `;
  header.querySelector('.sm-share-close')!.addEventListener('click', closePanel);
  panel.appendChild(header);

  // Body (async-loaded)
  const body = el('div', 'sm-share-body');
  panel.appendChild(body);
  loadSettings().then((s) => renderIntegrations(body, s, getCanvas));

  return panel;
}

function renderIntegrations(
  body: HTMLElement,
  settings: Settings,
  getCanvas: () => HTMLCanvasElement,
) {
  body.innerHTML = '';

  // ── GitHub ──
  body.appendChild(
    buildCard({
      icon: '🐙',
      title: 'GitHub',
      color: '#E6EDF3',
      configured: !!settings.int_github_token,
      settingsHint: 'Add your GitHub token in Settings → Integrations',
      fields: [
        { id: 'gh-repo', label: 'Repo (owner/repo)', value: settings.int_github_repo, placeholder: 'myorg/myrepo' },
        { id: 'gh-issue', label: 'Issue #', value: '', placeholder: '123', type: 'number' },
        { id: 'gh-note', label: 'Note (optional)', value: '', placeholder: 'Describe the issue…', multiline: true },
      ],
      btnLabel: '→ Attach to Issue',
      onSubmit: async (vals) => {
        const [owner, repo] = (vals['gh-repo'] ?? '').split('/');
        if (!owner || !repo) throw new Error('Invalid repo format. Use "owner/repo".');
        const issueNum = parseInt(vals['gh-issue'] ?? '', 10);
        if (!issueNum) throw new Error('Enter a valid issue number.');

        const blob = await canvasToBlob(getCanvas());
        const imageUrl = await uploadScreenshot(settings.int_github_token, owner, repo, blob);
        const commentUrl = await commentOnIssue(
          settings.int_github_token,
          owner,
          repo,
          issueNum,
          imageUrl,
          vals['gh-note'] ?? '',
        );
        return { url: commentUrl, label: 'View on GitHub' };
      },
    }),
  );

  // ── Jira ──
  body.appendChild(
    buildCard({
      icon: '🔵',
      title: 'Jira',
      color: '#579DFF',
      configured: !!(settings.int_jira_url && settings.int_jira_token),
      settingsHint: 'Add your Jira URL and API token in Settings → Integrations',
      fields: [
        { id: 'jira-ticket', label: 'Ticket (e.g. PROJ-123)', value: '', placeholder: 'PROJ-123' },
        { id: 'jira-note', label: 'Note (optional)', value: '', placeholder: 'Describe the issue…', multiline: true },
      ],
      btnLabel: '→ Attach to Jira Ticket',
      onSubmit: async (vals) => {
        const ticket = (vals['jira-ticket'] ?? '').trim().toUpperCase();
        if (!ticket) throw new Error('Enter a Jira ticket key.');
        const filename = `snapmonk-${Date.now()}.png`;
        const blob = await canvasToBlob(getCanvas());

        await attachToJira(
          settings.int_jira_url,
          settings.int_jira_email,
          settings.int_jira_token,
          ticket,
          blob,
        );
        await commentOnJira(
          settings.int_jira_url,
          settings.int_jira_email,
          settings.int_jira_token,
          ticket,
          vals['jira-note'] ?? '',
          filename,
        );
        return {
          url: `${settings.int_jira_url.replace(/\/$/, '')}/browse/${ticket}`,
          label: 'View Jira Ticket',
        };
      },
    }),
  );

  // ── Slack ──
  body.appendChild(
    buildCard({
      icon: '💬',
      title: 'Slack',
      color: '#36C5F0',
      configured: !!settings.int_slack_token,
      settingsHint: 'Add your Slack Bot token in Settings → Integrations',
      fields: [
        { id: 'slack-channel', label: 'Channel (e.g. #bugs)', value: settings.int_slack_channel, placeholder: '#bugs or C01234ABCDE' },
        { id: 'slack-msg', label: 'Message (optional)', value: '', placeholder: 'Add context…', multiline: true },
      ],
      btnLabel: '→ Send to Slack',
      onSubmit: async (vals) => {
        const channelInput = (vals['slack-channel'] ?? '').trim();
        if (!channelInput) throw new Error('Enter a Slack channel.');
        const channelId = await resolveChannelId(settings.int_slack_token, channelInput);
        const blob = await canvasToBlob(getCanvas());
        const permalink = await uploadToSlack(
          settings.int_slack_token,
          channelId,
          blob,
          vals['slack-msg'] ?? '',
        );
        return { url: permalink, label: 'View in Slack' };
      },
    }),
  );

  // Settings link
  const hint = el('div', 'sm-share-settings-link');
  hint.innerHTML = `<a href="#" id="sm-open-settings">⚙️ Manage API keys in Settings</a>`;
  hint.querySelector('#sm-open-settings')!.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  body.appendChild(hint);
}

// ─── Card builder ─────────────────────────────────────────────────────────────

interface CardField {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  type?: string;
  multiline?: boolean;
}

interface CardConfig {
  icon: string;
  title: string;
  color: string;
  configured: boolean;
  settingsHint: string;
  fields: CardField[];
  btnLabel: string;
  onSubmit: (vals: Record<string, string>) => Promise<{ url: string; label: string }>;
}

function buildCard(cfg: CardConfig): HTMLElement {
  const card = el('div', 'sm-int-card');

  // Header
  const cardHeader = el('div', 'sm-int-card-header');
  cardHeader.innerHTML = `<span class="sm-int-icon">${cfg.icon}</span><span class="sm-int-title">${cfg.title}</span>`;
  if (!cfg.configured) {
    const badge = el('span', 'sm-int-badge');
    badge.textContent = 'Not configured';
    cardHeader.appendChild(badge);
  }
  card.appendChild(cardHeader);

  if (!cfg.configured) {
    const hint = el('p', 'sm-int-hint');
    hint.textContent = cfg.settingsHint;
    card.appendChild(hint);
    return card;
  }

  // Fields
  const form = el('div', 'sm-int-form');
  cfg.fields.forEach(({ id, label, value, placeholder, type = 'text', multiline }) => {
    const group = el('div', 'sm-int-field');
    const lbl = document.createElement('label');
    lbl.textContent = label;
    lbl.htmlFor = `sm-${id}`;

    let input: HTMLInputElement | HTMLTextAreaElement;
    if (multiline) {
      input = document.createElement('textarea');
      input.rows = 2;
    } else {
      input = document.createElement('input');
      (input as HTMLInputElement).type = type;
    }
    input.id = `sm-${id}`;
    input.placeholder = placeholder;
    input.value = value;
    input.className = 'sm-int-input';

    group.appendChild(lbl);
    group.appendChild(input);
    form.appendChild(group);
  });

  // Submit button
  const btn = document.createElement('button');
  btn.className = 'sm-int-btn';
  btn.textContent = cfg.btnLabel;

  // Status feedback
  const status = el('div', 'sm-int-status');
  form.appendChild(btn);
  form.appendChild(status);
  card.appendChild(form);

  btn.addEventListener('click', async () => {
    const vals: Record<string, string> = {};
    cfg.fields.forEach(({ id }) => {
      vals[id] = (document.getElementById(`sm-${id}`) as HTMLInputElement | HTMLTextAreaElement).value;
    });

    btn.disabled = true;
    btn.textContent = 'Sending…';
    status.textContent = '';
    status.className = 'sm-int-status';

    try {
      const { url, label } = await cfg.onSubmit(vals);
      status.className = 'sm-int-status success';
      status.innerHTML = `✓ Done! <a href="${url}" target="_blank">${label} →</a>`;
      btn.textContent = '✓ Sent';
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = cfg.btnLabel;
      }, 3000);
    } catch (err) {
      status.className = 'sm-int-status error';
      status.textContent = `✗ ${(err as Error).message}`;
      btn.disabled = false;
      btn.textContent = cfg.btnLabel;
    }
  });

  return card;
}

// ─── Tiny DOM helper ──────────────────────────────────────────────────────────

function el(tag: string, className: string): HTMLDivElement {
  const e = document.createElement(tag) as HTMLDivElement;
  e.className = className;
  return e;
}
