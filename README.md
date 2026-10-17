# File Box

**File Box is an intelligent cloud drive that works with your files, with you and for you.**

Store, share and protect your files like a traditional cloud drive, while File Box helps you understand, organize and work with them. Its AI, File Box AI, runs locally through [Ollama](https://ollama.com): no file content is sent to a hosted AI service and nothing requires a paid account.

- **Works with your files:** search by meaning, summaries, key points, dates, OCR, questions about a file.
- **Works with you:** quiet suggestions on Home (duplicates, things to organize, Trash, large or broken files), never pop-ups.
- **Works for you:** File Box prepares organization, cleanup and file actions; you review and confirm before anything changes.

The current version runs on localhost as a private, local-AI build of the product.

## What's in the product

- **Home** – Ask File Box, Continue working, up to three File Box suggestions, and recent activity (including what File Box did for you)
- **My Files** – folders, upload, download, rename, move, copy, star, trash, version history, previews
- **Shared / Recent / Starred / Trash** – real data from file timestamps, access logs and activity
- **File Box AI** – ask about your files or tell File Box what to do (create folders, rename, move, star, share, trash, file requests, team spaces, backups, summaries)
- **Team Spaces and File Requests** – shared folders, team chat, collecting files from others
- **Signatures and Backup** – e-signatures for documents, scheduled local backups
- **Settings** – account, storage and secondary tools (secured links, file connections, templates, web shortcuts, storage analytics, security, integrations)

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | React, TypeScript, React Router |
| Backend | Node.js, Express, Socket.IO, Multer |
| Database | MongoDB (Mongoose) |
| AI | Ollama, local only |
| Documents | pdf-parse, PDF.js, Mammoth, Tesseract.js, pdf-lib, docx |

Every dependency is free and open source. No API keys or credit cards are needed.

## Run it locally

Prerequisites: Node.js, MongoDB, and (optionally) Ollama.

```bash
npm run install-all
cp server/env.example server/.env   # then adjust values
npm run dev                         # server on :5001, client on :3000
```

For File Box AI:

```bash
ollama serve
ollama pull llama3.1:8b   # assistant, planner and summaries
ollama pull glm-ocr       # optional: better OCR for scanned PDFs
```

### Without Ollama

File Box keeps working when Ollama is stopped: uploads, downloads, folders, sharing, search and backups don't depend on it.
The File Box AI page shows **"File Box AI is offline"** with a *Check again* button and reconnects automatically once Ollama is running; no restart needed.

## How File Box AI stays safe

- Every file action is scoped to files the signed-in user owns; the assistant can only read files the user owns or that were shared with them.
- Moving files to Trash and sharing them always require an explicit confirmation in the UI before anything happens.
- The assistant can't permanently delete files, and can only set up Desktop or Documents backups (custom folders go through the Backup page).
- "Find…" questions are answered from a real local search, so the assistant only mentions files that exist.

## Project layout

```text
client/src
  components/   pages and UI (Dashboard, Sidebar, HomeView, RecentView, AIAssistant, FileBrowser, …)
  config/       navigation and local-preview settings
  services/     API client
  utils/        display helpers
server
  config/       app and AI (Ollama) configuration
  models/       Mongoose models
  routes/       REST API
  services/     Ollama client, assistant, action executor, search, text extraction, backups
  uploads/      file contents (local disk, git-ignored)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how storage, AI and search fit together, what is disabled, and what is planned.

## License

MIT
