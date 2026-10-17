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
                            ├─ intentRouter     local rules decide the intent; Ollama only picks one
                            │                   fixed intent when no rule matches
                            ├─ fileResolver     names -> one permitted file/folder, or "which one?"
                            ├─ workspaceSearch  local search for search requests
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

### Intent routing (Accuracy Step 3)

`services/intentRouter.js` classifies every chat request before any model call. Intents: `search`, `smart_search`, `summarize`, `explain`, `file_question`, `organize`, `duplicates`, `action` (create folder/file, rename, move, star, share, trash, restore, and the other create actions), `help`, `chat`.

- **Rules first.** Politeness is stripped ("please", "can you") and "find X and delete it" becomes "delete X". Then the rules run in order: greetings, how-to questions, duplicates, actions (the verb has to lead the request), organize, summarize, explain, questions that name their file, search questions, questions about the selected file, and short keyword searches. Rules also pull out the names a request refers to (target, destination, new name).
- **Model fallback.** Only when no rule matches does Ollama classify, using the `classify` task (temperature 0, fixed seed) with schema-constrained output that must be one of the intents. Invalid output becomes `chat`. A model-routed `action` without a rule-known action type gets a clarifying answer and never a guessed action.
- **The model never overrides a rule.** When a rule matches, the model is not called.
- **Debugging.** Every chat reply includes `route: { intent, action, source: "rule" | "model", rule, confidence }`.
- **Offline.** Search, duplicates, organize, choices and rule-routed actions (including confirmations) work without Ollama. Summaries, explanations, file questions, help, chat and model fallback return `AI_OFFLINE`.
- The JSON planner (`planTurn`) and the keyword parser (`parseAction`) were removed.

### Ask instead of guessing (Accuracy Step 4)

`services/fileResolver.js` turns a typed name into exactly one file or folder:

- Matching runs in tiers: exact name, then exact name without extension, then every word present. The first non-empty tier wins, so "report.pdf" is exact even when "report.docx" exists.
- **One permitted match**: proceed. **None**: say so. For an owner-only action, if only a shared file matches, the answer says that only its owner can change it. **Several**: the reply lists them (`choices`) with name, location (folder path, Team Space, or "Shared by …" without revealing the owner's folders), modified date and Yours / Shared with you / Team Space. Nothing is picked automatically.
- Choices are sorted by name, location, date and id, never by database order. At most 8 are shown; when there are more, the reply asks for more of the name.
- **Resuming.** A choice reply carries `resume: { question, fileId, resolved }`. Picking an option sends the original request again with `resolved.files[<name>] = id` or `resolved.folder = id`. Routing is deterministic, so the same request is rebuilt, and the chosen id is re-authorized. A move can ask for the file and then the folder.
- Trash and share still end in the usual confirmation. `pendingAction.fileIds` holds the chosen files, and `/confirm` acts only on those ids after re-checking ownership. A confirm without ids re-resolves by rules only and refuses when a name is not unambiguous.

### AI search scope (Phase 3)

"Find…" questions search everything the user may read, using the Phase 2 permission module: owned files, active direct shares, and files anywhere inside the user's Team Spaces (`readableFileFilter`). Every result is then re-checked with `getFileRole` (`filterReadable`), labelled with how the user can see it (`source`: owned / shared / team, plus role, owner name or Team Space name), and de-duplicated; a file reachable both by direct share and through a Team Space appears once with the stronger access. Results never include server paths or other recipients. Trash is searched only when the question asks for it, and only the user's own trashed files. The header search stays limited to the user's own files.

Chat searches prefer names: when some file names contain every search word, only those are shown ("Find my resume" means a resume, not a file that mentions resumes), and the answer says how many other files mention the word. Questions about contents ("Which files mention…", "about", "contains") and searches with no name match use content matches as before. The header search is unchanged.

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

### Accuracy Steps 3–4 known issues

- Follow-ups that use a pronoun after a search ("share the second one", "move it") are not linked to the previous results. The user names the file, selects it, or picks from the choices.
- Matching is by file name only; "Delete the old report" looks for names containing "old" and "report".
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
