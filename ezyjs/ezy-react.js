/* ezyjs — React binding.
 *
 *   import { useEzy } from 'ezyjs/ezy-react';
 *   import EzyModule from './counter.js';   // ezy compile --platform web ...
 *
 *   function Counter() {
 *     const ezy = useEzy(EzyModule);          // null until the wasm is ready
 *     const [n, setN] = React.useState(1);
 *     if (!ezy) return <p>Loading…</p>;
 *     return <button onClick={() => setN(ezy.call('bump'))}>{n}</button>;
 *   }
 *
 * useEzy loads the Ezy wasm module once and returns the same { call } object
 * ezy.js gives you (or null while loading). Works with any React 16.8+ /
 * bundler (Vite, webpack, Next, …).
 */
import { useState, useEffect } from 'react';
import Ezy from './ezy.js';

export function useEzy(factory) {
  const [app, setApp] = useState(null);
  useEffect(() => {
    let live = true;
    Ezy.wasm(factory).then((a) => { if (live) setApp(a); });
    return () => { live = false; };
  }, [factory]);
  return app;
}

export { Ezy };
export default useEzy;
