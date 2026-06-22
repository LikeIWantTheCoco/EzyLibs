#!/bin/sh
# swiss — CLI for the Swiss framework (installed by `ezyl install swiss`).
#
#   swiss new <name>          scaffold a Swiss app (React frontend + Ezy backend)
#   swiss build [--platform web]   compile backend (.ez → wasm) + build frontend
#   swiss dev                 compile backend, then run the Vite dev server
#
# v0.1 ships the web target only. The project layout and the <View>/<Text>/…
# component API are platform-agnostic so native targets (GTK/Android/iOS) slot
# in later without touching app code.
set -e
LIB="$HOME/.ezy/libs/swiss"
RUNTIME="swiss.js swiss-reconciler.js swiss-host-web.js swiss-components.js swiss-stylesheet.js swiss-bridge.js swiss-gtkc.mjs swiss-sig.mjs swiss-winsdk.mjs swiss-winshim.c"

die() { echo "swiss: $1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# y/n prompt (reads the tty so it works even when stdout is piped). Default No.
ask_yn() {
  printf 'swiss: %s [y/N] ' "$1" >&2
  ans=""
  { read ans </dev/tty; } 2>/dev/null || read ans 2>/dev/null || ans=""
  case "$ans" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# install command for the HOST's native GTK3 dev package (by package manager)
gtk_cmd_native() {
  if   have apt-get; then echo "sudo apt-get install -y libgtk-3-dev"
  elif have dnf;     then echo "sudo dnf install -y gtk3-devel"
  elif have pacman;  then echo "sudo pacman -S --needed --noconfirm gtk3"
  elif have brew;    then echo "brew install gtk+3"
  else echo ""; fi
}

# install command for a CROSS GTK3 SDK (target != host), where a clean one exists
gtk_cmd_cross() {  # $1=target $2=host
  case "$1:$2" in
    windows:linux)
      if   have dnf;     then echo "sudo dnf install -y mingw64-gtk3"          # Fedora
      elif have pacman;  then echo "sudo pacman -S --needed --noconfirm mingw-w64-x86_64-gtk3"
      else echo ""; fi ;;                                                       # Debian: none clean
    *) echo "" ;;
  esac
}

# Ensure the GTK3 SDK for $target exists; offer to install it (y/n) like ezy does
# for its C toolchain. Sets gtk_cflags / gtk_libs (and PKG_CONFIG_* for cross).
ensure_gtk() {
  target="$1"; host="$2"
  if [ "$target" = "$host" ]; then
    if ! pkg-config --exists gtk+-3.0 2>/dev/null; then
      cmd=$(gtk_cmd_native)
      [ -n "$cmd" ] || die "GTK3 dev not found and no known package manager — install GTK3 dev manually."
      echo "swiss: GTK3 development files for $target are not installed." >&2
      ask_yn "Install them now?  ($cmd)" || die "aborted. Install manually:  $cmd"
      eval "$cmd" || die "GTK3 install failed"
      pkg-config --exists gtk+-3.0 2>/dev/null || die "GTK3 still not found after install"
    fi
    gtk_cflags=$(pkg-config --cflags gtk+-3.0)
    gtk_libs=$(pkg-config --libs gtk+-3.0)
  else
    # cross: a sysroot is required. Prefer $SWISS_GTK_SYSROOT, else a managed one
    # Swiss can auto-download (MSYS2 GTK3 closure) — like ezy auto-fetches the NDK.
    managed="$HOME/.ezy/swiss/sysroot/$target"
    if [ -z "$SWISS_GTK_SYSROOT" ] && [ -f "$managed/mingw64/lib/pkgconfig/gtk+-3.0.pc" ]; then
      SWISS_GTK_SYSROOT="$managed"
    fi
    if [ -z "$SWISS_GTK_SYSROOT" ]; then
      if [ "$target" = windows ] && [ -f src/swiss/swiss-winsdk.mjs ]; then
        echo "swiss: no $target GTK3 SDK found." >&2
        ask_yn "Download a managed $target GTK3 SDK now (~480MB, from MSYS2 → $managed)?" \
          || die "aborted. Set SWISS_GTK_SYSROOT to a $target GTK3 sysroot, or re-run and accept the download."
        node src/swiss/swiss-winsdk.mjs --out "$managed" || die "$target GTK3 SDK provisioning failed"
        SWISS_GTK_SYSROOT="$managed"
      else
        die "no automatic $target GTK3 SDK for this host. Set SWISS_GTK_SYSROOT to a $target GTK3 sysroot (MSYS2 mingw64 / gvsbuild / MXE)."
      fi
    fi
    # locate the .pc dir (managed has mingw64/…; a user sysroot may not)
    gtkpc=""
    for d in "$SWISS_GTK_SYSROOT/mingw64/lib/pkgconfig" "$SWISS_GTK_SYSROOT/lib/pkgconfig"; do
      [ -f "$d/gtk+-3.0.pc" ] && gtkpc="$d" && break
    done
    [ -n "$gtkpc" ] || die "no gtk+-3.0.pc under SWISS_GTK_SYSROOT=$SWISS_GTK_SYSROOT"
    export PKG_CONFIG_LIBDIR="$gtkpc"          # isolates from host .pc files
    export PKG_CONFIG_SYSROOT_DIR="$SWISS_GTK_SYSROOT"
    export PKG_CONFIG_PATH=""
    gtk_cflags=$(pkg-config --define-prefix --cflags gtk+-3.0)
    gtk_libs=$(pkg-config --define-prefix --libs gtk+-3.0)
  fi
}

