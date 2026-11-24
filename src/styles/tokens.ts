// Design tokens (Stage 2 values). CSS custom properties are unsupported on the TV, so
// scripts/build.mjs substitutes {{token}} placeholders in src/styles/*.css with these values.

export const tokens: Record<string, string> = {
  'color.bg': '#101116',
  'color.surface': '#191B24',
  'color.accent': '#4F8CFF',
  'color.text': '#FFFFFF',
  'color.textMuted': '#A5A7B2',
  'color.error': '#FF6B6B',
  'color.ok': '#4FD18B',
  'font.family': 'sans-serif',
  'space.safeX': '96px',
  'space.safeY': '54px'
};
