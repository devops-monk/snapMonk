# SnapMonk — Chrome Screenshot & Annotation Tool
**by DevOps-Monk** · *Capture. Annotate. Ship.*

[![Build](https://github.com/devops-monk/snapMonk/actions/workflows/build.yml/badge.svg)](https://github.com/devops-monk/snapMonk/actions/workflows/build.yml)

A best-in-class Chrome extension for capturing, annotating, and sharing screenshots — built with Vite 6, TypeScript 5, Fabric.js v6, and Tailwind CSS v4.

---

## Features

| Category | What's included |
|---|---|
| **Capture** | Visible area, full-page scroll+stitch, region drag-select, element picker |
| **Editor** | Arrow, rect, circle, text, freehand pen, highlight, blur/redact, step numbers, crop, undo/redo, zoom |
| **Export** | PNG, JPG, PDF, copy to clipboard, DevOps-Monk watermark |
| **Recording** | Tab/desktop screen recording, webcam overlay, mic audio, pause/resume, WebM download |
| **Share** | GitHub Issues, Jira tickets, Slack channels — attach screenshots directly from the editor |
| **AI Bug Report** | One-click structured bug report via Gemini Flash 2.0, Groq LLaMA 4, GPT-4o-mini, or Ollama (local) |
| **Library** | IndexedDB capture history, thumbnail grid, re-open in editor |

---

## Quick Start

```bash
npm install
npm run dev        # watch mode — rebuilds on save
npm run build      # production build → dist/
npm run zip        # build + zip for Chrome Web Store upload
```

## Load in Chrome

1. `npm run build`
2. Open `chrome://extensions`
3. Enable **Developer Mode** (top right)
4. **Load Unpacked** → select the `dist/` folder
5. Pin the extension in the Chrome toolbar

> After any code change: `npm run build`, then click the refresh (↺) icon on the SnapMonk card in `chrome://extensions`.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Build | Vite 6 + TypeScript 5 (strict) |
| Styles | Tailwind CSS v4 (`@tailwindcss/vite`) |
| Canvas Editor | Fabric.js v6 |
| Storage | IndexedDB via `idb` v8 |
| Extension | Chrome Manifest V3 — service worker, `chrome.scripting`, `tabCapture` |

---

## Project Structure

```
src/
├── background/      # MV3 service worker — capture orchestration, context menu
├── popup/           # Extension popup UI
├── editor/          # Full-screen Fabric.js annotation editor
├── content/         # Region/element selection overlay (injected into pages)
├── recorder/        # Screen recording toolbar (injected content script)
├── integrations/    # GitHub / Jira / Slack API clients + share panel UI
├── ai/              # Multi-provider AI bug report (Gemini, Groq, OpenAI, Ollama)
├── options/         # Settings page (General, Shortcuts, Integrations, AI, Library)
└── utils/           # Types, IndexedDB wrapper
```

---

## Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| Capture Visible Area | `Alt+Shift+S` |
| Capture Full Page | `Alt+Shift+F` |
| Select Region | `Alt+Shift+R` |
| Editor: Undo | `Ctrl+Z` |
| Editor: Redo | `Ctrl+Y` |
| Editor: Delete Selected | `Delete` |

Editor tool shortcuts: `V` Select · `A` Arrow · `R` Rect · `C` Circle · `T` Text · `P` Pen · `H` Highlight · `B` Blur · `S` Step# · `X` Crop

---

## Integrations Setup

Go to **Settings → Integrations** in the extension options page:

| Integration | What you need |
|---|---|
| **GitHub** | Personal Access Token with `repo` scope |
| **Jira** | Instance URL + Atlassian account email + API token |
| **Slack** | Bot token (`xoxb-…`) with `files:write` + `channels:read` scopes |

---

## AI Bug Report Setup

Go to **Settings → AI** and pick a provider:

| Provider | Cost | Notes |
|---|---|---|
| **Gemini Flash 2.0** | Free — 1,500 req/day | Get key at [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| **Groq LLaMA 4** | Free — 14,400 req/day | Get key at [console.groq.com](https://console.groq.com/keys) |
| **GPT-4o-mini** | ~$0.003/screenshot | Get key at [platform.openai.com](https://platform.openai.com/api-keys) |
| **Ollama** | Free — runs locally | Install [ollama.ai](https://ollama.ai) and pull `llava` |

---

## CI / CD

GitHub Actions builds the extension on every push to `main` and on all PRs. The `dist/` artifact and a `.zip` ready for Chrome Web Store upload are attached to each workflow run.

See [`.github/workflows/build.yml`](.github/workflows/build.yml).

---

*Built with ❤️ by [DevOps-Monk](https://devops-monk.com)*
