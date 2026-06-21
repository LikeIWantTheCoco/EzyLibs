/* ezyjs — a small JS ↔ Ezy connection library.
 *
 *   Node / desktop  (native Ezy binary, JSON-ish line RPC over stdio):
 *     const Ezy = require('./ezy.js');
 *     const app = Ezy.spawn('./counter');      // an Ezy binary running rpc_serve()
 *     await app.call('bump');                  // → 2, 3, 4 …
 *     app.close();
 *
 *   Browser  (Ezy compiled with `ezy compile --platform web`, MODULARIZE):
 *     import EzyModule from './counter.js';     // emscripten factory
 *     const app = await Ezy.wasm(EzyModule);
 *     app.call('bump');                         // calls the exported Ezy fn
 *
 * Same call(fn, ...args) surface in both. Ezy ints are 64-bit; the wasm path
 * marshals them as BigInt for you and hands back plain Numbers.
 */
(function (root) {
  'use strict';

  /* ── Node: spawn a native Ezy binary and talk line-RPC over stdio ── */
  function spawn(binPath, argv) {
    const cp = require('child_process');
    const p = cp.spawn(binPath, argv || [], { stdio: ['pipe', 'pipe', 'inherit'] });
    const waiters = [];
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const w = waiters.shift();
        if (w) w(line);
      }
    });
    return {
      call(fn, ...args) {
        return new Promise((resolve, reject) => {
          waiters.push((line) => {
            if (line === 'ERR') return reject(new Error('ezy: unknown rpc fn ' + fn));
            const n = Number(line);
            resolve(Number.isNaN(n) ? line : n);
          });
          p.stdin.write(fn + (args.length ? ' ' + args.join(' ') : '') + '\n');
        });
      },
      close() { p.stdin.end(); },
      process: p,
    };
  }

  /* ── Browser/Node-wasm: wrap an emscripten MODULARIZE module factory ── */
  async function wasm(factory) {
    const M = await factory();
    return {
      call(fn, ...args) {
        const f = M['_' + fn];
        if (!f) throw new Error('ezy: exported fn not found: ' + fn);
        const r = f(...args.map((a) => (typeof a === 'number' ? BigInt(a) : a)));
        return typeof r === 'bigint' ? Number(r) : r;
      },
      module: M,
    };
  }

  const Ezy = { spawn, wasm };
  if (typeof module !== 'undefined' && module.exports) module.exports = Ezy;
  else root.Ezy = Ezy;
})(typeof window !== 'undefined' ? window : globalThis);
