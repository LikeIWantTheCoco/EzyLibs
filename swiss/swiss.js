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

// dark/light theme toggle — light is the default on every target. setTheme(dark)
// flips the root colors (the native targets compile this to swiss_set_theme).
export function setTheme(dark) {
  const el = (typeof document !== 'undefined') && (document.getElementById('root') || document.body);
  if (!el) return;
  el.style.backgroundColor = dark ? '#1e1e1e' : '#ffffff';
  el.style.color = dark ? '#e6e6e6' : '#1a1a1a';
}

export function render(element, container, opts) {
  if (container) { container.style.fontFamily = SWISS_FONT; container.style.fontSize = '15px'; }
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
export { View, Text, Button, Input, FlatList, ScrollView } from './swiss-components.js';
export { StyleSheet } from './swiss-stylesheet.js';

import { native } from './swiss-native.js';
export default { render, ezy, native, setTheme };
