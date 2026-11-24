// Build-time constants, injected by esbuild `define`. Under Node tests they are absent.

export interface BuildInfo {
  mode: 'dev' | 'release' | 'test';
  version: string;
  devSinkUrl: string;
}

export function buildInfo(): BuildInfo {
  return {
    mode: typeof __SS_BUILD_MODE__ !== 'undefined' ? __SS_BUILD_MODE__ : 'test',
    version: typeof __SS_VERSION__ !== 'undefined' ? __SS_VERSION__ : '0.0.0-test',
    devSinkUrl: typeof __SS_DEV_SINK_URL__ !== 'undefined' ? __SS_DEV_SINK_URL__ : ''
  };
}
