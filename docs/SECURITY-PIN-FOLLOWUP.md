# Parental PIN: Security Follow-up (Stage 4 evaluation)

Status: written in Stage 4 as evaluation only. **P1–P4 were approved and implemented in Stage 4B (2026-11-23)**; see SECURITY-DECISIONS.md S2 for the implemented design and TEST-REPORT.md §9 for the TV measurements (600,000 iterations: verify 0.80 s, set 1.7 s). The text below is the original evaluation, kept for reference.

Tags: **[TV]** measured on the UE50MU6100; **[W]** Windows; **[A]** assumption or estimate.

## Current design (Stage 3)

| Item | Value |
|---|---|
| Algorithm | PBKDF2-HMAC-SHA256 via `crypto.subtle`, 16-byte random salt, 32-byte output |
| Iterations | 100,000 (configurable upwards, floor 100,000) |
| PIN length | 4–8 digits |
| Verifier storage | KV `parental.pin` in localStorage (app-private) |
| Attempt limit | 5 failures, then 60 s lockout, counter persisted |
| Change | needs the current PIN |
| Reset | typed phrase `RESET PARENTAL CONTROLS`, no PIN needed; wipes parental settings |

Measured cost of 100,000 iterations on the TV: 157 ms (Stage 3), 170 ms and 146 ms (Stage 4 self-test runs) [TV].

## F1. 600,000 iterations

| Point | Finding |
|---|---|
| Cost on the TV | PBKDF2 cost is linear in the iteration count. From 146–170 ms per 100,000 [TV], 600,000 ≈ **0.9–1.0 s** per PIN check [A, extrapolated; to be measured]. Acceptable for an unlock prompt with a spinner; noticeable if the PIN is asked for on every adult channel zap. |
| Benefit | Raises the cost of each offline guess 6×. It matches the current OWASP Password Storage Cheat Sheet figure for PBKDF2-HMAC-SHA256. |
| Limit | With a 4-digit PIN (10,000 values) the whole space is still small: 6× more work per guess doesn't change the conclusion that offline brute force succeeds. The iteration count is only meaningful together with F2. |
| Recommendation | Raise the default to 600,000. Measure on the TV first (one self-test step). Keep the 100,000 floor for records written before the change, and re-hash at the next successful verification (the record already stores `it`, so no format change is needed). |

## F2. Minimum six digits

| Point | Finding |
|---|---|
| Search space | 6 digits = 1,000,000 values (100× a 4-digit PIN). With 600,000 iterations an offline attacker needs 6×10¹¹ PBKDF2 iterations for the full space, against 10⁹ today [A, arithmetic]. |
| Online guessing | Unaffected: the 5-attempt lockout already limits guessing on the TV itself. |
| Usability | Six digits on a TV remote is acceptable (digit keys, or the on-screen PIN pad). |
| Migration | Existing 4–5 digit PINs keep working. On the next successful entry the user is asked to choose a 6-digit PIN; this can be skipped once. |
| Recommendation | Minimum 6 digits for new or changed PINs. Together with F1 this is the main improvement against offline attack. It still only protects against casual access, not against a determined attacker with storage access (see F4). |

## F3. Authenticated change and reset, or a secure recovery

Today the reset phrase bypasses the PIN completely. Anyone who can read the reset instructions can remove the controls.

| Option | Description | Trade-off |
|---|---|---|
| R1 Recovery code | When a PIN is set, show a one-time 10–12 character recovery code (from `crypto.getRandomValues`). Store only its PBKDF2 verifier. Reset needs the PIN **or** the code. | Secure and offline. The user must keep the code somewhere. |
| R2 Reset wipes the content | "Forgot PIN" is allowed without a code, but it also deletes every playlist and its credentials (a factory reset). | No secret to keep. A child gains nothing, because the content is gone. Loses the user's setup. |
| R3 Status quo | The phrase alone. | Protects against small children only. |

Recommendation: **R1 with R2 as the fallback.** A PIN can be reset with the current PIN or the recovery code. Without either, the only way out is the content-wiping reset. PIN change keeps requiring the current PIN (already the case). Every reset or change goes through the same attempt counter and lockout.

## F4. Protecting the verifier with the Tizen Key Manager

