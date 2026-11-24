// Generates synthetic test media for device probe 2 (colour bars + sine tone, made locally by
// ffmpeg's lavfi sources, so there is no third-party content). Output: probe2/media/ (git-ignored).
// Usage: node probe2/server/make-media.mjs [--force]
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'media');

const SRC = ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'];
const H264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '50', '-b:v', '2500k'];
const HEVC_TS = ['-c:v', 'libx265', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '50', '-b:v', '2000k', '-x265-params', 'log-level=error'];
const HEVC_MP4 = [...HEVC_TS, '-tag:v', 'hvc1'];
const AAC = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'];

export const FILES = [
  { file: 'h264_aac.mp4', args: [...H264, ...AAC, '-movflags', '+faststart'] },
  { file: 'h264_aac.ts', args: [...H264, ...AAC, '-f', 'mpegts'] },
  { file: 'h264_mp2.ts', args: [...H264, '-c:a', 'mp2', '-b:a', '192k', '-f', 'mpegts'] },
  { file: 'h264_ac3.mp4', args: [...H264, '-c:a', 'ac3', '-b:a', '192k', '-movflags', '+faststart'] },
  { file: 'h264_eac3.mp4', args: [...H264, '-c:a', 'eac3', '-b:a', '192k', '-movflags', '+faststart'] },
  { file: 'h264_ac3.ts', args: [...H264, '-c:a', 'ac3', '-b:a', '192k', '-f', 'mpegts'] },
  { file: 'h264_aac.mkv', args: [...H264, ...AAC] },
  { file: 'hevc_aac.mp4', args: [...HEVC_MP4, ...AAC, '-movflags', '+faststart'] },
  { file: 'hevc_aac.ts', args: [...HEVC_TS, ...AAC, '-f', 'mpegts'] },
  { file: 'hevc_aac.mkv', args: [...HEVC_TS, ...AAC] },
  { file: 'hls/index.m3u8', args: [...H264, ...AAC, '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(out, 'hls', 'seg%03d.ts')] }
];

// Live encoder settings shared with media-server.mjs (continuous MPEG-TS on stdout).
export const LIVE = {
  'h264_aac': [...H264, ...AAC],
  'h264_mp2': [...H264, '-c:a', 'mp2', '-b:a', '192k'],
  'h264_ac3': [...H264, '-c:a', 'ac3', '-b:a', '192k'],
  'hevc_aac': [...HEVC_TS, ...AAC]
};
export const LIVE_SRC = ['-re', ...SRC];

function main() {
  mkdirSync(join(out, 'hls'), { recursive: true });
  const force = process.argv.includes('--force');
  for (const f of FILES) {
    const target = join(out, f.file);
    if (existsSync(target) && !force) { console.log('exists', f.file); continue; }
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...SRC, '-t', '60', ...f.args, target], { stdio: 'inherit' });
    console.log(r.status === 0 ? 'made  ' : 'FAILED', f.file);
    if (r.status !== 0) { process.exitCode = 1; }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) { main(); }
