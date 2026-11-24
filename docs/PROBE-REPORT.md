# Stage 1.5: Device Compatibility Probe Report

Device: Samsung UE50MU6100, Tizen 3.0, TV profile, firmware "latest" according to the TV menu. The exact version string couldn't be read: `productinfo` requires a partner privilege.
Date: 2026-11-22. Probe: ScreenShelf Device Probe 0.1.0 (`SSProbe001.Probe`).

**Where each result comes from:**
- **[TV]** means measured by the probe running on the physical TV.
- **[PC]** means measured on the development PC.
- **[PC→TV]** means remote keys were injected from the PC over the TV's network remote API, not pressed on the physical remote.

Raw results: `probe/results/latest*.json` (from the TV, unedited).

---

## 1. Diagnostic application source

| File | Purpose |
|---|---|
| `probe/app/config.xml` | Tizen 3.0, `tv-samsung` profile, privileges `internet` + `tv.inputdevice` only |
| `probe/app/index.html`, `probe.css` | Page shell; transparent body so the AVPlay video plane is visible |
| `probe/app/probe.js` | All tests, plain ES5 |
| `probe/app/subs.srt`, `img/*.jpg`, `icon.png` | Local test assets, generated locally (no third-party content) |
| `probe/tools/collector.mjs` | PC-side HTTP receiver on port 8099. Results come in; the only commands it sends back are `avplay`, `report` and `exit`. |
| `probe/tools/build-install.ps1` | Builds, signs, installs and launches the probe |
| `probe/tools/cdp.mjs` | Remote-inspector client. **Unused**: the TV refuses debug mode, see section 3 |

**Probe-only deviations, which will not go into the product:**
- `<access origin="*">`, so the probe can test many certificate chains.
- Plain HTTP to the dev PC on the LAN, for collecting results.
- `new Function` on **fixed strings** for syntax detection.

---

## 2. Build instructions

```powershell
# terminal 1: results receiver (Node already has a firewall allow rule)
node probe\tools\collector.mjs
# terminal 2: build, sign with the Tizen profile, install, launch
powershell -ExecutionPolicy Bypass -File probe\tools\build-install.ps1
# start the AVPlay tests (results arrive in probe\results\)
Set-Content probe\results\next-cmd.txt avplay -NoNewline
# stop the probe and remove it from the TV
Set-Content probe\results\next-cmd.txt exit -NoNewline
C:\Development\Tizen\sdk\tools\ide\bin\tizen.bat uninstall -s 192.168.1.19:26101 -p SSProbe001.Probe
```

---

## 3. Installation report

| Step | Result |
|---|---|
| Samsung certificate profile `samsung` (author + distributor, DUID `H3CFC64CUVNCA`, Public privilege), created by you | PASS: created and valid until 2027-11-22 |
| Install signed with the Samsung profile (SHA-512) | **FAIL [TV]**: `install failed[118]` |
| `device-profile.xml` push to `/home/developer` | FAIL: that path doesn't exist on the TV profile (not needed for TVs) |
| Install with the Samsung profile re-signed SHA-256 (patched copy of the signer, SDK untouched) | **FAIL [TV]**: 118 |
| Install with a **Tizen** developer certificate (`probe-tizen` profile, local, no account) | **PASS [TV]** |
| Launch (`tizen run`) | PASS [TV] |
| Remote inspector (`sdb shell 0 debug`) | **FAIL [TV]**: `closed` |
| Uninstall at the end | PASS [TV]: no longer in `vd_applist` |

**Diagnosis:**
- The TV rejects packages signed with Samsung's **current** developer CAs, "Samsung VD Author CA" and "VD DEVELOPER Public CA Class", both issued June 2025, whichever digest is used.
- It accepts the Tizen developer chain.
- The clock was set to Auto and the firmware was reported up to date by you.
- **Most likely cause: this 2017 firmware doesn't trust the 2025 Samsung intermediate CAs.** That's an inference, not confirmed by Samsung.

---

## 4. JavaScript compatibility [TV]

Engine user agent: `Mozilla/5.0 (SMART-TV; LINUX; Tizen 3.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/3.0 TV Safari/538.1`