| Point | Finding |
|---|---|
| Today | The verifier sits in localStorage, which is private to the application but readable by anyone with file-system access to the device (developer mode, or a rooted TV). |
| Key manager | `tizen.keymanager.saveData/getData/removeData` work on this TV [TV]: save, overwrite and remove were exercised in Stage 3 and again in Stage 4. Credentials are already stored there. |
| What it adds | The verifier would no longer be in a plain file. Whether the key manager encrypts data at rest, and with which key, was **not inspected** [A] (SECURITY-DECISIONS S1). |
| Key-manager passwords | `saveData` accepts an optional per-item password. Using the PIN as that password would make the key manager do the check. This is **unverified** on the TV: behaviour, lockout and timing are unknown [A]. It would also put the PIN, not a hash, into a platform API. Not recommended without a probe. |
| Atomicity risk | The key manager can't overwrite an alias, so an update is remove-then-save (SECURITY-DECISIONS S1). For credentials a crash only loses the secret. **For the PIN, a crash between remove and save would leave no PIN, which disables the parental controls.** Any move to the key manager must write a new versioned alias first and delete the old one afterwards, and treat "no verifier but parental settings present" as locked. |
| Recommendation | Move the verifier record (unchanged format) to the key manager under a versioned alias (`ss_pin_v<n>`), with the write-new-then-delete-old protocol above. Keep the PBKDF2 hash. Do not use key-manager item passwords until a probe shows their behaviour. Add a self-test step for the versioned rotation. |

## Summary of recommended changes (for approval)

| # | Change | Effort | Depends on |
|---|---|---|---|
| P1 | Default 600,000 iterations; transparent re-hash on next successful verification | small | TV timing check |
| P2 | Minimum 6 digits for new or changed PINs; prompt to upgrade shorter PINs | small | Stage 8 PIN screens |
| P3 | Recovery code at PIN set-up; reset with the PIN or the code; content-wiping reset as the last resort | medium | Stage 8 screens |
| P4 | Verifier stored in the key manager under versioned aliases (write new, then delete old); missing verifier with parental settings present = locked | medium | Self-test of the rotation on the TV |

Even with P1–P4 a numeric PIN protects against casual use on the device, not against an attacker who can extract the app's storage. This limitation stays documented.

## Stage 5: recorded follow-up items (not implemented; approved PIN design unchanged)

Recorded as requested in the Stage 5 brief, Part I. Each needs a decision before implementation.

| # | Item | Current state | Options |
|---|---|---|---|
| F5 | **Failed-attempt counter vs. a storage reset.** The counter and lockout (`parental.attempts`) live in localStorage. Someone who can clear the app's localStorage gets fresh attempts. | The PIN record itself is in the key manager (P4). Clearing localStorage does not remove the PIN. | (a) Keep the counter in the PIN key-manager record (`gen` rotation on every failure: 2 key-manager writes per wrong guess, ≈ 0.2 s on the TV [M: overwrite 0.11–0.16 s]). (b) A separate key-manager alias for the counter. (c) Make a missing counter count as "locked for one lockout period" when a PIN exists. (c) is cheapest and closes the reset bypass; (a) is the most robust. |
| F6 | **Offline guessing of the PIN.** 10⁶ six-digit PINs × 600,000 PBKDF2 iterations is feasible offline for someone who can extract the key-manager data. | P1/P2 raise the cost about 6,000× compared with Stage 3 (100,000 iterations, 4 digits). | (a) A device-bound pepper: a random 32-byte key stored in the key manager under its own alias, mixed in with HMAC before PBKDF2. An attacker then needs both aliases; it doesn't help if the whole key manager is extracted. (b) Allow optional longer PINs or an alphanumeric passphrase. (c) Keep the documented limitation: the PIN deters casual use on the device. |
| F7 | **Keep the recovery mechanism secure.** | 60-bit code from `getRandomValues`, shown once, stored only as a PBKDF2 verifier (600,000 iterations) in the key-manager record; guesses share the lockout; regenerating needs the PIN; a used code is gone with the reset. | Keep as is. Rules for the Stage 8 screens: show the code once with a clear "write this down" step, never show it again, never log it, and offer regeneration (with the PIN) instead of "show code again". If F5 (a) or (b) is adopted, include recovery-code failures in the same protected counter. |
