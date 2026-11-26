# CP2 — Android application identity and signing: proposal

Date: 2026-11-26. **Proposal only.** Nothing has been changed: the application ID, label, signing configuration, Keystore alias and version are as in the repository, and no key has been created.

## 0. Why this must be decided first

On Android, an installed app is identified by two things together:
1. **its application ID** (the package name, e.g. `com.elitestream.app`);
2. **the certificate it is signed with.**

**What follows from that:**
- **An update is accepted only if both match** the installed app.
- **A different application ID is a different app.** Android installs it next to the old one, with its own empty data. It does not take over the old app's playlists, settings, files or logins.
- **A different signing certificate with the same ID is refused** (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). The only way past that is to **uninstall** the old app.
- **Uninstalling deletes the app's private data:** playlists (localStorage), catalogue files, backup, diagnostics log and the Keystore-encrypted logins. DI-1 can't protect against an uninstall, because the whole sandbox is removed.
- **Key rotation (APK Signature Scheme v3) needs Android 9+ (API 28).** It doesn't help on older devices such as the Philips test TV (API 25). For our device range, the first signing key is effectively permanent.

**Therefore:** the application ID and the signing key should be fixed **before the first installation that keeps real user data**. Today there is no such installation:
- the Philips test TV has no EliteStream or ScreenShelf app;
- no other Android installation is known to me. Please tell me if you have sideloaded the APK on any other device you use.

So changing the identity now costs nothing. Later it costs every user their data.

## 1. Permanent application ID

**Current:** `com.elitestream.app`. This is also the Gradle `namespace`, the Java package and the `R` class.

**Recommendation: change it now, before the first real installation, to a ScreenShelf ID that you will keep forever.** Reasons:
- The product name is ScreenShelf everywhere (R0 decision 7).
- An ID containing "elitestream" would be permanent and visible: in settings, in ADB, and in the app store if you ever publish.
- It can't be changed later without data loss (§0).

**Rules for the ID:**
- It is a reverse-domain name, lowercase, made of dot-separated segments that each start with a letter. Letters, digits and underscores are allowed; hyphens are not.
- Preferably, use a domain **you control**, so the ID can't clash with someone else's app.
- Google Play requires the ID to be unique across the store, and it can never be reused.

