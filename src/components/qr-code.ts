// QR code as an SVG data URI (AI-02 phone pairing; also used by the dev QR UI experiment).
// Encoder: qrcode-generator 1.4.4 (Kazuhiko Arase, MIT; plain ES5). The SVG is drawn from the
// module matrix as one path and shown through <img> (Tizen 3.0 renders SVG data URIs; the brand
// mark used that before). Error correction M; a 4-module quiet zone as the QR standard requires.
// @ts-ignore -- CommonJS module (`export =`); esbuild and Node provide it as the default import.
import qrcodeLib from 'qrcode-generator';

interface QrLike { addData(d: string): void; make(): void; getModuleCount(): number; isDark(r: number, c: number): boolean }
type QrFactory = (typeNumber: number, level: string) => QrLike;

export interface QrMatrix { size: number; dark(row: number, col: number): boolean }

/**
 * Encodes text (byte mode, smallest version that fits). Level M by default; the pairing screen
 * uses L (a code on a screen is not damaged, and fewer modules scan more easily from a distance).
 */
export function qrMatrix(text: string, level?: 'L' | 'M'): QrMatrix {
  const qr = (qrcodeLib as unknown as QrFactory)(0, level || 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return { size: n, dark: function (r: number, c: number) { return qr.isDark(r, c); } };
}

/** SVG markup: black modules on white, quiet zone of 4 modules, crisp edges. */
export function qrSvg(m: QrMatrix): string {
  const q = 4;
  const full = m.size + 2 * q;
  let d = '';
  for (let r = 0; r < m.size; r++) {
    let c = 0;
    while (c < m.size) {
      if (!m.dark(r, c)) { c++; continue; }
      const start = c;
      while (c < m.size && m.dark(r, c)) { c++; }
      d += 'M' + (start + q) + ' ' + (r + q) + 'h' + (c - start) + 'v1h-' + (c - start) + 'z';
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + full + ' ' + full + '" shape-rendering="crispEdges">' +
    '<rect width="' + full + '" height="' + full + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}

export function qrDataUri(text: string, level?: 'L' | 'M'): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qrSvg(qrMatrix(text, level)));
}

/**
 * QR image sized to a whole number of pixels per module (at most maxPx wide, quiet zone included).
 * A fractional scale makes the TV round module edges unevenly, which can leave thin light lines
 * between rows that phone scanners stumble on.
 */
export function qrImage(text: string, maxPx: number, level?: 'L' | 'M'): { uri: string; px: number } {
  const m = qrMatrix(text, level);
  const full = m.size + 8;
  const scale = Math.max(1, Math.floor(maxPx / full));
  return { uri: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qrSvg(m)), px: full * scale };
}
