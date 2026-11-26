// Replaced at bundle time by esbuild `define` (scripts/build.mjs).
// In Node tests these are undefined; read them only through app/build-info.ts.
declare const __SS_BUILD_MODE__: 'dev' | 'release';
declare const __SS_VERSION__: string;
declare const __SS_DEV_SINK_URL__: string;
/** CP1: platform the bundle is built for; 'all' = every adapter with runtime detection (default). Bundle-only (detect.ts). */
declare const __SS_PLATFORM__: 'all' | 'tizen' | 'android' | 'browser';