| Feature | Result | Note |
|---|---|---|
| ES5 strict mode, getters/setters, `defineProperty`, `bind` | PASS | |
| JSON, `Date.now`, `performance.now` | PASS | |
| Promise (+ `all`, `race`, microtask ordering) | PASS | |
| `Promise.prototype.finally` | FAIL | |
| XMLHttpRequest (incl. `responseType='json'`, local file GET) | PASS | |
| `fetch` exists | PASS | |
| `fetch` of a packaged local file | **FAIL** | "Failed to fetch"; XHR works |
| `fetch` to a remote HTTPS URL | NOT TESTED | the HTTPS tests used XHR |
| AbortController | FAIL | |
| Map / Set / WeakMap / Symbol | PASS | |
| Array `find`/`findIndex`/`includes`/`from`/`of`/`fill` | PASS | |
| `Object.assign` | PASS | |
| `Object.values` / `entries` | FAIL | |
| String `startsWith`/`endsWith`/`includes`/`repeat` | PASS | |
| `String.prototype.padStart` | FAIL | |
| `URL` constructor | PASS | |
| URLSearchParams | FAIL | |
| `Intl.NumberFormat` | PASS | |
| `addEventListener`/`removeEventListener`, `CustomEvent`, `classList`, `dataset`, `closest`, `matches` | PASS | |
| MutationObserver | PASS | |
| IntersectionObserver, ResizeObserver | FAIL | |
| localStorage set/get/remove | PASS | |
| localStorage quota | PASS | ≥ 8 MB (test cap; limit not reached) |
| `requestAnimationFrame` | PASS | 125 ms for 2 frames during startup |
| `performance.memory` | PASS | |
| Syntax: arrow, class, template literal, spread, for…of, generators | PASS | supported natively |
| Syntax: `let`/`const` outside strict mode | FAIL | "not yet supported outside strict mode" |
| Syntax: destructuring, default params, async/await, `**`, `?.` | FAIL | |

---

## 5. CSS compatibility [TV]

| Feature | Result |
|---|---|
| Flexbox: `flex:1`, `justify-content`, `align-items`, wrap, column | PASS (pixel-exact) |
| Flexbox `gap` | **FAIL** |
| `display:grid` | **FAIL** |
| CSS custom properties `var()` | **FAIL** |
| `position:sticky` | **FAIL** |
| `position` absolute/relative/fixed | PASS |
| `transform` translate3d / scale (unprefixed) | PASS |
| Transitions + `transitionend` | PASS (200 ms transition ended at 256 ms) |
| `calc()`, vw/vh | PASS |
| `overflow:hidden`, `text-overflow:ellipsis`, `-webkit-line-clamp` | PASS |
| `object-fit:cover` | PASS |
| `border-radius`, `box-shadow`, rgba, `linear-gradient`, `filter:blur`, `will-change` | PASS |
| Image downscale 240x360 to 120x180 | PASS |
| Font family detection (`SamsungOne`) | **NOT TESTED**: every family, including monospace, serif and sans, rendered at identical width. The TV maps all generic families to one system font, so detection by width isn't possible. Font rendering wasn't visually inspected. |
| Viewport | PASS: `innerWidth`×`innerHeight` = **1920×1080**, `devicePixelRatio` = 1, `screen` 1920×1080 |

**Safe layout strategy for 1920×1080:**
- Author in fixed 1080p pixels. No scaling code is needed.
- Flexbox for layout, with margins for spacing (no `gap`).
- Absolute positioning plus `translate3d` for carousels.
- No grid, CSS variables or sticky positioning.

---

## 6. Remote-control compatibility

| Key | Code | Result | Source |
|---|---|---|---|
| Up / Down / Left / Right | 38 / 40 / 37 / 39 | PASS | [TV] physical |
| Enter | 13 | PASS | [TV] physical |
| Back | 10009 (`XF86Back`) | PASS. `preventDefault` keeps the app open. | [TV] physical |
| Red / Green / Blue | 403 / 404 / 406 | PASS | [TV] physical |
| Yellow | 405 | NOT TESTED | not pressed |
| MediaPause / Stop / Rewind / FastForward | 19 / 413 / 412 / 417 | PASS | [PC→TV] only. **Your Smart Remote has no media keys.** |
| MediaPlay | 415 | FAIL [PC→TV]: event not received | injected only |
| MediaPlayPause | 10252 | NOT TESTED | no physical key; no injection code |
| `registerKey` for 28 keys (media, colours, digits, channel, Info, Menu, Tools, Caption) | — | PASS: all registered | [TV] |
| `getSupportedKeys` | — | PASS: 46 keys reported | [TV] |
| **Key repeat (Right held 1.6 s)** | — | PASS. First repeat after **458 ms**, then every **108 ms**. **`event.repeat` is always `false`**; no keyup until release. | [TV] physical |

---

## 7. AVPlay compatibility [TV]

`webapis.avplay` version 1.0: PASS. Each stream was opened, prepared, played, paused, sought, jumped ±5 s, speed-changed, stopped and closed.

