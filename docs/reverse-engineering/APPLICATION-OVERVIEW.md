# Ibo One IPTV Player: Application Overview

Stage 1 deliverable for the ScreenShelf IPTV clean-room project. Date: 2026-11-22.

## 1. Scope and method

The reference app was analysed **statically** with REA from a user-supplied XAPK, plus public material (Google Play listing, vendor website). Nothing was executed.

| Done | Not done |
|---|---|
| XAPK unpacked; base and split APKs inventoried | App not installed or run (no Android device attached: REA `list_adb_devices` = 0) |
| Manifest decoded, all 258 app string resources read (REA `decode_android_resources`, apktool 3.0.3) | No network traffic captured; backend base URL not recovered |
| Class inventory and selected class members (REA `inspect_android_package`, `search_android_classes`, `inspect_android_class`, JADX 0.7.1) | No method bodies decompiled or read; no proprietary code copied |
| Printable strings extracted from `classes.dex` (local Node script, 62,216 strings) | APK signatures not verified; XAPK provenance unknown |
| Native libraries listed | Native libraries not disassembled |

**Clean-room note.** This analysis records *what* the app does and *which* public protocols it uses. It deliberately does not reproduce method bodies, layouts, images, or the vendor's private backend protocol. ScreenShelf will not talk to the vendor's backend.

## 2. Classification and confidence

| Status | Meaning |
|---|---|
| CONFIRMED-STATIC | Present in the shipped artifact (manifest, resource string, class or member name, dex string). Proves the code or text exists, **not** that it runs or how it behaves. |
| CONFIRMED-PUBLIC | Visible in public material (listing, screenshots, vendor site). |
| INFERRED | Reasoned from the above. |
| ADVERTISED | Claimed in marketing only; no supporting artifact found. |
| UNDETERMINED | No evidence either way. |

Confidence: High, Medium or Low, for the statement as written.

## 3. Evidence register

| ID | Source | Content |
|---|---|---|
| A1 | `IboOne\com.iboone.app_2.1000184-r.xapk`, SHA-256 `46430218953b6e1ee92bd6a500e6184b4e47abb0229d6c16a382a4a4e099c6e8` | XAPK manifest: package `com.iboone.app`, name "IboOne Player", version 2.1000184-r (code 1000184), minSdk 24, targetSdk 36; splits: base, `config.arm64_v8a`, `config.en`, `config.xxhdpi` |
| A2 | Base APK, SHA-256 `eaca19a09cfd6962f9f8d9ed348d932964d0f2ece981ee883302eaf2ffa15f8c`; REA evidence `ev_0884b00b…` | 5,903 classes, 1,031 resources, one `classes.dex` (6.5 MB); permissions list |
| A3 | REA `decode_android_resources`, evidence `ev_3c0c0414…` | Decoded `AndroidManifest.xml` (all activities, services, receivers, providers, `<application>` attributes); 258 app string resources |
| A4 | `config.arm64_v8a.apk` file list | `libavcodec`, `libavutil`, `libswresample`, `libswscale`, `libffmpegJNI`, `libyuv`, `libconscrypt_jni`, `libdatastore_shared_counter` |
| A5 | REA `search_android_classes` (`ev_8585f2d7…`, `ev_c3161f38…`, `ev_fda2d3e2…`, `ev_4c61b0b2…`) | 44 `com.iboone.*`, 35 `com.logicyel.*`, 41 `com.ora.lib.*` classes; `androidx.media3.exoplayer.hls.HlsMediaSource$Factory` present |
| A6 | REA `inspect_android_class` (`ev_2b1013c8…` Server, `ev_d9ba72b4…` DeviceInfo, `ev_fcf56227…` Subtitle) | Field lists of the backend `Server`, `DeviceInfo` and `Subtitle` models |
| A7 | Printable strings of `classes.dex` | Xtream API paths, timeshift path, SQL statements, vendor backend routes, subtitle service URLs, Firebase endpoints, a hard-coded key-like string |
| E1 | Google Play listing (Chrome, 2026-11-22) | Title, developer Logicyel LLC, 50K+, in-app purchases, Phone/TV/Tablet, PEGI 3, updated 2026-09-18, description, Data safety: "No data collected", "No data shared", "Encrypted in transit", "Data can't be deleted" |
| E3 | Google Play marketing screenshots (7 legible) | Home, Live TV, Movies, Series, language selection |
| E4 | `iboonetv.com` home | Platforms claimed (Android TV, Firestick, Samsung, LG); pricing 5 EUR/yr, 8 EUR lifetime; TV home mockup (Device ID, Device PIN, trial, Continue Watching) |
| E5 | `euser.iboonetv.com/manage-device` | Web panel login: Device Id + Pin code, Cloudflare challenge. Nothing submitted. |
| E6 | `iboonetv.com/download` | Android TV/Firestick/LG "Coming Soon"; Samsung "Tizen OS models (2016+)" with no actual instructions |
| E9 | `iboonetv.com/privacy-policy/` | HTTP 500 on 2026-11-22 |
| E10 | ScreenShelf repo `C:\Users\imran\Documents\123movies` | Approved `docs/ARCHITECTURE.md` rev 2, `docs/PROBE-REPORT.md` (Tizen device probe), Stage 2 foundation source |