copy_runtime() {
  dest="$1"; mkdir -p "$dest"
  for f in $RUNTIME; do cp "$LIB/$f" "$dest/$f"; done
}

scaffold() {
  name="$1"; [ -n "$name" ] || die "usage: swiss new <name>"
  [ -e "$name" ] && die "'$name' already exists"
  mkdir -p "$name/src/swiss" "$name/backend"
  copy_runtime "$name/src/swiss"

  cat > "$name/swiss.json" <<JSON
{
  "name": "$name",
  "version": "0.1.0",
  "entry": "src/main.jsx",
  "backend": "backend/main.ez",
  "platforms": ["web"],
  "web": { "title": "$name" }
}
JSON

  cat > "$name/package.json" <<JSON
{
  "name": "$name",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "swiss dev",
    "build": "swiss build",
    "build:web": "swiss build --platform web"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-reconciler": "^0.29.0",
    "@babel/parser": "^7.24.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.2.0",
    "vite": "^5.0.0"
  }
}
JSON

  cat > "$name/vite.config.js" <<'JS'
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Map the bare `swiss` / `swiss/bridge` specifiers to the runtime copied into
// src/swiss by `swiss new`. App code imports `from 'swiss'`, never react-dom.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'swiss/bridge': resolve(__dirname, 'src/swiss/swiss-bridge.js'),
      swiss: resolve(__dirname, 'src/swiss/swiss.js'),
    },
  },
});
JS

  cat > "$name/index.html" <<HTML
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>$name</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
HTML

  # main.jsx — WEB bootstrap only (loads the wasm backend, then mounts). The gtk
  # target ignores this file; the translator works from App.jsx directly.
  cat > "$name/src/main.jsx" <<'JS'
import { render } from 'swiss';
import App from './App.jsx';
import EzyModule from './backend.js';     // ezy → wasm (built by `swiss build`)
import sigs from './backend.sig.json';     // fn signatures (built by `swiss build`)

// Swiss loads the wasm and wires `ezy` BEFORE mounting, so ezy.call is sync.
render(<App />, document.getElementById('root'), { backend: EzyModule, sigs });
JS

  # App.jsx — the SHARED frontend. Identical for web and gtk. No target glue:
  # `ezy.call` is synchronous on both (web preloads in render(); gtk compiles it
  # to a direct C call).
  cat > "$name/src/App.jsx" <<'JS'
import { useState } from 'react';
import { View, Text, Button, StyleSheet, ezy } from 'swiss';

// Counter logic lives in Ezy (backend/main.ez); React just renders.
export default function App() {
  const [n, setN] = useState(0);
  return (
    <View style={styles.box}>
      <Text style={styles.title}>Swiss counter</Text>
      <Text>Count: {n}</Text>
      <Button title="+1" onPress={() => setN(ezy.call('bump'))} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { padding: 24, gap: 12 },
  title: { fontSize: 24, fontWeight: 'bold' },
});
JS

  cat > "$name/backend/main.ez" <<'EZ'
# Swiss backend — plain native-typed Ezy functions. The SAME signatures serve
# every target: web types a wasm ccall, gtk calls them directly in-process.
# Call them from the frontend with  ezy.call('name', ...args).
#
# No `fn main` here (Swiss provides the entry point on each target). Native
# EzyLibs (json/sqlite) link on gtk but not on the wasm/web target yet.

count = 0

fn bump() -> int:
{
    global count
    count = count + 1
    return count
}
EZ

  cat > "$name/.gitignore" <<'GI'
