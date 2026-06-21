// ezyjs — React binding (self-contained ESM; works with any bundler).
//
//   import { useEzy } from './ezy-react.js';
//   import EzyModule  from './counter.js';   // ezy compile --release --platform web
//
//   const ezy = useEzy(EzyModule);           // null until the wasm is ready
//   ezy.call('bump');                         // runs the exported Ezy function
import { useState, useEffect } from 'react';

// wrap an emscripten MODULARIZE/ESM factory into { call(fn, ...args) }.
// Ezy ints are 64-bit → marshalled as BigInt, returned as Number.
export async function loadEzy(factory) {
  const m = await factory();
  return {
    call(fn, ...args) {
      const f = m['_' + fn];
      if (!f) throw new Error('ezy: exported fn not found: ' + fn);
      const r = f(...args.map((a) => (typeof a === 'number' ? BigInt(a) : a)));
      return typeof r === 'bigint' ? Number(r) : r;
    },
    module: m,
  };
}

export function useEzy(factory) {
  const [app, setApp] = useState(null);
  useEffect(() => {
    let live = true;
    loadEzy(factory).then((a) => { if (live) setApp(a); });
    return () => { live = false; };
  }, [factory]);
  return app;
}

export default useEzy;
