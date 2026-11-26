# Stage 0 — Backup of the working tree: report

Date: 2026-11-25. The repository was not modified, apart from adding this report after the backup.

## 1. Backup location and files

**Folder:** `C:\Users\imran\Documents\screenshelf-backups\` (outside the repository). Total size 4.0 MB.

| File | Size | Purpose |
|---|---|---|
| `screenshelf-20261125-183600.tar.gz` | 2,836,922 B | Complete project folder including `.git` (history, index, config) and all modified, untracked and important ignored files |
| `screenshelf-20261125-183600.git.bundle` | 669,545 B | Second, independent copy of the git history (`git bundle --all`) |
| `screenshelf-20261125-183600.manifest.sha256` | 77,777 B | SHA-256 of all 705 archived files, taken from the live repository before archiving |
| `screenshelf-20261125-183600.git-status.txt` | 2,806 B | `git status --porcelain` at backup time |
| `screenshelf-20261125-183600.unstaged.diff` | 588,701 B | `git diff` of the 44 unstaged tracked changes (readable fallback) |
| `screenshelf-20261125-183600.head.txt` | 41 B | HEAD commit id |
| `screenshelf-20261125-183600.archives.sha256` | 206 B | SHA-256 of the archive and the bundle |

Archive checksums:
- `tar.gz`: `9b755fcc586e90dbaed776dcd9d0975837771d718d41b8ff3dadc4f84242817e`
- bundle: `7886a300dfc1bfcbf335bce18adbd96a47879ff8f827a519ba65af6ecd9193c2`

**Created:** 2026-11-25 18:35 (+01:00). The timestamp in the file names is 18:36.

## 2. Original repository state

| Item | Value |
|---|---|
| Branch | `main` |
| HEAD | `5739de168fafa9b939b85ddc0da4722fe42dc061`, the only commit ("Streamora (ScreenShelf) IPTV app for Samsung Tizen 3.0: stages 1-6") |
| `git status` entries | 92: 42 modified, 2 deleted, 48 untracked entries (91 untracked files inside them) |
| Staged changes | none |
| Unstaged changes | 44 tracked paths (42 modified + 2 deleted: `src/content/vod-codec.ts`, `src/content/vod-index.ts`) |

**Ignored paths found:**
- `android/.gradle/`, `android/app/build/`, `android/app/src/main/assets/`, `android/local.properties`;
- `build/`, `dist/`, `logs/`, `node_modules/`;
- `probe2/dist/`, `probe2/media/`;
- **`tests/build/`**.

**Finding:** `tests/build/build.test.mjs` (the 5 build tests that `npm run check` runs) is matched by the `.gitignore` rule `build/`. It exists **only on disk, never in git**. It is in the backup. Whether to change `.gitignore` is your decision; nothing was changed.

## 3. Contents and exclusions

**Included (705 files, 7,737,974 bytes uncompressed):**
- every tracked and untracked file;
- the complete `.git` folder;
- the important ignored files: `tests/build/`, `logs/` (TV dev-sink logs, evidence), `android/local.properties`, `android/app/src/main/assets/`.

**Excluded:**

| Path | Size | Reason |
|---|---|---|
| `node_modules/` | 35 MB | Reinstallable with `npm install` from the backed-up `package-lock.json` |
| `dist/`, `build/` | 6.7 MB, 4.8 MB | Build output, recreated by `npm run build:all` (includes the signed `.wgt` packages, which are rebuilt and signed again from the Tizen certificate profile on this PC) |
| `android/.gradle/`, `android/app/build/` | 0.8 MB, 30 MB | Gradle caches and APK build output |
| `probe2/dist/` | 0.2 MB | Probe build output |
| `probe2/media/` | 204 MB | Generated test media; `.gitignore` says "generated media"; recreated by the probe 2 scripts |

No signing keys or certificates are inside the repository (searched for `*.p12`, `*.pem`, `*.pri`, `*.pwd`, `*.csr`, `.env*`). The Tizen certificate profile lives outside the project and is not part of this backup.

## 4. Verification

The test extraction went to a separate temporary folder in the session scratchpad.

| Check | Result |
|---|---|
| Archive and bundle checksums (`sha256sum -c`) | **OK** |
| gzip integrity (`gzip -t`) | **OK** |
| Files in the archive | **705**, the same as the manifest |
| Extracted file count | **705** |
| Total bytes: original vs extracted | **7,737,974 = 7,737,974** |
| SHA-256 of every extracted file vs the manifest of the live repository | **all 705 match** |
| All 135 modified/untracked paths present | 133 present; the 2 "missing" are the 2 deleted files, which are deleted in the working tree too. Their content is restorable from the restored history (`git show HEAD:src/content/vod-codec.ts`, 178 lines) |
| Ignored files kept | `tests/build/build.test.mjs` and `android/local.properties` byte-identical; `logs/dev-sink` 4 files |
| `git fsck` in the restored copy | no errors |
| Restored HEAD | `5739de1…` (identical) |
| `git status` in the restored copy vs the original | **identical** |
| `git diff` in the restored copy vs the saved diff | **identical** |
| Bundle | `git bundle verify`: "is okay"; a clone from the bundle has HEAD `5739de1…` |

**Result: backup verified.**

## 5. How to restore

**Full restore (working tree, uncommitted changes and history):**
1. Rename or move the current `C:\Users\imran\Documents\screenshelf` aside. Do not delete it until the restore is checked.
2. Extract:
   `tar -xzf C:\Users\imran\Documents\screenshelf-backups\screenshelf-20261125-183600.tar.gz -C C:\Users\imran\Documents`
   This recreates `screenshelf\`.
3. Optional check: in the restored folder,
   `sha256sum -c --quiet ..\screenshelf-backups\screenshelf-20261125-183600.manifest.sha256`
4. In the restored folder: `npm install`, then `npm run check` and `npm run build:all`.

**History only:**
`git clone screenshelf-20261125-183600.git.bundle screenshelf-restored`

**Uncommitted changes only, on top of a checkout of `5739de1`:**
`git apply screenshelf-20261125-183600.unstaged.diff`. This covers tracked files only; untracked files come from the archive.

## 6. State after Stage 9

See §7, added when Stage 9 finished.

## 7. Differences from the backup after Stage 9 (2026-11-25)

The repository now differs from the backup. The backup itself was not changed, and the earlier state remains restorable from it.

**New `git status` entries (92 → 99):**
- `src/services/playlist-service.ts` (was unmodified, now modified);
- `src/app/input-quiet.ts`;
- `src/dev/device-selftest-stage9.ts`;
- `tests/unit/stage9-performance.test.mjs`;
- `docs/evidence/stage9-performance/`;
- this report and `docs/STAGE-9-PERFORMANCE-REPORT.md`.

**Already listed at backup time and changed again by Stage 9:**
- `src/screens/search-screen.ts`;
- `src/app/bootstrap.ts`;
- `src/app/platform/tizen-file-store.ts`;
- `src/app/platform/platform.ts`;
- `src/i18n/strings.ts`;
- `src/screens/live-tv-screen.ts`.

**Unchanged:** HEAD (`5739de1`), the branch, and the staged changes (none).

**Not modified, deleted or reset:** no existing file content outside the Stage 9 changes above. `src/dev/device-selftest.ts` was changed for the TV run and restored byte-identical.

## 8. Second backup, after Stage 11 (2026-11-25 22:56)

You asked for a backup of the current state. Same method and exclusions as §1–§3, in the same folder `C:\Users\imran\Documents\screenshelf-backups\`:

| File | Size |
|---|---|
| `screenshelf-20261125-225600.tar.gz` | 2,999,647 B (SHA-256 `d37060dc…7567f7`) |
| `screenshelf-20261125-225600.git.bundle` | 669,545 B (SHA-256 `7886a300…3c2`, the same as the first backup: no commits since) |
| `screenshelf-20261125-225600.manifest.sha256` | 723 files |
| `…git-status.txt`, `…unstaged.diff`, `…head.txt`, `…archives.sha256` | as in §1 |

**State at backup time:** HEAD `5739de1`, branch `main`, 115 `git status` entries, nothing staged. Stages 9–11 are included.

**Verification**, by test extraction into a separate temporary folder:

| Check | Result |
|---|---|
| Archive and bundle checksums; gzip integrity | **OK** |
| Files: archive / extracted / manifest | **723 / 723 / 723** |
| Bytes: original vs extracted | **9,394,658 = 9,394,658** |
| SHA-256 of every extracted file | **all match** |
| Modified and untracked files present | **all** (0 missing; deletions excepted, as in §4) |
| `tests/build/build.test.mjs` (ignored by git) | kept, byte-identical |
| Restored `git fsck` / HEAD / `git status` / `git diff` | no errors / `5739de1` / identical / identical |
| `git bundle verify` | "is okay" |

**Result: backup verified.**

- **Restore:** as in §5, using `screenshelf-20261125-225600.tar.gz`.
- The first backup (`…183600`) is kept. Both together use 8.3 MB.

## 9. Third backup, after Stage 14 (2026-11-26 08:11)

You asked for a backup of the current state. Same method and exclusions as §1–§3, in the same folder. Because files are now staged, there is one extra file: `…staged.diff` (`git diff --cached`).

| File | Size |
|---|---|
| `screenshelf-20261126-081137.tar.gz` | 4,530,136 B (SHA-256 `7e0a5e8a9a4e…`) |
| `screenshelf-20261126-081137.git.bundle` | 669,692 B (SHA-256 `b7ae0491d76e…`); refs `main` and `stages-6.1-to-11`, both at `5739de1` |
| `screenshelf-20261126-081137.manifest.sha256` | 942 files |
| `…git-status.txt` (168 entries), `…staged.diff`, `…unstaged.diff`, `…head.txt`, `…archives.sha256` | |

**State at backup time:**
- branch `stages-6.1-to-11`, HEAD `5739de1`;
- the 163 files you staged for the signed commit (Stages 6.1–11 and the zap-speed change);
- Stage 14 on top of them, unstaged.

**Verification**, by test extraction into a separate temporary folder:

| Check | Result |
|---|---|
| Archive and bundle checksums; gzip integrity | **OK** |
| Files: archive / extracted / manifest | **942 / 942 / 942** |
| Bytes: original vs extracted | **12,140,315 = 12,140,315** |
| SHA-256 of every extracted file | **all match** |
| Restored HEAD / branch | `5739de1` / `stages-6.1-to-11` |
| Restored `git status`, staged diff, unstaged diff | **identical** (the staged index is preserved) |
| Restored `git fsck` | no errors; one dangling tree, the same as in the original repository (left over from the commit that failed for lack of the signing passphrase) |
| `tests/build/build.test.mjs` (ignored by git) | kept, byte-identical |
| `git bundle verify` | "is okay" |

**Result: backup verified.**

- **Restore:** as in §5, using `screenshelf-20261126-081137.tar.gz`. It restores the staged index too.
- The earlier backups (`…183600`, `…225600`) are kept. All three together use 17 MB.
