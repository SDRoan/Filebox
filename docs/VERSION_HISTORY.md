# Version history: findings and current design

Reviewed in Phase 2 before any change. No schema change was made; the existing `FileVersion` model is used as designed.

## What we found

| Question | Before Phase 2 |
| --- | --- |
| How are versions stored? | `FileVersion { file, versionNumber, path, size, uploadedBy, changeDescription, createdAt }`, one document per version. |
| Was old content preserved? | **No.** The three edit routes (`PUT /files/update`, `/update-docx`, `/update-pdf`) created version records with the wrong fields (`version` instead of `versionNumber`, no `uploadedBy`), so saving failed validation and the whole edit returned an error. Even if it had saved, the record pointed at the live file's path, which the route then deleted. Neither the real `filebox` database nor the older `dropbox-clone` one contained a single version record. |
| How did restore work? | It copied the chosen version into a new live file, but also created a record pointing at the live path, which the next edit would delete. |
| Is metadata versioned? | No. Only contents and size; renames and moves are not versions. |
| Per-file only? | Yes. There is no folder or workspace snapshot. |
| Upload new version | The client sent the file to `/files/upload` with an `isNewVersion` flag the server ignored, which created a duplicate file instead of a version. |
| Permanent delete | Left version files on disk. |

## Design now

- **Immutable copies.** Before contents change, `services/fileVersions.js#snapshotCurrentVersion` copies the current contents to `server/uploads/<ownerId>/versions/<fileId>-<timestamp><ext>` and records a `FileVersion`. The live file can then be replaced or deleted safely.
- **Edits** (text, DOCX, PDF, and "Upload new version", which now uses `PUT /files/update/:id`) all snapshot first, then write new contents and adjust the owner's storage counter by the size difference. The file name is kept.
- **Restore** snapshots the current contents ("Before restoring version N"), then copies the chosen version into a new live file. Nothing is ever lost by restoring.
- **Who:** owners and editors can list, download and restore versions; viewers cannot.
- **Permanent delete** (single file, folder tree, Empty Trash, 30-day cleanup, Team Space deletion) removes all version copies.
- **Storage:** version copies do not count toward the user's quota. This is a deliberate product choice (Dropbox works the same way) and is the main thing to revisit if disk use becomes a concern.

## Not done (proposals for later)

1. **Retention:** keep versions for a fixed period (e.g. 30 or 180 days) or a maximum count per file; prune in the daily cleanup job.
2. **Deduplicated storage:** store versions by content hash so identical versions share one copy. This needs a `contentHash` field on `FileVersion` and `File`; it should be planned together with the storage abstraction (see ARCHITECTURE.md).
3. **Metadata history:** record renames and moves as Activity entries (already partly logged) rather than as versions.
4. **Version labels:** let users name a version ("Sent to client").
