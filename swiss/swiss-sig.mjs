// swiss-sig — extract Ezy backend function signatures (build-time, both targets).
//
// Reads .ez files and emits a JSON map the bridges use to call backend fns with
// the right types — the single source of truth that lets ONE App.jsx + ONE
// backend serve every target:
//   web → types a ccall (i64 args as BigInt, strings marshalled)
//   gtk → types the C extern decl + the direct call
//
//   { "bump": { "args": [], "ret": "int" },
//     "add":  { "args": ["int","int"], "ret": "int" },
//     "greet":{ "args": ["string"], "ret": "string" } }
//
// Usage:  node swiss-sig.mjs backend/*.ez --out src/backend.sig.json
import { readFileSync, writeFileSync } from 'fs';

// fn NAME(params) -> RET   |   fn NAME(params)   (void). `priv` fns are skipped.
const FN = /(^|\n)\s*(pub\s+|priv\s+)?fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(->\s*([*\[\]A-Za-z_]\w*))?/g;

function paramTypes(raw) {
  const s = raw.trim();
  if (!s) return [];
  return s.split(',').map((p) => {
    const m = p.split(':');
    return m[1] ? m[1].trim() : 'int';
  });
}

export function extractSigs(files) {
  const sigs = {};
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    let m;
    while ((m = FN.exec(src))) {
      const isPriv = m[2] && m[2].trim() === 'priv';
      const name = m[3];
      if (isPriv || name === 'main') continue;
      sigs[name] = { args: paramTypes(m[4]), ret: m[6] ? m[6].trim() : 'void' };
    }
  }
  return sigs;
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : 'backend.sig.json';
  const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  if (!files.length) { console.error('usage: swiss-sig <file.ez…> --out sig.json'); process.exit(1); }
  const sigs = extractSigs(files);
  writeFileSync(out, JSON.stringify(sigs, null, 2));
  console.error(`swiss-sig: ${Object.keys(sigs).length} fn(s) → ${out}`);
}

// run as CLI only (this file is also imported by the translator)
if (import.meta.url === `file://${process.argv[1]}`) main();
