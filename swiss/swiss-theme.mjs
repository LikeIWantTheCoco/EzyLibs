// swiss-theme — the semantic color palette, shared by the build-time translators
// and the web runtime (kept dependency-free so the browser bundle can import it).
//
// A color anywhere in a style (backgroundColor, color, borderColor, the color in a
// `border` shorthand) may be a token name instead of a hex/named color; it resolves
// to the light or dark value for the current theme and flips live on setTheme().
// Plain colors pass through unchanged, so theming is opt-in per color. [light, dark].
export const THEME = {
  bg:        ['#ffffff', '#1e1e1e'],   // page background
  surface:   ['#f1f5f9', '#262b33'],   // sidebars / panels
  card:      ['#ffffff', '#2a2f37'],   // raised cards / inputs
  overlay:   ['#e9edf2', '#333a44'],   // hover / subtle fills
  text:      ['#1a1a1a', '#e8eaed'],   // primary text
  muted:     ['#64748b', '#98a2b3'],   // secondary text
  border:    ['#d0d5db', '#3a4048'],   // borders / dividers
  primary:   ['#2563eb', '#3b82f6'],   // accent / links / primary buttons
  onPrimary: ['#ffffff', '#ffffff'],   // text on primary
  danger:    ['#ef4444', '#f87171'],
  success:   ['#16a34a', '#22c55e'],
};
export const TOKENS = Object.keys(THEME);
export const isToken = (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(THEME, v);