**Candidates** (examples only; I don't know which domains you own):

| Candidate | When suitable |
|---|---|
| `com.<yourdomain>.screenshelf` | You own `<yourdomain>.com` |
| `nl.<yourdomain>.screenshelf` | You own a `.nl` domain |
| `app.screenshelf.tv` | Only if you control the domain `screenshelf.app` (or equivalent) |

**Decision for you:** the exact ID.

**What changes when implemented** (later, with approval):
- `applicationId` in `android/app/build.gradle`.
- The **`namespace` and the Java package can stay** `com.elitestream.app`. Gradle allows `namespace` to differ from `applicationId`, and the namespace is internal: users never see it. Renaming it is optional cosmetics and not required for the identity.

## 2. Application label

**Proposal:** `android:label="ScreenShelf"`, replacing "EliteStream". It is shown in the launcher, the app list and settings.

**Other places, checked read-only today:**
- The banner `res/drawable/banner.xml` and the icon `res/drawable/ic_mark.xml` are vector graphics **without visible text**. `ic_mark.xml` has "EliteStream" only in a code comment.
- The theme name `EliteTheme` is internal and invisible; renaming it is optional.

The JS bridge names (`ElitePlatform`, `ElitePlayer`, `window.__eliteKey`, `window.__eliteVisible`) are **internal and invisible**. Renaming them is optional and would touch shared code (`android-platform.ts`, `android-engine.ts`, the Java bridges), so it is not proposed as part of the identity change.

## 3. APK file names

`scripts/android.mjs` currently writes `dist/android/EliteStream-<version>-debug.apk`.

**Proposal:**

| Build | File name |
|---|---|
| Test (debug-signed) | `ScreenShelf-<version>-debug.apk`, e.g. `ScreenShelf-0.3.0-debug.apk` |
| Release (production key) | `ScreenShelf-<version>-release.apk`, e.g. `ScreenShelf-0.3.0-release.apk` |

A release build needs a new `assembleRelease` path with the release `signingConfig` (§4). For a store release later, an AAB is also needed.

## 4. Signing strategy

**Principles:**
1. **One dedicated ScreenShelf production signing key**, used for every production APK, forever. Not the SaaS-OS key, and not a key shared with any other project.
2. **The debug key is for disposable test installs only.** The debug key lives in `~/.android/debug.keystore` on this PC; it changes if the PC is reinstalled, and it is never acceptable for installations that keep real data.
3. **The key and its passwords are never stored in the repository.**

**Proposed key** (to be created only after your approval):

| Item | Proposal |
|---|---|
| Type | Java keystore (PKCS12) with an RSA 4096 key. RSA is supported by every Android version from 5.0 up; EC is also possible on API 18+ |
| Validity | At least 30 years (Google Play requires validity beyond 22 October 2033; longer is safer) |
| Location | Outside the repository, e.g. `C:\Users\imran\Keys\screenshelf\screenshelf-release.p12` |
| Passwords | A strong store and key password, kept in a password manager |
| Gradle | Reads the keystore path and passwords from `~/.gradle/gradle.properties` or environment variables. Never from files in the repo; `.gitignore` already excludes `local.properties` |
| Signature schemes | v1 (JAR) and v2. v1 is required for Android 5.0–6.0 (minSdk 21 < 24). The Android Gradle plugin enables both by default when minSdk < 24 |

**Backup and recovery** (losing the key means you can never update the app again; installed users would have to uninstall and lose their data):
1. **Two encrypted copies offline:** for example an encrypted USB stick, and the encrypted cloud or password-manager attachment you already trust. They should be in different physical places.
2. **Record the certificate fingerprints** (SHA-256 and SHA-1) in `docs/` once the key exists. Fingerprints are public and make it possible to check a build was signed with the right key.
3. **A yearly check:** the backups open, the fingerprint matches, and a test signing with the backup works.
4. **Never email the key or put it in chat.** Never commit it.

**Store distribution (later, optional):** Google Play App Signing would make your key an *upload key* and Google would hold the *app-signing key*. That is a separate decision for publication (roadmap D12). It doesn't change the need for a safe first key.

## 5. Keystore alias `elitestream_secrets_v1`

**What it is.** The name of the AES-256 key that `PlatformBridge` creates inside the **Android Keystore** to encrypt logins. The encrypted values live in `SharedPreferences "secrets"`.

**Effect of changing it:**
- **Within the same installed app,** renaming the alias in code would make all saved logins unreadable. The old ciphertext can only be decrypted with the old key; `keyLoad` would return null and users would have to re-enter every password. Migration code would be needed: try the new alias, fall back to the old one, decrypt, re-encrypt with the new key, then delete the old entry.
- **With a new application ID,** none of this matters. The Android Keystore is **per app**, so a new app ID starts with an empty Keystore and empty preferences, whatever the alias is.

**Recommendation:**
- **If the application ID changes now (before any real installation):** rename the alias in the same change to `screenshelf_secrets_v1`. No migration is needed, because no data encrypted with the old alias will exist under the new ID.
- **If the application ID stays `com.elitestream.app`:** keep the alias `elitestream_secrets_v1`. It is internal and invisible, and renaming it only adds migration risk.
- **For any future alias change** (for example `_v2` for a stronger scheme), use the read-old/write-new migration above, with tests, and never delete the old key before the new value is stored.

## 6. Versioning

**History** (to keep): `versionCode 1` / `0.2.0` → `versionCode 2` / `0.3.0` (commit `4b9c677`).

**Rules:**
- `versionCode` must **always increase**: Android refuses to install a lower code over a higher one.
- `versionName` is free text for people.

**Proposal:**
- Keep `versionName` equal to the shared app version (`package.json`, and therefore Samsung `config.xml` and About).
- For `versionCode`, use a **derived formula** so it never needs thought: `versionCode = MAJOR × 10000 + MINOR × 100 + PATCH`. For example 0.3.1 → 301 and 0.4.0 → 400.
  - The next code is then larger than today's 2, so upgrades keep working.
  - It allows 99 patches per minor version.
  - If two Android-only rebuilds of the same version are ever needed, add a separate counter: `… × 10 + n`, decided then.
- **With a new application ID, its history starts fresh** (no installs exist), but still use the formula from the first build.

## 7. Migration and consequences (summary)

| Change | Consequence for an existing installation |
|---|---|
| New application ID | A **separate app**: the old one stays with its data; the new one starts empty. Users would re-add playlists. There is no automatic migration |
| New signing key, same ID | **The update is refused.** Installing requires uninstalling, and **uninstalling deletes all app data** |
| New Keystore alias, same app | Logins unreadable unless migration code is added (§5) |
| Higher `versionCode`, same ID and key | A normal update; data kept |
| Uninstall (any reason) | **All local data deleted:** playlists, catalogue, backup, logins, settings |

**Because no real Android installation exists yet, the recommended order is:**
1. Approve the application ID, label, alias and key strategy (this document).
2. Implement the identity change (ID, label, alias, APK names, release `signingConfig` reading the key from outside the repo).
3. Create the production key, with the backup procedure, after your separate approval.
4. Only then make installations that keep data.

The **first CP2 test installation on the Philips** can still be a **disposable debug-signed install** to collect the baseline (`CP2-PHYSICAL-TEST-PLAN.md`), provided you accept that its data will be deleted when it is replaced by the release-signed app.

## Decisions for you
1. **The permanent application ID** (§1).
2. **The label:** "ScreenShelf" (§2). Also whether to rename the internal theme and bridge names (optional; not recommended now).
3. **The signing strategy and key location;** approval to create the key later (§4).
4. **The alias:** rename to `screenshelf_secrets_v1` together with the new application ID, or keep it (§5).
5. **The `versionCode` formula** (§6).
6. **Whether any Android device you actually use already has EliteStream installed.** If so, the migration consequences in §7 apply to it.
