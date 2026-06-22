// swiss-winsdk — provision a Windows GTK3 SDK (sysroot) for cross-compiling,
// so the developer never installs it by hand. Mirrors how ezy auto-downloads
// the NDK/emsdk: pull the MSYS2 mingw64 GTK3 dependency closure and extract it
// into a managed sysroot.
//
//   node swiss-winsdk.mjs --out ~/.ezy/swiss/sysroot/windows [--dry]
//
// Result layout:  <out>/mingw64/{bin,lib,include,lib/pkgconfig,...}
// Use it with:    PKG_CONFIG_SYSROOT_DIR=<out>
//                 PKG_CONFIG_LIBDIR=<out>/mingw64/lib/pkgconfig
//                 pkg-config --define-prefix --cflags/--libs gtk+-3.0
import { mkdirSync, existsSync, writeFileSync, readFileSync, createWriteStream } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = 'https://repo.msys2.org/mingw/mingw64';
const ROOT = 'mingw-w64-x86_64-gtk3';
const P = 'mingw-w64-x86_64-';
// Heavy transitive deps not needed to build/run a GTK3 app (pulled in via
// scripting/codegen tools and optional pixbuf loaders). Pruning them keeps the
// sysroot small; if a build ever needs one, drop it from this set.
const DENY = new Set([
  'python', 'python-packaging', 'tcl', 'tk', 'openssl', 'sqlite3',
  'ncurses', 'mpdecimal', 'wineditline', 'tzdata',
].map((n) => P + n));

const args = process.argv.slice(2);
const out = args[args.indexOf('--out') + 1] || join(process.env.HOME, '.ezy/swiss/sysroot/windows');
const dry = args.includes('--dry');
const cache = join(tmpdir(), 'swiss-winsdk-cache');
mkdirSync(cache, { recursive: true });

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return dest;
}

// ── load the pacman DB and parse every package's desc ──
async function loadDb() {
  const dbFile = join(cache, 'mingw64.db');
  if (!existsSync(dbFile)) {
    process.stderr.write('swiss-winsdk: fetching MSYS2 package db…\n');
    await download(`${REPO}/mingw64.db`, dbFile);
  }
  const dbDir = join(cache, 'db');
  mkdirSync(dbDir, { recursive: true });
  execFileSync('tar', ['--use-compress-program=unzstd', '-xf', dbFile, '-C', dbDir]);
  // each <pkg-ver>/desc holds %NAME% %FILENAME% %DEPENDS% %PROVIDES%
  const { readdirSync } = await import('fs');
  const byName = new Map();      // name → {filename, depends[]}
  const provides = new Map();    // virtual/provided name → real name
  for (const d of readdirSync(dbDir)) {
    const descPath = join(dbDir, d, 'desc');
    if (!existsSync(descPath)) continue;
    const fields = parseDesc(readFileSync(descPath, 'utf8'));
    const name = fields.NAME?.[0];
    if (!name) continue;
    byName.set(name, { filename: fields.FILENAME?.[0], depends: fields.DEPENDS || [] });
    for (const p of fields.PROVIDES || []) provides.set(stripVer(p), name);
  }
  return { byName, provides };
}

function parseDesc(text) {
  const out = {};
  let key = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^%([A-Z0-9]+)%$/);
    if (m) { key = m[1]; out[key] = []; }
    else if (key && line.trim() !== '') out[key].push(line.trim());
    else key = null;
  }
  return out;
}

const stripVer = (s) => s.replace(/[<>=].*$/, '').trim();

// ── BFS the dependency closure from ROOT ──
function resolveClosure({ byName, provides }, root) {
  const seen = new Set();
  const order = [];
  const queue = [root];
  while (queue.length) {
    const raw = stripVer(queue.shift());
    let name = byName.has(raw) ? raw : provides.get(raw);
    if (!name || seen.has(name) || DENY.has(name)) continue;
    seen.add(name);
    const pkg = byName.get(name);
    if (!pkg) continue;
    order.push(name);
    for (const dep of pkg.depends) queue.push(dep);
  }
  return order;
}

async function main() {
  const db = await loadDb();
  const closure = resolveClosure(db, ROOT);
  process.stderr.write(`swiss-winsdk: ${closure.length} packages in the gtk3 closure\n`);
  if (dry) { process.stdout.write(closure.join('\n') + '\n'); return; }

  mkdirSync(out, { recursive: true });
  let i = 0;
  for (const name of closure) {
    i++;
    const { filename } = db.byName.get(name);
    if (!filename) continue;
    const pkgPath = join(cache, filename);
    if (!existsSync(pkgPath)) {
      process.stderr.write(`  [${i}/${closure.length}] ${name}\n`);
      await download(`${REPO}/${filename}`, pkgPath);
    }
    // extract into the sysroot (packages carry mingw64/… paths)
    execFileSync('tar', ['--use-compress-program=unzstd', '-xf', pkgPath, '-C', out,
      '--exclude=.PKGINFO', '--exclude=.BUILDINFO', '--exclude=.MTREE', '--exclude=.INSTALL'],
      { stdio: ['ignore', 'ignore', 'ignore'] });
  }
  process.stderr.write(`swiss-winsdk: windows GTK3 sysroot ready at ${out}\n`);
}

main().catch((e) => { process.stderr.write('swiss-winsdk: ' + e.message + '\n'); process.exit(1); });
