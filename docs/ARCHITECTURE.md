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
                            ├─ planTurn()       Ollama picks intent + action (JSON)
                            ├─ workspaceSearch  local search for "find…" questions
                            ├─ aiActionExecutor runs the action, scoped to files the user owns
                            └─ composeAnswer()  Ollama writes the reply
                 ─► POST /api/ai-assistant/confirm   trash/share after the user confirms
                 ─► GET  /api/ai-assistant/status    Ollama reachability + installed models
```

- **Permissions**: file lookups in the executor always filter by `owner: userId` and `isTrashed != true`. Reading for summaries/questions also allows files shared with the user. The confirm endpoint re-runs the same scoped lookup, so a forged request cannot touch another user's files.
- **Confirmation**: `delete_file` (move to Trash) and `share_file` never run directly from chat; the assistant returns a `pendingAction` that the UI shows with *Move to Trash / Share* and *Cancel*.
- **Not available to AI**: permanent deletion, custom backup paths, student features.
- **Offline**: the status check has a 3-second timeout. Chat and summaries return `503` with `code: "AI_OFFLINE"`, and the UI shows the offline banner and re-checks every 15 seconds.
- **Summaries** (`/api/summaries`, assistant) use `OLLAMA_SUMMARY_MODEL` on demand. Uploads no longer auto-summarize.
- **OCR**: scanned PDFs try Ollama's OCR model, then fall back to Tesseract.js (local).

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

## External services

| Service | Used for | Cost |
| --- | --- | --- |
| Ollama (local) | File Box AI | Free, open source |
| MongoDB (local) | Metadata | Free (Community Server) |
| SMTP (optional) | Email verification and password reset | Free with any mailbox you already have; File Box works without it |
| Microsoft Teams / Zoom / Slack OAuth (optional) | Integrations page | Free developer apps; not needed for core File Box |

## Storage page

`services/storageSummary.js` measures real usage from the user's files (active plus Trash), by category (Documents, Images, Videos, Audio, Archives, Other, by MIME type and extension), the largest files, Trash size, files missing from disk, and duplicate files. Duplicates are found by grouping equal sizes and confirming with SHA-256 (capped at 300 files / 1 GB per request). If the account's quota counter has drifted from the measured total, the page says so and offers an explicit recalculation.

## Planned work (not started)

- Version retention limits and content-hash deduplication (see VERSION_HISTORY.md).
- Folder sharing, if wanted, using the existing `Folder.sharedWith` field and the permission layer.
- Nested folders inside Team Spaces are permission-aware but only the Space's top level is browsable in the UI.
