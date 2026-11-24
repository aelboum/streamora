# ScreenShelf Test Report

Labels: **[PC]** verified on the development PC · **[TV]** physically verified on the Samsung UE50MU6100 · **[NOT TESTED]**.

## Stage 2: Foundation (2026-11-22, version 0.2.0)

### PC verification

| Check | Command | Result |
|---|---|---|
| Type-check (ES5 target, narrow lib) | `npm run typecheck` | [PC] PASS, 0 errors |
| Source compatibility rules | `npm run compat` | [PC] PASS, 20 files, 0 findings |
| Unit tests | `npm test` | [PC] **119 / 119 pass**, 0 fail, 0 skipped |
| Build tests (real tsc + esbuild, both modes) | `npm run test:build` | [PC] **9 / 9 pass** |
| Full gate | `npm run check` | [PC] exit 0 |
| Dev build | `npm run build:dev` (with `SS_DEV_SINK_URL`) | [PC] PASS: `app.js` 13 764 B, ES5 gate clean |
| Release build | `npm run build:release` | [PC] PASS: `app.js` 5 379 B minified, ES5 gate clean |
| Release exclusion | `npm run check:release` | [PC] PASS: no sink marker or strings, no LAN IP, no `<access>`, CSP present, 2 privileges |
| Dev bundle trips the release check | `tests/build` | [PC] PASS: proves the check can fail |

**Unit test breakdown [PC]:**

| Test file | Tests |
|---|---|
| `http-client.test.mjs` | 28 / 28 pass |
| `compat-rules.test.mjs` | 40 / 40 pass |
| `es5-bundle-check.test.mjs` | 27 / 27 pass |
| `log-and-redact.test.mjs` | 7 / 7 pass |
| `dev-log-sink.test.mjs` | 5 / 5 pass |
| `platform.test.mjs` | 5 / 5 pass |
| `config-and-css.test.mjs` | 7 / 7 pass |
| **Total** | **119 / 119 pass** (each file run separately with `node --test <file>`) |

### Package [PC]

| Build | File | Size | Signed with | SHA-256 (prefix) |
|---|---|---|---|---|
| release | `build/pkg/release/ScreenShelf.wgt` | 9 452 B | `probe-tizen` (author + Tizen public distributor) | `096B6C8D3A05C90C` |
| dev | `build/pkg/dev/ScreenShelf.wgt` | 11 364 B | `probe-tizen` | `C4A487910E13D48C` |

Package contents (release): `app.css, app.js, author-signature.xml, config.xml, icon.png, index.html, signature1.xml`.
App ID `SShelfDev1.ScreenShelf` (temporary development identifier).

### TV verification

| Check | Result | Evidence |
|---|---|---|
| Install dev build via SDB | [TV] PASS | `Installed the package: Id(SShelfDev1.ScreenShelf)` |
| Launch dev build | [TV] PASS | `Tizen application is successfully launched.` |
| Dev shell starts and reports over the LAN sink | [TV] PASS | Sink received `dev log sink enabled`, `platform`, and `shell ready` (ms: 335); platform `tizen 3.0`, viewport 1920×1080 |
| CSP plus a single `<access>` origin allows the sink | [TV] PASS | Log entries arrived from the TV |
| Install release build (replaces dev) | [TV] PASS | `Tizen application is successfully installed.` |
| Launch release build | [TV] PASS | `Tizen application is successfully launched.` |
| Release build sends nothing to the sink | [TV] PASS | No new sink entries after the release launch (log stayed at 3 TV entries) |
| Shell appears correctly (release) | [TV] PASS, **visual check by the user** | User confirmed: dark background, "ScreenShelf" title, "Foundation build", panel with a blue edge, green "Ready", detail rows |
| Back key exits the app (release) | [TV] PASS, **user pressed Back on the physical remote** | User confirmed the app closed |
| `webapis.avplay` present without loading `webapis.js` | [TV] observed | Dev log `capabilities.avplay: true` |
| Font legibility at viewing distance | [NOT TESTED] | Only an overall "looks right" was confirmed |
| HttpClient against a real HTTPS endpoint on the TV | [NOT TESTED] | No API exists in Stage 2 |
| Startup error display on the TV | [NOT TESTED] on the TV | The error path is exercised only by code review; there's no fault-injection build |

The build installed on the TV was produced before a comment-only edit to `src/app/platform/platform.ts`. Comments are stripped by `tsc` (`removeComments`), and the rebuilt release bundle is the same 5 379 B.

## Stage 1.5: Device probe

See `docs/PROBE-REPORT.md`.
