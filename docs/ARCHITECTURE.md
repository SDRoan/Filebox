# File Box architecture

How the current (local) version of File Box is put together, what is intentionally switched off, and what is planned next.

## Overview

```text
React client (localhost:3000)
   │  REST + Socket.IO
   ▼
Express API (localhost:5001) ──► MongoDB          metadata: users, files, folders, shares, activity
   │                        ──► server/uploads/   file contents on local disk
   │
   └─► Ollama (localhost:11434)                   File Box AI only; optional
```

File Box has no hosted dependencies. Storage, sharing, search and backups never call Ollama; only AI features do.

## File storage

- **Metadata** lives in MongoDB (`File`, `Folder`, `FileVersion`, `FileContent`, `Share`, `Activity`).
- **Contents** are written by Multer to `server/uploads/<userId>/<timestamp>-<random>.<ext>`. `File.path` stores the absolute path.
- **Versions**: every edit or restore first copies the current contents to `uploads/<owner>/versions/` and records a `FileVersion`. See [VERSION_HISTORY.md](VERSION_HISTORY.md).
- **Trash**: trashing sets `isTrashed`/`deletedAt`. Permanent deletion (single item, Empty Trash, the daily 30-day cleanup, deleting a Team Space) goes through `services/trash.js`, which removes contents, versions, links and extracted text and frees storage. Restored items return to their folder if it still exists, otherwise to My Files.

### Current limitations

- Contents and metadata are tied to one machine's disk; absolute paths make moving `uploads/` awkward.
- Storage access is spread across routes (`fs-extra` calls in `routes/files.js`, `routes/teamFolders.js`, backups, versions).
- No deduplication; every copy and version is a full file.

### Planned: storage abstraction (not implemented yet)

1. Introduce a `StorageProvider` interface (`put`, `get` stream, `delete`, `exists`, `stat`) with a `LocalDiskProvider` as the only implementation, and store a relative **storage key** instead of an absolute path.
2. Move all file I/O in routes behind the provider; keep `server/uploads` as the local backend so nothing migrates.
3. Later, add an S3-compatible provider. Free, self-hostable options: **MinIO** or **Garage** locally. Hosted object storage stays optional and is never required to run File Box.
4. Content hashing (SHA-256) on upload enables duplicate detection and, later, deduplicated versions.

## Permissions

`server/services/permissions.js` is the single place that decides access. A user's role on a file is:

| Role | From | Can |
| --- | --- | --- |
| owner | `File.owner` | everything: rename, move, copy, star, share, trash, delete, edit, versions |
| editor | direct share with `edit`, or Team Space role admin/editor | edit contents, versions, view, download, comment |
| viewer | direct share with `view`, or Team Space role viewer | view, download, comment |
| none | anything else, expired shares, or the file is in someone else's Trash | nothing; routes answer 404 so existence isn't revealed |

- Direct shares honor `expiresAt`.
- Team Space access comes from the Space the item is inside (walking up nested folders).
- `authorizeFile` / `authorizeFolder` are used by file, version, share, comment, annotation, signature, file-memory, summary and AI routes. `readableFileFilter` is the query File Box AI uses to find files it may read.
- Team Space management (`getTeamRole`): owner and admins manage members and rename; editors upload and add folders; viewers read. Members can leave; the owner cannot.
- The client mirrors the same rules in `client/src/utils/permissions.ts` only to decide which actions to show; the server always re-checks.

## Sharing

- **People:** owners add people by exact email with *Can view* or *Can edit*, change permission, or remove access. Recipients can remove a file from their own Shared list. There is no user directory or partial user search.
- **Links:** view-only public links at `/s/<id>` with optional password (stored as a bcrypt hash; older plain-text link passwords still work), expiry date, and download on/off. Links stop working when the file is trashed. Public link metadata never includes server paths or other recipients.
- **Not supported:** folder sharing (the `Folder.sharedWith` field exists but no route uses it) and editable links.

## File Box AI

