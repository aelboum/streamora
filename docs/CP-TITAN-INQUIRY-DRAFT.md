# Draft inquiry to Titan OS app onboarding

**Status: draft only. Not sent.** Sending is your decision and your action. Fill in the bracketed parts first.

- **To:** apponboarding@titanos.tv
- **Subject:** Technical questions before submitting a hosted HTML5 IPTV player app (HTTP providers, CORS, policy)

---

Hello Titan OS App Onboarding team,

We develop **ScreenShelf**, a TV application for watching IPTV services that the user already subscribes to. ScreenShelf ships no content, channels, playlists or accounts of its own. The user enters their own provider details, either an M3U/M3U8 playlist URL or an Xtream Codes API login (server, username, password). ScreenShelf then shows the provider's live channels, movies and series and plays them.

The app already runs on Samsung Tizen TVs as a packaged HTML5 application (ES5, no frameworks). We are evaluating Titan OS as a hosted HTML5 app, as described in your documentation (docs.titanos.tv: Introduction, Publishing, Media Specifications, Remote Control).

Our design constraints:
- The app would be served from **static HTTPS hosting** only, with no server-side code, database or user accounts.
- All user data (playlists, favourites, settings, viewing history) stays on the TV.
- Credentials are never sent to us.

Before we request DevView access and submit a test URL, we would be grateful for answers to four questions that your documentation does not cover.

**T1 — HTTPS app calling HTTP providers.** Many IPTV providers serve their API and their streams over plain HTTP only, for example `http://provider.example:8080/player_api.php?...` and `http://provider.example:8080/live/.../123.ts`. If our app is hosted over HTTPS, will the Titan OS browser engine allow:
- (a) XMLHttpRequest calls from the HTTPS app to `http://` API endpoints;
- (b) playback of `http://` media URLs in a `<video>` element (progressive MPEG-TS and HLS);
- (c) loading of `http://` images such as channel logos and posters?

If these are blocked as mixed content, is there a supported way to allow them for a specific app (for example a manifest setting, an allowlist or a device-side policy)? Does the behaviour differ between Chrome 84, Chrome 112 and Chromium 122 devices?

**T2 — HTTP app hosting.** May the app URL submitted in the Partner Portal be a plain `http://` URL, or must it be `https://`? If HTTP hosting is accepted, are there restrictions (for example on storage, DRM or certain APIs)?

**T3 — CORS.** Xtream Codes servers usually send no `Access-Control-Allow-Origin` headers. Do cross-origin XMLHttpRequest calls from a hosted Titan OS app follow standard browser CORS rules, so that a provider must send CORS headers? Or does the Titan OS app runtime relax CORS for apps (as packaged apps on some TV platforms do)? Does the same apply to media requests (including Range requests) and image requests?

**T4 — Content policy.** Does Titan OS accept playlist-based IPTV player applications in the app store, meaning applications that contain no content of their own and play only provider sources the user enters (M3U/Xtream)? If yes:
- are there conditions, for example disclaimers, no preloaded sources, or regional restrictions?
- what does the review need: a test provider account, or a test playlist we supply?

If it is easier to answer some of these on a call, or to test them in DevView, we are happy to do that. In that case, could you tell us how to request DevView access and whether a test device can be arranged, as your FAQ mentions?

Thank you for your help.

Kind regards,
[Your name]
[Company or developer name, if any]
[Contact email]
[Countries where the app would be offered]
