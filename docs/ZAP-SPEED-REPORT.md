# Live TV zap speed: report

Date: 2026-11-25. Your report: "changing channels is slow … it takes some time to load, improve".

Evidence: `docs/evidence/zap-speed/tv-zap-diagnostics.jsonl` (3,566 lines). It holds three diagnostic sessions on the TV, with a dev-only logger for key presses, stream opens, player events and memory. It contains no URLs or credentials (checked by search). Your zapping was done with the physical remote [TV-P]; the timings come from the log.

## 1. What a zap was made of (session 2: 40 full-screen zaps, before the change)

| Stage | Typical time | Cause |
|---|---|---|
| Key → channel opened | **0.52 s** | a deliberate 0.4 s wait after every CH±/▲▼, for fast zapping, plus ~0.12 s to resolve the stream address |
| Opened → first data | 0.25–0.45 s (once 2.8 s, once 6.6 s) | the provider's server |
| Data → 2 s buffer full | 0.02–0.05 s | fast, so the buffer size is not the bottleneck |
| Buffer full → player prepared | ~0.2 s | the TV's player |
| Prepared → first position report | **~0.5 s, every time** | AVPlay reports the playing position only every half second; the app waited for that report before hiding "Loading…" |

- No stall reopens, reconnects or failures occurred in sessions 2 and 3.
- Session 1 lost part of its log to a flood of buffering messages (fixed in the logger), and showed a few channels that stayed stuck buffering for 15–20 s.

## 2. Changes

1. **A single zap tunes at once.**
   - In the live player, a CH±/▲▼ press that comes at least 0.6 s after the previous one opens the channel immediately.
   - Quicker presses still wait 0.4 s after the last one, so AVPlay never gets a burst of opens (the Stage 7E finding).
   - The Live TV preview keeps its own fixed wait.
   - Files: `src/player/live-controller.ts` (`zapQuietMs`), `src/screens/live-screens.ts`, `src/app/bootstrap.ts` (600 ms).
2. **"Loading…" hides when the player is ready.**
   - The controller now marks a tune `ready` as soon as AVPlay is prepared and playback was started.
   - The live player hides its "Loading…" box then, instead of after the first position report (~0.5 s later).
   - Errors, buffering and reconnect messages are unchanged.
   - Files: `src/player/live-controller.ts` (`LiveState.ready`), `src/screens/player-screen.ts`.

Not changed:
- the 2 s buffer, chosen in Stage 5 because 1 s was unstable, which fills in under 0.05 s here;
- stall recovery, reconnects and timeouts;
- the provider's response time, which the app cannot change.

## 3. Result [TV, session 3: 51 zaps with CH±/▲▼]

| From the key press to… | Before (median) | After (median) | After (9 in 10) |
|---|---|---|---|
| the channel starts opening | 0.52 s | **0.14 s** | 0.41 s (the rapid presses) |
| the player is ready, "Loading…" gone | ~1.05 s | **0.64 s** | 0.94 s |
| the first position report | ~1.55 s | **1.13 s** | 1.90 s |

- No stalls, failures or errors; free memory 152–276 MB.
- **Your check:** "feel better and quicker".

## 4. Tests and build

- `tests/unit/zap-speed.test.mjs` (new, 3 tests):
  - a single press opens at once;
  - rapid presses open only the last one, 0.4 s after it;
  - the preview keeps its debounce;
  - `ready` is set when prepared and cleared on the next tune, never by a failed load.
- `npm run check`: **351/351 unit**, **5/5 build**, ES5 0 findings.
- `npm run build:all`: `release-check: OK`; APK rebuilt.
- Release build reinstalled and launched on the TV; `src/dev/device-selftest.ts` restored (SHA-1 `07584df…`).
- The dev-only logger `src/dev/device-selftest-zapdiag.ts` stays in the tree, unreferenced.

## 5. Remaining

- **Some channels start slowly or stay stuck buffering** because of the provider's stream (seen at 2.8–6.6 s, and 15–20 s in session 1). The app's existing stall reopen and the 15 s limit still apply.
- **Opening a channel from the Live TV list (OK) reopens the stream** although the preview is already playing it, about 1 s. Reusing the preview stream would save that, but it changes the hand-over between preview and full screen, so it is not done here. It needs your go-ahead.