```text
AIAssistant page ─► POST /api/ai-assistant/chat
                       └─ ollamaWorkspaceAssistant
                            ├─ requestUnderstanding  Ollama reads the request -> structured JSON
                            │  (intentRouter rules stand in only when Ollama is off: "offline mode")
                            ├─ aiFileFinder     permitted candidates -> Ollama judges which ones are meant
                            ├─ fileResolver     exact names, folders, choices, re-checking picked ids
                            ├─ workspaceSearch  text search ("which files mention …") and offline search
                            ├─ aiActionExecutor runs the action on the resolved files
                            └─ composeAnswer()  Ollama writes answers that need it
                 ─► POST /api/ai-assistant/confirm   trash/share after the user confirms
                 ─► GET  /api/ai-assistant/status    Ollama reachability + installed models
```

- **Permissions**: names are resolved by `fileResolver` using the Phase 2 permission module. Actions that change a file (rename, move, share, trash, star, restore) only consider the user's own files; summaries, explanations and questions consider everything the user may read (own files, active shares, Team Spaces). File ids chosen in the browser and the ids in a confirmation are re-checked with `authorizeFile` / `authorizeFolder`, so a forged id cannot touch another user's files.
- **Confirmation**: `delete_file` (move to Trash) and `share_file` never run directly from chat; the assistant returns a `pendingAction` that the UI shows with *Move to Trash / Share* and *Cancel*.
- **Not available to AI**: permanent deletion, custom backup paths, student features.
- **Offline**: the status check has a 3-second timeout. Questions that need the model and AI file actions return `503` with `code: "AI_OFFLINE"`; the UI shows the offline banner and re-checks every 15 seconds. Finding files, duplicate checks, rule-based organization suggestions and OCR text extraction keep working without Ollama.
- **Summaries** (`/api/summaries`, assistant) use `OLLAMA_SUMMARY_MODEL` on demand. Uploads no longer auto-summarize.
- **OCR**: scanned PDFs try Ollama's OCR model, then fall back to Tesseract.js. The English language data ships in the repo (`server/eng.traineddata`), so OCR works offline. OCR runs in a guarded worker so a corrupt image can't crash the server.

### Generation settings (Accuracy Steps 1–2)

Every model call goes through `services/ollamaClient.js`; callers pass a `task` and never set temperature.

- **Task profiles** (`TASK_PROFILES`): classify, plan, action, extract, organize, rename, ocr, summarize, answer, describe. All use temperature 0 with a fixed seed (`OLLAMA_SEED`, default 42) and a per-task output cap. Seeded 0.1 still drifted on long summaries, so summaries and answers also use 0.
- **Context window**: `num_ctx` is always sent (`OLLAMA_CONTEXT_WINDOW`, default 8192). Ollama's default of 4096 silently dropped the start of long prompts.
- **Prompt budget** (`fitPrompt`): system rules and the request are never trimmed. Only file/document context (passed as `context`) is trimmed, from the end, with a marker, and placed at a `{{CONTEXT}}` slot in the request when one is given. If the rules and request alone do not fit, the call fails with `PROMPT_TOO_LARGE` (413) instead of dropping rules.
- **Exact-repeat cache**: Ollama reuses its prompt cache between calls, which can change the first long output slightly compared with later identical calls. Text requests are cached in memory (300 entries, 6 hours) by a hash of task, model, prompt, file text and settings, so the same request with the same files gives the same answer. Any change to the request or the file is a new key. Images are not cached. The cache is cleared on restart.

### Assistant parser fixes (Accuracy Step 2)

- "Share X as a link" is a share request (confirmation required), not a file relationship.
- "Move X into the Taxes 2026 folder" resolves the folder name without "the" or "folder"; quoted names win.
- "Share X with Sarah" without an email asks for Sarah's email and creates nothing. File Box shares only with an exact account email.
- "Rename my resume to …" finds the user's own file without an extension when exactly one matches, keeps the original extension, and asks which file when several match.

### Understanding requests

