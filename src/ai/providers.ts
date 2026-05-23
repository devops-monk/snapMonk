// AI provider implementations for screenshot bug report generation

export type AiProvider = 'gemini' | 'groq' | 'openai' | 'ollama';

export interface AiSettings {
  provider: AiProvider;
  geminiKey: string;
  groqKey: string;
  openaiKey: string;
  ollamaUrl: string;
  ollamaModel: string;
}

export const AI_STORAGE_KEYS = {
  provider: 'ai_provider',
  geminiKey: 'ai_gemini_key',
  groqKey: 'ai_groq_key',
  openaiKey: 'ai_openai_key',
  ollamaUrl: 'ai_ollama_url',
  ollamaModel: 'ai_ollama_model',
} as const;

export const AI_DEFAULTS: AiSettings = {
  provider: 'gemini',
  geminiKey: '',
  groqKey: '',
  openaiKey: '',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llava',
};

export async function loadAiSettings(): Promise<AiSettings> {
  const defaults = {
    [AI_STORAGE_KEYS.provider]: AI_DEFAULTS.provider,
    [AI_STORAGE_KEYS.geminiKey]: '',
    [AI_STORAGE_KEYS.groqKey]: '',
    [AI_STORAGE_KEYS.openaiKey]: '',
    [AI_STORAGE_KEYS.ollamaUrl]: AI_DEFAULTS.ollamaUrl,
    [AI_STORAGE_KEYS.ollamaModel]: AI_DEFAULTS.ollamaModel,
  };
  const saved = await chrome.storage.sync.get(defaults);
  return {
    provider: (saved[AI_STORAGE_KEYS.provider] as AiProvider) || 'gemini',
    geminiKey: saved[AI_STORAGE_KEYS.geminiKey] as string,
    groqKey: saved[AI_STORAGE_KEYS.groqKey] as string,
    openaiKey: saved[AI_STORAGE_KEYS.openaiKey] as string,
    ollamaUrl: (saved[AI_STORAGE_KEYS.ollamaUrl] as string) || AI_DEFAULTS.ollamaUrl,
    ollamaModel: (saved[AI_STORAGE_KEYS.ollamaModel] as string) || AI_DEFAULTS.ollamaModel,
  };
}

const BUG_REPORT_PROMPT = `You are a senior QA engineer. Analyze this screenshot and generate a professional bug report in Markdown.

Use exactly this structure:

## Bug Title
One-sentence summary of the issue visible in the screenshot.

## Description
2-3 sentences explaining what the bug is.

## Steps to Reproduce
1. Step one
2. Step two
3. Step three

## Expected Behavior
What should happen.

## Actual Behavior
What is actually happening (based on the screenshot).

## Severity
**[Critical / High / Medium / Low]** — one sentence justification.

## Additional Notes
Any other observations from the screenshot (UI glitches, error messages, console errors visible, etc.). If nothing notable, write "None."

Be concise, specific, and actionable. Do not fabricate details not visible in the screenshot.`;

/** Convert canvas blob to base64 string (without the data URL prefix). */
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ─── Gemini Flash ─────────────────────────────────────────────────────────────

async function callGemini(apiKey: string, imageBlob: Blob): Promise<string> {
  const base64 = await blobToBase64(imageBlob);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: BUG_REPORT_PROMPT },
          { inline_data: { mime_type: 'image/png', data: base64 } },
        ],
      }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
    }),
  });

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string };
  };

  if (data.error?.message) throw new Error(`Gemini: ${data.error.message}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty response.');
  return text;
}

// ─── Groq Vision ─────────────────────────────────────────────────────────────

async function callGroq(apiKey: string, imageBlob: Blob): Promise<string> {
  const base64 = await blobToBase64(imageBlob);
  const dataUrl = `data:image/png;base64,${base64}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: BUG_REPORT_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      temperature: 0.2,
      max_tokens: 1024,
    }),
  });

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error?.message) throw new Error(`Groq: ${data.error.message}`);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq returned an empty response.');
  return text;
}

// ─── OpenAI GPT-4o-mini ───────────────────────────────────────────────────────

async function callOpenAI(apiKey: string, imageBlob: Blob): Promise<string> {
  const base64 = await blobToBase64(imageBlob);
  const dataUrl = `data:image/png;base64,${base64}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: BUG_REPORT_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
        ],
      }],
      temperature: 0.2,
      max_tokens: 1024,
    }),
  });

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error?.message) throw new Error(`OpenAI: ${data.error.message}`);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned an empty response.');
  return text;
}

// ─── Ollama (local) ───────────────────────────────────────────────────────────

async function callOllama(baseUrl: string, model: string, imageBlob: Blob): Promise<string> {
  const base64 = await blobToBase64(imageBlob);
  const clean = baseUrl.replace(/\/$/, '');

  const res = await fetch(`${clean}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: BUG_REPORT_PROMPT,
      images: [base64],
      stream: false,
      options: { temperature: 0.2, num_predict: 1024 },
    }),
  });

  if (!res.ok) throw new Error(`Ollama: HTTP ${res.status} — is Ollama running at ${clean}?`);

  const data = (await res.json()) as { response?: string; error?: string };
  if (data.error) throw new Error(`Ollama: ${data.error}`);
  if (!data.response) throw new Error('Ollama returned an empty response.');
  return data.response;
}

// ─── Unified entry point ──────────────────────────────────────────────────────

export async function generateBugReport(settings: AiSettings, imageBlob: Blob): Promise<string> {
  switch (settings.provider) {
    case 'gemini': {
      if (!settings.geminiKey) throw new Error('No Gemini API key configured. Go to Settings → AI.');
      return callGemini(settings.geminiKey, imageBlob);
    }
    case 'groq': {
      if (!settings.groqKey) throw new Error('No Groq API key configured. Go to Settings → AI.');
      return callGroq(settings.groqKey, imageBlob);
    }
    case 'openai': {
      if (!settings.openaiKey) throw new Error('No OpenAI API key configured. Go to Settings → AI.');
      return callOpenAI(settings.openaiKey, imageBlob);
    }
    case 'ollama': {
      return callOllama(settings.ollamaUrl, settings.ollamaModel, imageBlob);
    }
    default: {
      throw new Error(`Unknown AI provider: ${settings.provider as string}`);
    }
  }
}

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  gemini: 'Gemini Flash 2.0',
  groq: 'Groq LLaMA 4',
  openai: 'GPT-4o-mini',
  ollama: 'Ollama (local)',
};

export const PROVIDER_BADGE_COLOR: Record<AiProvider, string> = {
  gemini: '#4285F4',
  groq: '#F55036',
  openai: '#10A37F',
  ollama: '#7C3AED',
};
