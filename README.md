# File Box

File Box is a full-stack cloud storage platform built around fast file organization, document handling, and an Ollama-powered copilot that can take actions inside the app for the user.

## Highlights

- Storage-first interface for files, folders, sharing, trash, backups, and secured links
- AI assistant that can create, rename, move, share, delete, and organize content directly
- PDF and DOCX preview, editing, extraction, and OCR-aware document processing
- Templates, shortcuts, file requests, team folders, and backup utilities
- Student-focused extras such as courses, assignments, study groups, and calendar events

## Tech Stack

- Frontend: React, TypeScript, React Router, Axios
- Backend: Node.js, Express, MongoDB, Mongoose
- AI and documents: Ollama, PDF.js, Mammoth, Tesseract.js, pdf-lib, docx
- Realtime and uploads: Socket.IO, Multer

## Local Development

### Prerequisites

- Node.js
- MongoDB
- Ollama (optional, but recommended for the assistant and local document workflows)

### Install

```bash
npm run install-all
```

### Configure

Copy `server/env.example` to `server/.env` and set the values you need.

Minimum local setup:

```env
PORT=5000
MONGODB_URI=mongodb://localhost:27017/dropbox-clone
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
CLIENT_URL=http://localhost:3000
OLLAMA_ENABLED=true
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_ASSISTANT_MODEL=llama3.1:8b
OLLAMA_ASSISTANT_PLANNER_MODEL=llama3.1:8b
OLLAMA_SUMMARY_MODEL=llama3.1:8b
OLLAMA_OCR_MODEL=glm-ocr
```

### Run

Start both apps from the repo root:

```bash
npm run dev
```

Or run them separately:

```bash
cd server && npm run dev
cd client && npm start
```

### Ollama Setup

If you want the local assistant and OCR flows enabled:

```bash
ollama serve
ollama pull llama3.1:8b
ollama pull glm-ocr
```

## Main Product Areas

### Drive

- All files, shared files, starred, trash, and team folders
- Upload, download, move, rename, star, restore, and delete actions
- Storage tracking and backup utilities

### AI Copilot

- Chat-style assistant embedded in the app
- Executes in-app tasks instead of only explaining them
- Uses Ollama for local-first action planning, responses, and document understanding

### Documents

- Preview and edit supported files inside the product
- Extract text from PDF and DOCX files
- Fall back to OCR for scanned PDFs when needed

### Sharing and Utilities

- Secured links
- File requests
- Templates
- Web shortcuts
- Integrations and team collaboration surfaces

## Project Structure

```text
Filebox/
├── client/
│   ├── public/
│   └── src/
│       ├── components/
│       ├── context/
│       ├── services/
│       ├── styles/
│       └── utils/
├── server/
│   ├── config/
│   ├── middleware/
│   ├── models/
│   ├── routes/
│   ├── services/
│   └── index.js
├── package.json
└── README.md
```

## Notes

- Uploaded files are stored locally under `server/uploads/`
- Local `.env` files and uploaded content are ignored from version control
- Default storage allocation is 10 GB per user in the current app setup

## Contributor

- SDRoan

## License

MIT
