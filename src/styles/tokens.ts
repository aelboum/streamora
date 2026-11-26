// Design tokens (Stage 7B.1: EliteStream "Glass Hub" design system, Claude Design project
// "EliteStream Design System" + Handover §3). CSS custom properties are unsupported on the TV, so
// scripts/build.mjs substitutes {{token}} placeholders in src/styles/*.css with these values.
// All sizes are 1920×1080 logical pixels.

export const tokens: Record<string, string> = {
  // Colour
  'color.bg': '#080C18',            // bg/0: app base
  'color.bg1': '#0E1426',           // bg/1: rail, header band
  'color.surface': '#141B2E',       // surface/modal: dialogs, sheets, toasts (opaque)
  'color.glass': 'rgba(255, 255, 255, 0.06)',   // surface/1: panels, lists, blank card
  'color.glass2': 'rgba(255, 255, 255, 0.10)',  // surface/2: secondary buttons, chips
  'color.border': 'rgba(255, 255, 255, 0.12)',  // border/subtle
  'color.tile': '#121A2E',          // Home tiles
  'color.plate': '#1B2338',         // title plate (poster fallback)
  'color.accent': '#1F6FE0',        // primary buttons; focused rows at 35 %
  'color.accentFill': 'rgba(31, 111, 224, 0.35)',
  'color.focus': '#4FA8FF',         // focus ring, progress, selected marks
  'color.tint': 'rgba(79, 168, 255, 0.16)',     // selected (not focused)
  'color.text': '#EEF2F8',
  'color.textMuted': '#A9B2C3',     // text/secondary
  'color.textTertiary': '#8A93A6',
  'color.textBody': '#C3CAD7',
  'color.textDisabled': '#5A6378',
  'color.live': '#E5484D',
  'color.error': '#F2555A',
  'color.errorText': '#FF8A8E',
  'color.warning': '#F0B357',
  'color.ok': '#30A46C',
  'color.scrim': 'rgba(4, 6, 12, 0.7)',
  // Focus ring (Tier B: 4px ring, no glow; the TV is a 2017 model)
  'ring': '0 0 0 4px #4FA8FF',
  // Typography: Barlow / Barlow Condensed, bundled in src/fonts (latin + latin-ext, styles/fonts.css);
  // the system fonts are per-glyph fallbacks for other scripts.
  'font.family': "'Barlow', 'Tizen Sans', 'Samsung Sans', sans-serif",
  'font.display': "'Barlow Condensed', 'Tizen Sans Condensed', 'Arial Narrow', sans-serif",
  // Layout
  'space.safeX': '96px',
  'space.safeY': '54px',
  'space.content': '184px',         // content edge after the 120 rail
  'ease': 'cubic-bezier(0.2, 0.8, 0.2, 1)'
};
