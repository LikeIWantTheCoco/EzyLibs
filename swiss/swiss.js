// Swiss — public entry. `import { render, View, Text, ezy, ... } from 'swiss'`.
//
// Picks the platform HostConfig (web here) and exposes one renderer, the
// component primitives, StyleSheet, and the `ezy` backend singleton.
//
// render(<App/>, container, { backend, sigs }) — if a backend (emscripten
// factory) is given, Swiss loads the wasm and wires `ezy` BEFORE mounting, so
// `ezy.call(...)` is synchronous everywhere the App uses it. The same App.jsx
// runs on the gtk target, where the translator compiles `ezy.call` to a direct
// C call instead.
import { makeRenderer } from './swiss-reconciler.js';
import webHost from './swiss-host-web.js';
import { ezy, setBackend, connectEzy } from './swiss-bridge.js';

const renderer = makeRenderer(webHost);

// shared default font across all targets (matches the win32 / gtk default);
// the browser default is serif, so set a sans-serif stack on the root.
const SWISS_FONT = "'Segoe UI', system-ui, 'Cantarell', 'Roboto', 'DejaVu Sans', Arial, sans-serif";

// optional swiss.json "font": the web build passes it as VITE_SWISS_FONT; an app
// can also set globalThis.SWISS_FONT. When set it becomes the primary family so
// web matches the native targets. The bundled DejaVu is registered via @font-face
// (served from /fonts/) so a "DejaVu Sans" choice works in the browser too.
const FONT_OVERRIDE =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SWISS_FONT) ||
  (typeof globalThis !== 'undefined' && globalThis.SWISS_FONT) || '';
const FONT_STACK = FONT_OVERRIDE ? `'${FONT_OVERRIDE}', ${SWISS_FONT}` : SWISS_FONT;

let fontFaceInjected = false;
function injectFontFace() {
  if (fontFaceInjected || typeof document === 'undefined') return;
  fontFaceInjected = true;
  const s = document.createElement('style');
  s.textContent =
    "@font-face{font-family:'DejaVu Sans';font-weight:400;font-display:swap;src:url('/fonts/DejaVuSans.ttf') format('truetype')}" +
    "@font-face{font-family:'DejaVu Sans';font-weight:700;font-display:swap;src:url('/fonts/DejaVuSans-Bold.ttf') format('truetype')}" +
    // consistent accent focus ring across targets (GTK/win32 use 2px #0066cc); only
    // on keyboard focus (:focus-visible), suppressed for mouse clicks.
    "button:focus,input:focus,select:focus,textarea:focus{outline:none}" +
    "button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #0066cc;outline-offset:1px}";
  document.head.appendChild(s);
}

// dark/light theme toggle — light is the default on every target. setTheme(dark)
// flips the root colors (the native targets compile this to swiss_set_theme).
export function setTheme(dark) {
  const el = (typeof document !== 'undefined') && (document.getElementById('root') || document.body);
  if (!el) return;
  el.style.backgroundColor = dark ? '#1e1e1e' : '#ffffff';
  el.style.color = dark ? '#e6e6e6' : '#1a1a1a';
}

export function render(element, container, opts) {
  injectFontFace();
  if (container) { container.style.fontFamily = FONT_STACK; container.style.fontSize = '15px'; container.style.lineHeight = '1.5'; }
  setTheme(false);   // light default
  if (opts && opts.backend) {
    connectEzy(opts.backend, opts.sigs || {}).then((impl) => {
      setBackend(impl);
      renderer.render(element, container);
    });
    return;
  }
  renderer.render(element, container);
}

export { ezy } from './swiss-bridge.js';
export { native } from './swiss-native.js';   // the ONE native API (web backend)
export { View, Text, Button, Input, FlatList, ScrollView,
  Checkbox, Switch, Slider, Select, TextArea, ProgressBar, Image, Separator } from './swiss-components.js';
export { StyleSheet } from './swiss-stylesheet.js';

import { native } from './swiss-native.js';
export default { render, ezy, native, setTheme };