Short REA evidence IDs above are prefixes; the full IDs are in the REA session.

## 4. Application identity and build

| Finding | Status | Conf. | Evidence |
|---|---|---|---|
| Native Android app in Kotlin/Java (Kotlin stdlib, coroutines, RxJava, Gson, OkHttp, Room, Picasso, AndroidX), **not** Flutter/React Native/WebView | CONFIRMED-STATIC | High | A2, A5, A7 |
| Built on a shared white-label codebase: `com.ora.lib` (backend client, history, subscriptions), `com.logicyel.xtream` (Xtream client), `com.logicyel.mediaview` (player view); theme `Theme.OraStb`; strings "Welcome To ORA", "Experience the best of TV entertainment with ORA"; `WhiteLabelActivity`; route `/api/end-users/white-labels/background` | CONFIRMED-STATIC | High | A3, A5, A7 |
| Same vendor ships "partner" white-label apps (Ora Pro, Kemet TV, Gravity Player, Duplex Pro, ORA Players) | CONFIRMED-PUBLIC; link to `com.ora.lib` INFERRED | Medium | E4, A5 |
| Playback engine: AndroidX **Media3 (ExoPlayer)** with HLS module and the **FFmpeg decoder extension** (`libffmpegJNI` + libav*) | CONFIRMED-STATIC | High | A4, A5, A7 |
| Leanback launcher entry (Android TV) and phone launcher; all activities forced landscape | CONFIRMED-STATIC | High | A3 |
| Google Play licence check / anti-tamper (`com.pairip.*`) | CONFIRMED-STATIC | High | A3 |
| Firebase Analytics (collection enabled), Crashlytics, Remote Config, Installations; `AD_ID` permission | CONFIRMED-STATIC | High | A3, A7 |
| Google Play Billing 8.0.0; purchase verified server-side (`api/end-users/google/verify-purchase`) | CONFIRMED-STATIC | High | A3, A7 |
| Samsung Tizen version exists | ADVERTISED | Low | E4, E6 |

## 5. Summary

Ibo One is an **Xtream-Codes-centred** IPTV player built on the vendor's ORA white-label platform. On first run it registers the device with the vendor backend (sending model, serial, MAC, fingerprint, firmware, optional Google token) and shows a Device ID and PIN. Playlists ("servers": domain, username, password) are stored **on the vendor backend** and can be added in the app or on a web panel. Favourites, watch history and category order are also synced to that backend per server. The catalogue is downloaded from the Xtream server into a local SQLite database by a foreground service, then browsed in Live TV, Movies and Series screens. Playback uses Media3 ExoPlayer with FFmpeg decoders; the player has channel/VOD/season browsers, EPG, track selection, aspect ratio, playback speed, brightness/volume and catch-up (Xtream timeshift). Parental lock is a 4-digit-default "parent password" stored server-side. Subtitles can be searched online through a vendor proxy of a subscription-subtitle database. Monetisation is a trial plus annual or lifetime licence (Play Billing, QR payment links, resellers).

Important corrections to the marketing text, from the binary:
- **"M3U" support:** no client-side M3U playlist parser was found (no `tvg-*`, `group-title` or `#EXTINF` attribute handling outside Media3's HLS parser). The backend `Server` model has only domain/username/password. M3U support is either server-side conversion or absent. (INFERRED, Medium.)
- **"Universal Accurate Translation":** no machine-translation code or service was found. The subtitle feature is an online **subtitle search** (`subtitledevui.logicyel.com/api/subtitles/search`, `extract-vtt?gzUrl=`) whose model fields match a well-known community subtitle database schema. (INFERRED, Medium.)
- **"No data collected":** contradicted by Firebase Analytics with collection enabled and by device registration that uploads hardware identifiers and IPTV credentials. (CONFIRMED-STATIC that the code and config exist, High; actual transmission not observed.)

## 6. Document map

| File | Content |
|---|---|
| `SCREEN-INVENTORY.md` | Every activity and dialog, with evidence |
| `NAVIGATION-MAP.md` | Navigation of the reference app; proposed ScreenShelf navigation |
| `FEATURE-MATRIX.md` | Feature status in Ibo One, and ScreenShelf parity plan |
| `PLAYBACK-ANALYSIS.md` | Ibo One player vs. Tizen 3.0 AVPlay facts |
| `STORAGE-ANALYSIS.md` | Ibo One local/server storage; ScreenShelf storage plan |
| `NETWORK-ANALYSIS.md` | Xtream, vendor backend, subtitles, telemetry; ScreenShelf flows |
| `UX-ANALYSIS.md` | Layout, focus and remote patterns |
| `TECHNICAL-FINDINGS.md` | Findings, security observations, conflicts with ScreenShelf architecture, Tizen risks |
| `IMPLEMENTATION-RECOMMENDATIONS.md` | Clean-room architecture, stages, open questions |