When Ollama is running, the local model reads every chat request (`services/requestUnderstanding.js`, `plan` task, temperature 0, fixed seed, schema-constrained JSON). It returns the intent (`search`, `smart_search`, `summarize`, `explain`, `file_question`, `organize`, `duplicates`, `action`, `help`, `chat`), the action (create folder/file, rename, move, star, share, trash, restore, and the other create actions), which file is meant (in the user's words), the destination, the new name, search terms, and whether the user wants a file that *is* something or files that *mention* some words. The recent conversation is included, along with the names of files shown in earlier answers, so "share it" or "move that one" refers to the right file.

- **Code keeps it safe, not smart.** The model decides what is meant. Code enforces permissions, asks when several files match, keeps the confirmations for trash, share and bulk changes, and never lets the model invent files.
- **Offline mode.** When Ollama is not running, or does not answer in 45 seconds, `services/intentRouter.js` rules stand in. They strip politeness, then look for leading verbs, search questions and short keyword searches. Search, choices, simple commands and confirmations keep working, and replies are marked offline in the UI. Summaries, explanations, file questions, help and chat return `AI_OFFLINE`.
- **Debugging.** Every chat reply includes `route: { intent, action, source: "model" | "rule" | "offline", rule, confidence, mode: "ai" | "offline" }`.
- **Understanding is repeatable.** Temperature 0, the seed and the exact-repeat cache give the same interpretation for the same request and conversation.

### Finding the file the user means

`services/aiFileFinder.js`:

1. **Candidates** come only from files the user may access: the whole drive when it has 25 files or fewer; otherwise name matches, File Box's notes on what files are, text matches, and the most recent files, up to 25.
2. **The model judges them.** It sees each candidate's name, kind, one-line description and opening text, writes down the kind of file wanted, then gives a yes/no per file. A file that only mentions a topic is not a match. "Find my resume" finds a resume named `SR profile.txt` and skips a startup-ideas list that mentions resumes. "Find my CV" finds the same resume.
3. **File profiles.** `services/fileProfiler.js` asks the model once per file version what the file is. It stores the result in `FileContent.aiType` / `aiDescription` / `aiProfiledAt` / `aiProfileModel` (new optional fields, no migration needed). It runs in the background, one file every 30 seconds, only while Ollama is reachable and nobody has used File Box AI in the last 30 seconds. Disable it with `FILEBOX_AI_PROFILER=off`. Up to 5 unprofiled candidates are also profiled on demand before judging.
4. **Safety around inference.**
   - A typed exact file name (with an extension) is matched by name only.
   - When a change without its own confirmation (rename, move, star) would apply to a file the model inferred, and the file's name doesn't contain the user's words, File Box first asks "I think you mean X — is that the one?".
   - If judging fails or times out, File Box falls back to name matching.
5. "Which files mention …" (`lookFor: words_inside_files`) is a literal text search with `workspaceSearch`.

### Speed

- **Streaming.** `POST /api/ai-assistant/chat` with `stream: true` answers with one JSON object per line: `{type:"token",text}` while the answer is written, then `{type:"done",reply}` or `{type:"error",status,body}`. The File Box AI page shows the answer word by word.
- **One model, short prompt.** Requests are understood by `OLLAMA_UNDERSTANDING_MODEL`, which defaults to the assistant model so only one language model is in memory. A second model pushed a 16 GB laptop into swap. The understanding prompt is about 1,400 tokens: short instructions plus worked examples given as earlier turns. Ollama re-reads the whole prompt whenever its cache was used for something else (about 8 s per 1,000 tokens on that laptop), so the background reader also waits until File Box AI has been idle for 2 minutes. When the model's fields contradict its label, the fields win (`reconcile`): a file plus a destination folder is a move, and a shortcut or secured link with no web address is a share. In a benchmark of `qwen2.5:7b` against `llama3.1:8b`, qwen understood requests slightly better but cited wrong file names in answers, so llama stays.
- **Answers across files** read passages only from the files that clearly lead the ranking (within 0.06 of the best), with passages weighted by their file's relevance.
- **Background reading steps aside.** A request from the user cancels any background file read in progress (`ollamaClient` aborts it), which is retried later. While the File Box AI page is open it sends `POST /api/ai-assistant/presence` every 20 seconds, and background reading stays paused.

### Accuracy test set

`npm run test:ai` (in `server/`) checks File Box AI against a fixed set of realistic files (`server/ai-accuracy/fixtures.js`) and questions with known right answers (`server/ai-accuracy/cases.json`). It covers understanding requests, finding files, answering from files, and privacy across accounts.
- It builds a throwaway database (`filebox-ai-accuracy`; it refuses any database whose name lacks "test" or "accuracy"), has File Box read every file with the real profiler and passage index, asks every question, prints a score per area, and drops the database.
- `--only=<area>` runs one area. `--strict` makes any failure an error.
- **Every mistake becomes a case:** add it to `cases.json`. File names in the fixtures deliberately don't reveal what the files are.
- **Your own corrections:** `node scripts/exportAiFeedback.js` turns 👎 corrections into `ai-accuracy/live-cases.json` (your questions and file ids, so it's in `.gitignore`). `npm run test:ai -- --live` then also checks those against your real data, read-only.
- First full run: 39/41. The two misses were fixed: flat embedding scores now widen the judging, and questions now look in more files when the leading ones lack the answer.

### Feedback and corrections

Every answer has 👍/👎. 👎 can name the file that was meant, plus a note. `POST /api/ai-assistant/feedback` stores it in `AIFeedback`; a named file must be one the user can read. When the same person later asks something similar in meaning (cosine ≥ 0.86 with `nomic-embed-text`), `services/aiFeedback.js` adds the corrected file and removes the files they marked wrong, both when finding files and when choosing which files to read for an answer. Corrections never affect other accounts.

### Seeing what File Box AI is doing

- **Reading progress.** `GET /api/ai-assistant/reading-status` returns `{ total, done, pending }` for the user's files with text. The AI page shows "File Box is reading your files: 4 of 6 done" until everything is read.
- **Where an answer came from.** Answers to questions across files include `sources: [{ fileId, name, quote }]`: for each named file, the line of its text (or noted fact) that shares the most with the answer. The page shows the quotes under the answer; clicking one opens the file.
- **Looking further.** When the files that looked most relevant don't contain the answer, the next most relevant files are read before File Box says it couldn't find it. The stream sends `{type:"reset"}` so the page replaces the first attempt.

### Reading files and answering from them

- **What each file is.** `services/fileProfiler.js` reads each file's text once per version: the beginning, plus samples from the middle and end of long files. It stores a broad category (homework, transcript, bill, certificate, work document, …) in `FileContent.aiCategory`, a specific kind in `aiType`, a description in `aiDescription`, and up to 6 key facts in `aiFacts` (amount due, due date, grade, issuer, …, copied from the text). `aiProfileVersion` lets older notes be re-read. It runs in the background while Ollama is idle.
- **Passages.** `services/fileIndex.js` cuts each file's text into ~900-character passages with a meaning vector each, stored in the new `FileChunk` collection (up to 200 passages per file). Passages are rebuilt when the text changes, and orphans are removed.
- **Questions across files** (intent `drive_question`, e.g. "When is my electricity bill due?"):
  1. The files the user may read are ranked by meaning.
  2. Their best passages and key facts are retrieved.
  3. The model answers only from them, naming the source file. If the files don't contain the answer, it says so.
  4. Only files the user may read are searched, including files shared with them.
- **Questions about one file** use the whole text when it is short. Otherwise they use the beginning plus the passages closest to the question, instead of only the first 12,000 characters.
- Results show what each file is (`kind`).

### Ask instead of guessing (Accuracy Step 4)

`services/fileResolver.js` handles exact names, folders and offline matching, and `aiFileFinder` handles descriptions. Both lead to the same three outcomes:

- Matching runs in tiers: exact name, then exact name without extension, then every word present. The first non-empty tier wins, so "report.pdf" is exact even when "report.docx" exists.
- **One permitted match**: proceed. **None**: say so. For an owner-only action, if only a shared file matches, the answer says that only its owner can change it. **Several**: the reply lists them (`choices`) with name, location (folder path, Team Space, or "Shared by …" without revealing the owner's folders), modified date and Yours / Shared with you / Team Space. Nothing is picked automatically.
- Choices are sorted by name, location, date and id, never by database order. At most 8 are shown; when there are more, the reply asks for more of the name.
- **Resuming.** A choice reply carries `resume: { question, fileId, resolved }`, and `resolved.route` holds how the request was understood. Picking an option sends the original request again with `resolved.files[<name>] = id` or `resolved.folder = id`. The request is not re-read: the server validates the returned interpretation against the allowed values and re-authorizes the chosen id. A move can ask for the file and then the folder.
- Trash and share still end in the usual confirmation. `pendingAction.fileIds` holds the chosen files, and `/confirm` acts only on those ids after re-checking ownership. A confirm without ids re-resolves by rules only and refuses when a name is not unambiguous.

### AI search scope (Phase 3)

"Find…" questions search everything the user may read, using the Phase 2 permission module: owned files, active direct shares, and files anywhere inside the user's Team Spaces (`readableFileFilter`). Every result is then re-checked with `getFileRole` (`filterReadable`), labelled with how the user can see it (`source`: owned / shared / team, plus role, owner name or Team Space name), and de-duplicated; a file reachable both by direct share and through a Team Space appears once with the stronger access. Results never include server paths or other recipients. Trash is searched only when the question asks for it, and only the user's own trashed files. The header search stays limited to the user's own files.

Chat search uses the AI file finder (above) when Ollama is running. In offline mode it prefers names: when some file names contain every search word, only those are shown, and the answer says how many other files mention the word. The header search is unchanged.

### File-type actions

`GET/POST /api/ai-assistant/file-actions/:fileId` (viewer access, file not in Trash). Actions depend on the file type and on what can actually run:

| Type | Actions |
| --- | --- |
| PDF, DOCX and other documents | Summarize, Explain simply, Key points, Important dates |
| Code | Explain code, Summarize, Find important sections |
| Text (txt, md, csv…) | Summarize, Key points, Find important sections, Important dates |
| Images | Extract text (local OCR, works offline), Summarize extracted text, Describe image (only if the local vision model `OLLAMA_VISION_MODEL`, default `llama3.2-vision`, is installed) |

"Ask a question about this file" opens the File Box AI chat with the file selected. Prompts are fixed per action and only see the file's own text. Text that does not fit the context window is trimmed from the end and the result says `truncated: true`.

### Duplicate suggestions

`GET /api/ai-assistant/duplicates` uses the Phase 2 checksum detection on the user's own files. For each group, rules choose a copy to keep and say why: shared or linked (removing it would break sharing), starred, has versions, organized in a folder, strictly the oldest; names like "Copy of…" or "(1)" count against a copy. When the best copies score the same, File Box says it cannot choose. With `?explain=1` and Ollama online, the model writes a short explanation without changing the suggestions. Nothing is deleted; the UI moves only the copies the user confirms to Trash and refuses to remove every copy of a group.

### Organization suggestions

`POST /api/ai-assistant/organize/suggest` proposes changes for one folder (or My Files) of the user's own files; nothing is applied. Rules group screenshots and files sharing a clear name prefix and give camera-style image names a date name. When Ollama is available it adds topic folders and names for vague files, validated (renames only for vague names, new folders only for 2+ files, no adding to rule-owned folders, file type never changed). `POST /api/ai-assistant/organize/apply` requires `confirm: true` and re-authorizes every action as owner (file and destination folder); results are reported per action. The UI pre-selects nothing and lets the user edit destinations and names before confirming.

## Search

`services/workspaceSearch.js` ranks the user's files by:

1. similarity of local embeddings (512-dimension hashed bag-of-words; computed in-process),
2. keyword matches in extracted text,
3. filename matches,

plus folder-name matches. It never needs Ollama or the internet. Embeddings stored by older versions (other dimensions) are recomputed from the extracted text at query time.

## Disabled product surfaces

Student and social features were removed from the File Box UI. Their code is still in the repo but unreachable:

| Area | Client components (not imported) | API routes (off unless `FILEBOX_ENABLE_STUDENT_FEATURES=true`) |
| --- | --- | --- |
| Courses, assignments, notes | `StudentDashboard`, `CourseManager`, `AssignmentTracker`, `CourseNotes`, `QuickDashboard` | `/api/courses`, `/api/assignments`, `/api/course-notes` |
| Study tools | `StudyGroups`, `StudySchedule`, `StudyAnalytics`, `StudyTools`, `ProgressTracking` | `/api/study-groups`, `/api/study-schedule`, `/api/study-sessions`, `/api/progress-tracking`, `/api/calendar` |
| Community | `Forums`, `SocialFeed`, `GroupsList`, `GroupView`, `UserProfile`, `Referrals` | `/api/forums`, `/api/groups`, `/api/referrals` (`/api/social` was already unregistered) |
| Learning library | `Learning` | `/api/learning` and its daily scheduler |

Models (e.g. `Course`, `StudyGroup`) stay because file listings still exclude legacy course and study-group folders. These can be deleted in a later cleanup once no data depends on them.

Removed outright because they only called hosted AI: `services/summarization.js`, `routes/summarization.js`, `services/aiResourceGenerator.js`, `scripts/generateLearningResources.js`, `DocumentSummary` component, and the `openai` and `@huggingface/inference` packages.

## Known issues

Documented and intentionally left for later phases:

- **Folder sharing** is not supported. `Folder.sharedWith` exists in the schema but no route uses it, so the UI only offers sharing for files.
- **Team Space subfolders** are permission-aware (access is resolved by walking up to the Space), but only a Space's top level is browsable in the UI.
- **Recent → team files:** opening a teammate's Team Space file from Home or Recent goes to Shared instead of the Team Space.
- **Old password-bug accounts:** accounts registered before the double-hashing fix (Phase 1) cannot sign in with their password and need a password reset (which requires SMTP to be configured). The local workspace session is not affected.

### Phase 3 known issues

- AI search returns at most 8 files per question; there is no "show more" yet.
- AI organization suggestions vary between runs (model output); every proposal is reviewed by the user, and rule-based ones are stable.
- Duplicate detection covers only the user's own files (others' copies can't be trashed by them), and checks at most 300 same-size files / 1 GB per request.
- Image description needs the optional local vision model; without it the action is not offered.

### File Box AI known issues

- Every chat request waits on the local model, about 4 seconds to understand it plus 2–4 seconds to judge files on a Mac with llama3.1:8b. The first search in a drive with unprofiled files can take longer, while up to 5 files are profiled.
- The model can misunderstand. For example, "move report.pdf to the bin" is read as a folder named "bin" and fails safely with "no folder named bin". Results are repeatable, not guaranteed right.
- In drives with more than 25 files, a file whose name, text and profile share no words with the request and that isn't recent may not reach the model until the background profiler has described it.
- Move destinations are the user's own folders, as before. Moving into a Team Space or to the My Files root from chat is not supported.
- File relationships ("relate a.pdf and b.pdf") still use the older first-match name lookup.
- Rules are English-only.

### Phase 4A known issues

- Dismissed Home suggestions are remembered per browser (local storage), not per account. A card comes back only when what File Box noticed changes.
- Shares made before Phase 4A are not in Recent activity (they still count toward Continue working through the share entries).
- Pressing Enter in the header search hands the text to File Box AI; true command routing (search vs action vs organize) is Phase 4B.
- The login positioning line is only visible when sign-in is enabled (local preview signs in automatically).

## External services

| Service | Used for | Cost |
| --- | --- | --- |
| Ollama (local) | File Box AI | Free, open source |
| MongoDB (local) | Metadata | Free (Community Server) |
| SMTP (optional) | Email verification and password reset | Free with any mailbox you already have; File Box works without it |
| Microsoft Teams / Zoom / Slack OAuth (optional) | Integrations page | Free developer apps; not needed for core File Box |

## Signing PDFs

Signatures are drawn and saved on the Signatures page (`Signature`). To sign, open a PDF's menu in My Files and choose **Sign** (shown to the owner and editors only).
- The dialog shows the PDF's pages as images. The server renders them with pdf-parse: `GET /api/signatures/document/:fileId/pages` and `/pages/:n`.
- You click where the signature goes and adjust its size. Positions are fractions of the page, so they don't depend on screen size.
- `POST /api/signatures/apply/:fileId` stamps the signature into the PDF with pdf-lib (`services/pdfSign.js`). Requirements: editor access, a PDF not in Trash, and one of the signer's own signatures.
- The unsigned file is saved first as a version ("Before signing"), and then the signed copy replaces it. Signing is recorded in `DocumentSignature` and in activity ("Signed with …").
- Previously the apply step accepted viewers and never stamped the PDF, and no part of the UI could reach the signing screen.

## Your day (Home)

Home shows what the person did in File Box each day, File Box AI's summary of it, and suggestions. This replaces "Continue working" and "Recent activity". The idea follows daily-work-summary tools such as DeskTrust, WorkWitness and Work Review, but only activity inside File Box is recorded, and it stays on this machine.

- **What is recorded (`Activity`).**
  - Uploads, edits, downloads, shares, moves, renames and other file changes, as before.
  - New `viewed` entries: opening a file to look at it. Previews call `/files/download/:id?purpose=view`, and the text preview counts too. Repeats within 10 minutes count once. Previews used to be logged as downloads.
  - New `focused` entries: time with a file open and visible. A 30-second heartbeat from the preview and editor (`POST /api/activity/focus`, `hooks/useFileFocus.ts`) is stored in `durationSeconds`/`endedAt`. Heartbeats less than 2 minutes apart extend one sitting.
  - New `asked` entries: questions asked in File Box AI. Picking a choice from a list doesn't count as a new question.
- **Facts (`services/dailySummary.js`, `GET /api/home/day?date=&tz=`).** For one day in the person's time zone: totals (time in files, files worked on, uploads, edits, opens, downloads, shares, questions), the files worked on with time and actions, File Box's note on what each file is, folders, questions, and an hour-by-hour timeline. It also returns the recent days that have activity, for the day picker.
- **Summary (`POST /api/home/day/summary`).**
  - The local model writes a 2–4 sentence summary, up to 5 highlights and up to 3 suggestions from the facts only, as schema-constrained JSON.
  - It's cached in `DailySummary` per person and day, and rewritten when the day's facts change (`factsHash`).
  - Without Ollama, plain sentences are built from the facts and marked as a basic summary.
  - Home shows the facts immediately and asks for a summary only when there's no current one.
- File Box's rule-based suggestion cards (broken files, duplicates, large files…) appear under "Suggestions", next to File Box AI's suggestions.
- `GET /api/home` still returns the Phase 4A overview (suggestions, continue working, activity) for other callers.

## Home overview (Phase 4A)

`GET /api/home` (`services/homeSummary.js`) returns everything Home shows, computed from local data only. It never calls Ollama, so Home stays fast and works offline.

- **Continue working:** files from the last 30 days scored by interaction type (edited 3, shared with you 2.5, viewed/downloaded/shared/commented/File Box action 2, restored/starred 1.5, uploaded/renamed/copied 1, moved 0.5), each decaying with a one-week half-life. Sources: Activity entries, the file access log, share-entry timestamps and upload times. Results are limited to files the user can still open (`readableFileFilter` + `filterReadable`); trashing is ignored.
- **Suggestions:** all candidates in priority order (Home shows the first 3 not dismissed, so dismissing reveals the next): files missing from disk, Trash items deleted forever within 3 days, duplicate files (checksum budget 100 files / 64 MB on Home), screenshots or name-prefix groups in My Files (organize rules), Trash ≥ 50 MB or ≥ 20% of usage (min 5 MB), and the five largest files when they hold ≥ 50% of usage (min 10 MB). Each has what File Box noticed, why it matters, a recommendation and one action (open a review dialog or a page). Nothing runs automatically. Dismissals are stored in the browser per suggestion and fingerprint, so a card returns only when what File Box noticed changes.
- **Recent activity:** the user's Activity entries, with consecutive identical File Box actions grouped ("File Box organized 4 files into Screenshots").

**Schema addition:** `Activity.source` (`'user' | 'filebox'`, default `'user'`). Additive; existing records read as `'user'`. File Box sets it for AI actions and approved organize changes. Sharing (with a person or by link) is now recorded as an Activity entry.

## Storage page

`services/storageSummary.js` measures real usage from the user's files (active plus Trash), by category (Documents, Images, Videos, Audio, Archives, Other, by MIME type and extension), the largest files, Trash size, files missing from disk, and duplicate files. Duplicates are found by grouping equal sizes and confirming with SHA-256 (capped at 300 files / 1 GB per request). If the account's quota counter has drifted from the measured total, the page says so and offers an explicit recalculation.

## Planned work (not started)

- Version retention limits and content-hash deduplication (see VERSION_HISTORY.md).
- Folder sharing, if wanted, using the existing `Folder.sharedWith` field and the permission layer.
- Nested folders inside Team Spaces are permission-aware but only the Space's top level is browsable in the UI.