| Stream | Open/prepare | Play | Pause | Seek | Stop/close | Notes |
|---|---|---|---|---|---|---|
| MP4 H.264/AAC 854×480, Blender (Let's Encrypt) | PASS 0.9 s | PASS | PASS | PASS 132 ms | PASS | |
| MP4 H.264/AAC, W3C (GlobalSign) | PASS 0.6 s | PASS | PASS | PASS 142 ms | PASS | |
| HLS TS, Apple bipbop 16x9 | PASS 4.6 s | PASS | PASS | PASS 328 ms | stop FAIL, close PASS | `setSpeed` ±2: INVALID_OPERATION; `stop()` then threw |
| HLS TS advanced, Apple | PASS 5.4 s | PASS | PASS | PASS 704 ms | PASS | ABR moved up to about 8 Mbit/s |
| HLS **fMP4** advanced, Apple | PASS 4.1 s | PASS | PASS | PASS 283 ms | PASS | |
| HLS TS, Mux (Starfield) | PASS 0.6 s | PASS | PASS | PASS 280 ms | PASS | `setSpeed -2`: INVALID_OPERATION |
| MPEG-DASH H.264, Akamai | PASS 0.7 s | PASS | PASS | PASS 783 ms | PASS | **Switched to the 3840×2160 rendition** (14.9 Mbit/s) |
| MPEG-DASH with subtitles, DASH-IF | PASS 1.8 s | PASS | PASS | PASS 900 ms | PASS | **No TEXT track exposed**; duration reported 0 |
| Error case: missing manifest | — | — | — | — | PASS | **FAIL: no `onerror`, `prepareAsync` never returns.** It hit the probe's own 40 s timeout. |

| Capability | Result |
|---|---|
| Buffering events (start/progress/complete) | PASS: 9 ms to 3.3 s per stall |
| Audio track switch (bipbop, 2 tracks) | PASS. The other streams had 1 audio track, so NOT TESTED there. |
| Track metadata | Unreliable. HLS variant VIDEO entries contain garbage numbers. DASH audio reports `channels 0`. |
| In-stream subtitles, HLS WebVTT | PASS. Delivered through `onsubtitlechange` **with raw HTML tags** (`<i>`, `<b>`, `<u>`); an empty cue clears the text. |
| Subtitle sync | PASS. Cues arrived at 1008/3008/5008 ms and 13/1006/2006 ms, so within about 15 ms of their 1 s grid. |
| External SRT via `setExternalSubtitlePath` (packaged file path) | **FAIL**: `PLAYER_ERROR_INVALID_PARAMETER` |
| DASH subtitles | **FAIL**: no TEXT track |
| `setSpeed` (FF/REW) | Inconsistent. Accepted on MP4, DASH and Apple advanced HLS; rejected on others. Actual trick-play behaviour wasn't checked visually. |
| `jumpForward` / `jumpBackward` | PASS |
| Visual check that video and audio appear on screen | NOT TESTED by me. Position advanced as expected. You may have seen the video area. |

---

## 8. HTTPS compatibility [TV] (XMLHttpRequest)

| Chain / endpoint | Expected | Result |
|---|---|---|
| ISRG Root X1 (Let's Encrypt RSA) | connect | PASS (200) |
| ISRG Root X2 (Let's Encrypt ECDSA) | connect | PASS (200) |
| GlobalSign Root CA (Google, Cloudflare, W3C) | connect | PASS |
| DigiCert Global Root G2 | connect | PASS |
| DigiCert Global Root G3 (ECC; Apple and Akamai streams) | connect | PASS |
| Amazon Root CA 1 | connect | PASS |
| Starfield Root G2 (Mux) | connect | PASS |
| USERTrust RSA (Sectigo) | connect | PASS |
| Expired certificate | reject | PASS (rejected) |
| Self-signed | reject | PASS (rejected) |
| Untrusted root | reject | PASS (rejected) |
| Wrong host name | reject | PASS (rejected) |
| Plain HTTP control | connect | PASS |

- **The TV trusts all the current public certificate authorities tested and rejects invalid certificates. Risk R1 is retired.**
- AVPlay's own network stack also loaded content from Let's Encrypt, GlobalSign, DigiCert G3 and Starfield hosts.
- XHR doesn't expose the certificate error text. Failures show only as status 0.

---

## 9. Performance [TV]

| Metric | Value | Result |
|---|---|---|
| navigationStart to first script | 128 ms | PASS |
| First frame after first script | 136 ms | PASS |
| navigationStart to DOMContentLoaded | 249 ms | PASS |
| navigationStart to load | 1006 ms | PASS (includes `webapis.js`) |
| JS heap used / limit | 10 / 756 MB | PASS |
| **System memory available / total** | **220 / 1295 MB** | PASS, but tight |
| Local 240×360 poster load | 25 ms | PASS |
| Local 1920×1080 backdrop load | 14 ms | PASS |
| 20 parallel poster loads | 71 ms | PASS |
| Remote image loading | NOT TESTED | |
| Focus step + carousel translate (7 rows × 13 cards, 121 DOM nodes) | avg 24.2 ms (41 fps), p95 33 ms, max 48 ms | PASS (marginal for 60 fps) |
| App startup on the PC side (`tizen run` to launched) | 0.2 s | [PC] measured |

---

## 10. Architectural recommendations (changes to ARCHITECTURE.md)

1. **Signing:** use a **Tizen developer certificate** for development installs on this TV. The Samsung 2025 certificate is kept, but this TV rejects it. Store publishing would still need Samsung signing, and this model may not accept current Samsung signing at all. Flag this as release risk R14.
2. **No remote inspector** with the Tizen certificate. Add a **dev-only LAN log and result sink**, like the probe collector. It's stripped from release builds by a build flag.
3. **Keep the ES5 target.** The engine supports arrows, classes and template literals, but not destructuring, default parameters, async or sloppy-mode `let`. ES5 remains the simplest single rule. The `lib` guard must exclude `Promise.finally`, `Object.values`/`entries`, `padStart`, URLSearchParams, AbortController, IntersectionObserver and ResizeObserver. All are confirmed missing.
4. **Use one XHR-based HttpClient.** `fetch` fails for packaged files and there's no AbortController. XHR has `abort()` and `timeout`.
5. **CSS plan confirmed:** flexbox plus margins, transforms, fixed 1080p pixels, with no grid, `gap`, variables or sticky. `line-clamp`, `object-fit` and `filter` are available. **Drop the viewport scaling fallback**, since the viewport is exactly 1920×1080 at DPR 1.
6. **Remote:**
   - The Smart Remote has **no media keys**, so the player must work fully with Enter, arrows and Back.
   - Media keys stay as optional extras.
   - Repeats can't be detected with `event.repeat`. Detect them by timing (more than 1 keydown before keyup). The repeat rate is about 108 ms, so the planned 110 ms throttle passes roughly every repeat.
7. **Player changes:**
   - **Use an app-level prepare timeout** (for example 15 s), because a missing manifest never errors.
   - **Use simulated scrub.** `setSpeed` is unreliable.
   - Wrap `stop()` in try/catch and always `close()`.
   - Read subtitle text with **tag stripping**, or a whitelist for `<i>`/`<b>`/`<u>`.
   - **Use a JavaScript SRT/VTT sidecar renderer** for external subtitles. AVPlay refused the external path.
   - Prefer **HLS** for subtitled content. DASH exposed no text track.
   - Don't trust track `extra_info`; use provider metadata for labels.
8. **Memory:** only about 220 MB of system memory is free with the probe running. Keep DOM pooling, image caps and the single AVPlay instance as hard rules.
9. **Performance:** about 41 fps with 121 nodes. Keep the focus animation to `transform`/`opacity`, consider disabling the scale animation during held keys, and re-measure on the real UI in Stage 3.

### Retired and new risks
- **R1 (old TLS store): retired.**
- **R2 (engine assumptions): resolved**; see above.
- **R3 (AVPlay quirks): confirmed.** Mitigations above.
- **R14 (new): this TV rejects current Samsung certificates (error 118).** Development uses a Tizen certificate. A store release would need Samsung guidance.
- **R15 (new): no remote debugging.** A dev log sink is needed.

---

## 11. Environment state after the probe

- **Probe app:** uninstalled from the TV.
- **Certificates:** both kept.
  - The Samsung profile `samsung` is at `C:\Users\imran\SamsungCertificate\samsung`. It's kept for release investigation and is no longer the active profile.
  - The new Tizen profile `probe-tizen` has its key under `C:\Development\Tizen\sdk-data\keystore\probe-tizen`. Its password is generated randomly and stored only in the SDK's profile file, which encrypts it. **It is the active CLI profile since 2026-11-22** (approved for development builds).
- **Patched signer:** the SHA-256 copy at `C:\Development\Tizen\_patched\` was **deleted 2026-11-22** after verification:
  - It contained one jar, identical to the SDK original except the one patched class.
  - Its 4 certificate entries were the SDK's own emulator certificates, byte-identical to the copies still in the SDK.
  - Nothing referenced it.
  - The SDK itself is unchanged.
- **Collector:** stopped.
- **Stage 2:** not started.