node_modules/
dist/
.swiss/
src/backend.js
src/backend.sig.json
GI

  echo "swiss: created '$name'"
  echo "  cd $name && npm install && swiss dev"
}

build_backend() {
  [ -f swiss.json ] || die "no swiss.json — run inside a Swiss project"
  have ezy || die "ezy not found on PATH (build the EzyLang compiler first)"
  [ -d "$LIB" ] && copy_runtime src/swiss   # self-heal stale project runtime
  echo "swiss: compiling backend → wasm (ESM)"
  # compile every .ez in backend/ to an ESM wasm module under src/
  for ez in backend/*.ez; do
    [ -e "$ez" ] || continue
    base=$(basename "$ez" .ez)
    out="src/$base"
    [ "$base" = "main" ] && out="src/backend"
    ezy compile --release --platform web-esm "$ez" -o "$out"
  done
  # signatures for the web bridge (typed ccall)
  node src/swiss/swiss-sig.mjs backend/*.ez --out src/backend.sig.json
}

# detect the host OS → the default desktop target
host_os() {
  case "$(uname -s)" in
    Linux)               echo linux ;;
    Darwin)              echo macos ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *)                   echo linux ;;
  esac
}

# Desktop target (linux/windows/macos): the GTK frontend is implicit. Translate
# React → C (build time), link the Ezy backend in-process (FFI), produce one
# native GTK3 binary for the given OS. No JS engine ships in the app.
build_desktop() {
  target="$1"
  host=$(host_os)
  [ -f swiss.json ] || die "no swiss.json — run inside a Swiss project"
  have ezy || die "ezy not found on PATH"
  have node || die "node not found (the GTK translator runs on Node at build time)"

  # keep the project's runtime/build scripts in sync with the installed lib, so
  # projects scaffolded by an older Swiss self-heal (e.g. new winshim/winsdk).
  [ -d "$LIB" ] && copy_runtime src/swiss

  # Reuse ezy's cross-toolchain resolution: it picks the C compiler for $target
  # (gcc / MinGW / NDK / osxcross) and auto-installs it (with consent). We use
  # that same compiler for our frontend + backend.  ezy resolves the COMPILER;
  # the GTK target libraries are a separate dependency (see below).
  echo "swiss: resolving toolchain for $target (via ezy)"
  tc=$(ezy toolchain --platform "$target") || die "ezy could not provide a $target toolchain"
  CC=$(printf '%s\n' "$tc"   | sed -n 's/^CC=//p')
  LIBS=$(printf '%s\n' "$tc" | sed -n 's/^LIBS=//p')
  EXT=$(printf '%s\n' "$tc"  | sed -n 's/^EXT=//p')
  [ -n "$CC" ] || die "ezy toolchain did not return a compiler for $target"

  # GTK SDK for $target — offer to install it (y/n) if missing, like ezy does
  # for the C toolchain. ezy gave us the compiler; this fills the GTK libs.
  ensure_gtk "$target" "$host"

  name=$(basename "$PWD")
  work=.swiss/desktop; mkdir -p "$work"

  # 1) backend: Ezy → C → object (for $target, via ezy's CC). Neutralize main.
  echo "swiss: compiling backend for $target (Ezy → C, FFI in-process)"
  ezy emit-c backend/main.ez > "$work/backend.c"
  sed -i 's/^int main(/int __ezy_backend_main(/' "$work/backend.c"
  "$CC" -D_GNU_SOURCE -c "$work/backend.c" -o "$work/backend.o"

  # link flags for any EzyLibs the backend imports (e.g. sqlite). Native target
  # only — these are ELF .so and don't cross-compile.
  ezylib_flags=""
  for lib in $(grep -oE '^[[:space:]]*import[[:space:]]+"[^"]+"' backend/*.ez 2>/dev/null | sed -E 's/.*"([^"]+)".*/\1/' | sort -u); do
    libdir="$HOME/.ezy/libs/$lib"
    [ -f "$libdir/lib$lib.so" ] || continue
    if [ "$target" != "$host" ]; then
      die "backend imports EzyLib '$lib' (native .so) — can't cross-compile to $target. Build for the host OS, or use a target-native lib."
    fi
    extra=$(sed -n 's/.*"link_flags":[[:space:]]*\[\([^]]*\)\].*/\1/p' "$libdir/manifest.json" 2>/dev/null | tr ',' ' ' | tr -d '"')
    ezylib_flags="$ezylib_flags -L$libdir -l$lib -Wl,-rpath,$libdir $extra"
    echo "swiss: linking EzyLib '$lib'"
  done

  # 2) frontend: React/JSX → GTK C (the Swiss translator; build-time Node only)
  echo "swiss: translating React → GTK C"
  node src/swiss/swiss-sig.mjs backend/*.ez --out "$work/backend.sig.json"
  node src/swiss/swiss-gtkc.mjs src/App.jsx --out "$work/frontend.c" \
    --title "$name" --sig "$work/backend.sig.json"

  # 3) link one GTK binary with ezy's $target compiler. Windows: GTK is dynamic
  #    (DLLs), so drop ezy's -static, use -mwindows, and add the POSIX shim.
  winobj=""
  if [ "$target" = windows ]; then
    "$CC" -c src/swiss/swiss-winshim.c -o "$work/winshim.o"
    winobj="$work/winshim.o"
    link_libs="-lm -lwinpthread -mwindows"
  else
    link_libs="$LIBS"
  fi
  echo "swiss: linking GTK binary ($CC)"
  "$CC" "$work/frontend.c" "$work/backend.o" $winobj -o "$name$EXT" \
    $gtk_cflags $gtk_libs $ezylib_flags $link_libs
  echo "swiss: built ./$name$EXT"
  if [ "$target" = windows ]; then
    echo "swiss: note — $name$EXT needs its GTK DLLs to run."
    echo "       standalone bundle:  swiss package --platform windows"
    echo "       quick test:         WINEPATH=$SWISS_GTK_SYSROOT/mingw64/bin wine $name$EXT"
  fi
}

# recursively copy a PE's DLL dependency closure from $sysbin into $out
collect_dlls() {  # $1=file $2=sysbin $3=out $4=objdump
  "$4" -p "$1" 2>/dev/null | awk '/DLL Name:/{print $3}' | while read -r dll; do
    if [ -f "$2/$dll" ] && [ ! -f "$3/$dll" ]; then
      cp "$2/$dll" "$3/"
      collect_dlls "$3/$dll" "$2" "$3" "$4"
    fi
  done
}

# bundle a windows .exe with its GTK runtime so it runs without GTK installed
bundle_windows() {
  out="dist/${name}-windows"; rm -rf "$out"; mkdir -p "$out"
  cp "$name$EXT" "$out/"
  sysbin="$SWISS_GTK_SYSROOT/mingw64/bin"
  objd="${CC%gcc}objdump"; have "$objd" || objd=objdump
  echo "swiss: bundling DLL closure ($objd)"
  collect_dlls "$out/$name$EXT" "$sysbin" "$out" "$objd"
  # compiled GLib settings schemas (optional — tolerate absence under set -e)
  sc="$SWISS_GTK_SYSROOT/mingw64/share/glib-2.0/schemas"
  if [ -f "$sc/gschemas.compiled" ]; then
    mkdir -p "$out/share/glib-2.0/schemas"
    cp "$sc/gschemas.compiled" "$out/share/glib-2.0/schemas/" 2>/dev/null || true
  fi
  # gdk-pixbuf loaders (icons/images) + close over the loaders' own DLL deps
  pb="$SWISS_GTK_SYSROOT/mingw64/lib/gdk-pixbuf-2.0"
  if [ -d "$pb" ]; then
    mkdir -p "$out/lib"; cp -r "$pb" "$out/lib/" 2>/dev/null || true
    find "$out/lib" -name '*.dll' 2>/dev/null | while read -r l; do
      collect_dlls "$l" "$sysbin" "$out" "$objd"
    done
  fi
  # a font + fontconfig so text renders without relying on system fonts
  mkdir -p "$out/share/fonts" "$out/etc/fonts"
  for f in DejaVuSans.ttf DejaVuSans-Bold.ttf; do
    src=$(find /usr/share/fonts -iname "$f" 2>/dev/null | head -1)
    [ -n "$src" ] && cp "$src" "$out/share/fonts/" 2>/dev/null || true
  done
  cat > "$out/etc/fonts/fonts.conf" <<'CONF'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir prefix="relative">../share/fonts</dir>
  <cachedir prefix="relative">../var/fontcache</cachedir>
  <match target="pattern"><test name="family"><string>sans-serif</string></test>
    <edit name="family" mode="prepend"><string>DejaVu Sans</string></edit></match>
</fontconfig>
CONF
  dlln=$(ls "$out"/*.dll 2>/dev/null | wc -l)
  echo "swiss: bundled $dlln DLLs + GTK data → $out/"
}

# bundle a linux ELF so it runs on machines without GTK installed — WITHOUT
# shipping libs every Linux desktop already has (glibc/loader, libstdc++ ABI,
# and the X/GL/driver stack). We bundle the GTK stack + its non-system deps.
bundle_linux() {
  out="dist/${name}-linux"; rm -rf "$out"; mkdir -p "$out/lib"
  cp "$name" "$out/"
  # never bundle these — glibc/loader are kernel/ABI-tied and always present;
  # X11/GL/DRM are part of any graphical Linux (AppImage excludes the same set).
  skip='ld-linux|/libc\.so|/libm\.so|libpthread|/libdl\.so|/librt\.so|libresolv|/libutil|libgcc_s|libstdc\+\+|libGL\.|libGLX|libGLdispatch|libEGL|libGLU|libOpenGL|libX11|libxcb|libXext|libXi\.|libXrandr|libXrender|libXfixes|libXcursor|libXinerama|libXdamage|libXcomposite|libXau|libXdmcp|libxshmfence|libdrm|libgbm|libwayland'
  echo "swiss: bundling non-system shared-lib closure (ldd)"
  ldd "$name" | awk '/=> \//{print $3}' | while read -r so; do
    echo "$so" | grep -Eq "$skip" && continue
    cp -L "$so" "$out/lib/" 2>/dev/null
  done
  cat > "$out/${name}.sh" <<SH
#!/bin/sh
here="\$(dirname "\$(readlink -f "\$0")")"
LD_LIBRARY_PATH="\$here/lib:\$LD_LIBRARY_PATH" exec "\$here/${name}" "\$@"
SH
  chmod +x "$out/${name}.sh"
  echo "swiss: bundled $(ls "$out/lib" | wc -l) libs → $out/  (run ./${name}.sh)"
}

cmd_package() {
  platform=$(host_os)
  while [ $# -gt 0 ]; do
    case "$1" in --platform) platform="$2"; shift 2 ;; *) shift ;; esac
  done
  case "$platform" in
    windows) build_desktop windows; bundle_windows
             if have zip; then ( cd dist && zip -qr "${name}-windows.zip" "${name}-windows" ); echo "swiss: → dist/${name}-windows.zip"; fi ;;
    linux)   build_desktop linux;   bundle_linux ;;
    macos)   build_desktop macos;    die "macos bundling not in v0.1 (binary built)" ;;
    web)     cmd_build --platform web; echo "swiss: web build in dist/ is already deployable" ;;
    *)       die "package: unknown platform '$platform'" ;;
  esac
}

cmd_build() {
  platform=$(host_os)   # default: desktop (GTK) for the host OS
  while [ $# -gt 0 ]; do
    case "$1" in
      --platform) platform="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  case "$platform" in
    web) build_backend
         have npx || die "npx not found (install Node.js)"
         echo "swiss: building frontend (vite)"
         npx vite build ;;
    linux|windows|macos) build_desktop "$platform" ;;   # GTK frontend, OS backend
    gtk|desktop)
         die "use an OS target, not '$platform': --platform linux|windows|macos (GTK is implicit on desktop). No --platform = host OS." ;;
    android|ios|mobile)
         die "platform '$platform' not in v0.1 (web + desktop). Mobile targets are the next milestone." ;;
    *)   die "unknown platform '$platform'" ;;
  esac
}

cmd_dev() {
  build_backend
  have npx || die "npx not found (install Node.js)"
  echo "swiss: starting dev server"
  npx vite
}

case "$1" in
  new)     scaffold "$2" ;;
  build)   shift; cmd_build "$@" ;;
  package) shift; cmd_package "$@" ;;
  dev)     cmd_dev ;;
  *)
    echo "swiss — one React frontend + Ezy backend, many targets"
    echo "usage:"
    echo "  swiss new <name>                 scaffold a Swiss app"
    echo "  swiss dev                        web dev server (vite + wasm backend)"
    echo "  swiss build                      desktop GTK app for the host OS"
    echo "  swiss build --platform linux     desktop GTK app (linux)"
    echo "  swiss build --platform windows   desktop GTK app (.exe)"
    echo "  swiss build --platform macos     desktop GTK app (macOS)"
    echo "  swiss build --platform web       web build (React DOM + wasm) → dist/"
    echo "  swiss package [--platform OS]    build + bundle a distributable (deps included)"
    echo "  (GTK is implicit on desktop; the OS picks the backend compile target)"
    exit 1 ;;
esac
