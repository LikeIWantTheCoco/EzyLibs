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
RUNTIME="swiss.js swiss-reconciler.js swiss-host-web.js swiss-components.js swiss-stylesheet.js swiss-theme.mjs swiss-bridge.js swiss-jsx-core.mjs swiss-c-backend.mjs swiss-kt-backend.mjs swiss-gtkc.mjs swiss-win32c.mjs swiss-androidc.mjs swiss-sig.mjs swiss-winsdk.mjs swiss-winshim.c swiss-native.js"

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
  # the native facade lives in the backend so `import "swiss-native.ez"` resolves
  cp "$LIB/swiss-native.ez" "$name/backend/swiss-native.ez"

  # permissions: declare EVERY device permission the app uses here. Swiss emits
  # them into the platform manifest (AndroidManifest / Info.plist) on mobile
  # builds; you must ALSO request them at runtime via swiss_request(...) in the
  # backend (the os_permissions fragment). Both are required.
  cat > "$name/swiss.json" <<JSON
{
  "name": "$name",
  "version": "0.1.0",
  "entry": "src/main.jsx",
  "backend": "backend/main.ez",
  "platforms": ["web"],
  "permissions": [],
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

count = 0

fn bump() -> int:
{
    global count
    count = count + 1
    return count
}

# ── Native device access (files, dialogs, notifications, brightness, battery,
#    GPS, sensors, background, …) ──
# It is the ONE sanctioned native API. On DESKTOP/MOBILE targets, uncomment the
# import and call swiss_*; the os libs link automatically:
#
#   import "swiss-native.ez"
#   fn save_note(text: string) -> int:
#   {
#       p = swiss_save_dialog("Save note", "note.txt")
#       if p.len() == 0: { return 0 }
#       swiss_write(p, text); swiss_notify("Saved", p); return 1
#   }
#   fn where_am_i() -> string:                       # needs "location" in swiss.json
#   { if swiss_request("location") == 0: { return "" } ; return swiss_location() }
#
# On the WEB target the same capabilities come from JS instead (native C libs
# aren't in wasm):  import { native } from 'swiss';  native.notify('Hi','there')
#
# Either way: every permission you use must be declared in swiss.json
# "permissions" AND requested at runtime (swiss_request / native.request).
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

# Translate swiss.json "permissions" into platform manifest fragments. The dev
# declares permissions ONCE in swiss.json; Swiss emits the AndroidManifest
# <uses-permission> lines + iOS Info.plist usage keys (→ .swiss/permissions/),
# to be merged into the mobile app manifest. (The app must ALSO request each at
# runtime via swiss_request(...) — both are required.)
gen_permissions() {
  [ -f swiss.json ] || return 0
  mkdir -p .swiss/permissions
  node -e '
    const j = JSON.parse(require("fs").readFileSync("swiss.json","utf8"));
    const perms = j.permissions || [];
    const AND = { location:"ACCESS_FINE_LOCATION", camera:"CAMERA", microphone:"RECORD_AUDIO",
      storage:"READ_EXTERNAL_STORAGE", notifications:"POST_NOTIFICATIONS", contacts:"READ_CONTACTS",
      activity:"ACTIVITY_RECOGNITION", bluetooth:"BLUETOOTH_CONNECT", background:"FOREGROUND_SERVICE" };
    const IOS = { location:"NSLocationWhenInUseUsageDescription", camera:"NSCameraUsageDescription",
      microphone:"NSMicrophoneUsageDescription", contacts:"NSContactsUsageDescription",
      activity:"NSMotionUsageDescription", bluetooth:"NSBluetoothAlwaysUsageDescription" };
    const fs = require("fs");
    const xml = perms.map(p => AND[p] ? `  <uses-permission android:name="android.permission.${AND[p]}"/>` : `  <!-- unknown permission: ${p} -->`).join("\n");
    fs.writeFileSync(".swiss/permissions/android-manifest.xml", xml + "\n");
    let plist = perms.map(p => IOS[p] ? `  <key>${IOS[p]}</key>\n  <string>${j.name||"This app"} needs ${p} access.</string>` : "").filter(Boolean).join("\n");
    if (perms.includes("background")) plist += `\n  <key>UIBackgroundModes</key>\n  <array><string>processing</string><string>location</string></array>`;
    fs.writeFileSync(".swiss/permissions/ios-info.plist", plist + "\n");
    if (perms.length) console.error("swiss: permissions ["+perms.join(", ")+"] -> .swiss/permissions/ (request them at runtime too)");
  ' 2>&1 || true
}

build_backend() {
  [ -f swiss.json ] || die "no swiss.json — run inside a Swiss project"
  have ezy || die "ezy not found on PATH (build the EzyLang compiler first)"
  [ -d "$LIB" ] && copy_runtime src/swiss   # self-heal stale project runtime
  gen_permissions
  echo "swiss: compiling backend → wasm (ESM)"
  # compile every .ez in backend/ to an ESM wasm module under src/. Skip the
  # swiss-native facade: it pulls the native os/* .so libs (which aren't wasm),
  # and on web native access comes from JS (`import { native } from 'swiss'`).
  for ez in backend/*.ez; do
    [ -e "$ez" ] || continue
    base=$(basename "$ez" .ez)
    [ "$base" = "swiss-native" ] && continue
    out="src/$base"
    [ "$base" = "main" ] && out="src/backend"
    ezy compile --release --platform web-esm "$ez" -o "$out"
  done
  # signatures for the web bridge (typed ccall) — also skip the native facade
  node src/swiss/swiss-sig.mjs $(ls backend/*.ez | grep -v 'swiss-native\.ez') --out src/backend.sig.json
}

# detect the host OS → the default desktop target
# optional font family from swiss.json ("font"): when set, every target uses it
# as the primary family. Empty = per-OS native default (Segoe on Windows, etc.).
read_font() {
  [ -f swiss.json ] || return 0
  node -e 'try{const f=require(process.cwd()+"/swiss.json").font;if(f)process.stdout.write(String(f))}catch(e){}' 2>/dev/null
}
# ship the bundled .ttf files next to a built binary (so a swiss.json "font" that
# names a bundled family works even where it is not installed). $1 = dir.
ship_fonts() {
  [ -d "$LIB/assets/fonts" ] || return 0
  mkdir -p "$1/fonts" && cp "$LIB"/assets/fonts/*.ttf "$1/fonts/" 2>/dev/null || true
}

host_os() {
  case "$(uname -s)" in
    Linux)               echo linux ;;
    Darwin)              echo macos ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *)                   echo linux ;;
  esac
}

# collect the ezylib link flags for any native EzyLib the backend imports. Native
# .so/.dll only — these don't cross-compile, so this errors on a cross target.
collect_ezylib_flags() {
  target="$1"; host="$2"
  ezylib_flags=""
  # only scan the files actually compiled: backend/main.ez, plus the swiss-native
  # facade IFF main imports it (it's always copied into backend/, but its os
  # imports only apply when used).
  scan="backend/main.ez"
  grep -qE '^[[:space:]]*import[[:space:]]+"swiss-native' backend/main.ez 2>/dev/null && scan="$scan backend/swiss-native.ez"
  for lib in $(grep -hoE '^[[:space:]]*import[[:space:]]+"[^"]+"' $scan 2>/dev/null | sed -E 's/.*"([^"]+)".*/\1/' | sort -u); do
    libdir="$HOME/.ezy/libs/$lib"
    [ -f "$libdir/lib$lib.so" ] || continue
    if [ "$target" != "$host" ]; then
      die "backend imports EzyLib '$lib' (native .so) — can't cross-compile to $target. Build for the host OS, or use a target-native lib."
    fi
    extra=$(sed -n 's/.*"link_flags":[[:space:]]*\[\([^]]*\)\].*/\1/p' "$libdir/manifest.json" 2>/dev/null | tr ',' ' ' | tr -d '"')
    ezylib_flags="$ezylib_flags -L$libdir -l$lib -Wl,-rpath,$libdir $extra"
    echo "swiss: linking EzyLib '$lib'"
  done
}

# Windows target — NATIVE Win32. React/JSX → Win32 C (swiss-win32c), Ezy backend
# linked in-process. The .exe links ONLY Windows system DLLs (user32/gdi32/
# comctl32/comdlg32/shell32/ole32) — so it is self-contained: no GTK SDK to
# install, no 480MB download, no DLL closure to bundle. One small portable .exe.
build_win32() {
  host=$(host_os)
  [ -f swiss.json ] || die "no swiss.json — run inside a Swiss project"
  have ezy || die "ezy not found on PATH"
  have node || die "node not found (the Win32 translator runs on Node at build time)"
  [ -d "$LIB" ] && copy_runtime src/swiss

  echo "swiss: resolving toolchain for windows (via ezy)"
  tc=$(ezy toolchain --platform windows) || die "ezy could not provide a windows toolchain"
  CC=$(printf '%s\n'  "$tc" | sed -n 's/^CC=//p')
  EXT=$(printf '%s\n' "$tc" | sed -n 's/^EXT=//p'); [ -n "$EXT" ] || EXT=".exe"
  [ -n "$CC" ] || die "ezy toolchain did not return a compiler for windows"

  name=$(basename "$PWD")
  work=.swiss/win32; mkdir -p "$work"

  # 1) backend: Ezy → C → object (windows, via ezy's MinGW CC). Neutralize main.
  echo "swiss: compiling backend for windows (Ezy → C, FFI in-process)"
  ezy emit-c backend/main.ez > "$work/backend.c"
  sed -i 's/^int main(/int __ezy_backend_main(/' "$work/backend.c"
  "$CC" -D_GNU_SOURCE -c "$work/backend.c" -o "$work/backend.o"
  "$CC" -c src/swiss/swiss-winshim.c -o "$work/winshim.o"   # POSIX bits mingw lacks

  # app manifest → comctl32 v6 (themed controls + cue banners) + per-monitor DPI
  # awareness (without it Windows bitmap-scales the window on HiDPI → blurry)
  cat > "$work/app.manifest" <<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency><dependentAssembly><assemblyIdentity
    type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0"
    processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
  </dependentAssembly></dependency>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2, PerMonitor</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>
XML
  printf '1 24 "app.manifest"\n' > "$work/app.rc"
  WINDRES="${CC%gcc}windres"; have "$WINDRES" || WINDRES=x86_64-w64-mingw32-windres
  ( cd "$work" && "$WINDRES" app.rc -o manifest.o ) || die "windres failed (manifest)"

  collect_ezylib_flags windows "$host"

  # 2) frontend: React/JSX → native Win32 C (build-time Node only)
  echo "swiss: translating React → Win32 C"
  font=$(read_font)
  node src/swiss/swiss-sig.mjs backend/*.ez --out "$work/backend.sig.json"
  if [ -n "$font" ]; then
    ship_fonts .; echo "swiss: font \"$font\" (bundled .ttf shipped next to the .exe)"
    node src/swiss/swiss-win32c.mjs src/App.jsx --out "$work/frontend.c" \
      --title "$name" --sig "$work/backend.sig.json" --font "$font"
  else
    node src/swiss/swiss-win32c.mjs src/App.jsx --out "$work/frontend.c" \
      --title "$name" --sig "$work/backend.sig.json"
  fi

  # 3) link one native .exe — system DLLs only, no GTK
  echo "swiss: linking native Win32 binary ($CC)"
  # -static folds libwinpthread / libgcc into the .exe (the Ezy runtime uses
  # pthreads) so the binary stays self-contained — only system DLLs remain.
  "$CC" "$work/frontend.c" "$work/backend.o" "$work/winshim.o" "$work/manifest.o" -o "$name$EXT" \
    -mwindows -static $ezylib_flags \
    -luser32 -lgdi32 -lcomctl32 -lcomdlg32 -lshell32 -lole32 -lgdiplus -luxtheme -lwinpthread -lm
  echo "swiss: built ./$name$EXT  (portable — links only Windows system DLLs)"
  echo "       quick test:  wine ./$name$EXT"
}

# Desktop target (linux/macos): the GTK frontend is implicit. Translate React → C
# (build time), link the Ezy backend in-process (FFI), produce one native GTK3
# binary. Windows is handled natively by build_win32 (no GTK). No JS engine ships.
build_desktop() {
  target="$1"
  [ "$target" = windows ] && { build_win32; return; }
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
  collect_ezylib_flags "$target" "$host"

  # 2) frontend: React/JSX → GTK C (the Swiss translator; build-time Node only)
  echo "swiss: translating React → GTK C"
  font=$(read_font)
  node src/swiss/swiss-sig.mjs backend/*.ez --out "$work/backend.sig.json"
  if [ -n "$font" ]; then
    echo "swiss: font \"$font\" (primary family; DejaVu ships on most Linux)"
    node src/swiss/swiss-gtkc.mjs src/App.jsx --out "$work/frontend.c" \
      --title "$name" --sig "$work/backend.sig.json" --font "$font"
  else
    node src/swiss/swiss-gtkc.mjs src/App.jsx --out "$work/frontend.c" \
      --title "$name" --sig "$work/backend.sig.json"
  fi

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
    windows) build_desktop windows   # native Win32: the .exe is already self-contained
             out="dist/${name}-windows"; rm -rf "$out"; mkdir -p "$out"
             cp "${name}.exe" "$out/"
             echo "swiss: native Win32 .exe is self-contained (system DLLs only) → $out/"
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
  gen_permissions   # swiss.json permissions -> .swiss/permissions/ manifest fragments
  case "$platform" in
    web) build_backend
         have npx || die "npx not found (install Node.js)"
         font=$(read_font)
         if [ -n "$font" ]; then
           mkdir -p public/fonts && cp "$LIB"/assets/fonts/*.ttf public/fonts/ 2>/dev/null || true
           echo "swiss: font \"$font\" (served from /fonts/, primary family)"
         fi
         echo "swiss: building frontend (vite)"
         VITE_SWISS_FONT="$font" npx vite build ;;
    linux|windows|macos) build_desktop "$platform" ;;   # GTK frontend, OS backend
    gtk|desktop)
         die "use an OS target, not '$platform': --platform linux|windows|macos (GTK is implicit on desktop). No --platform = host OS." ;;
    android) build_android ;;   # emit Gradle project + provision SDK/Gradle → APK
    ios|mobile)
         die "platform '$platform' not in v0.1 (web + desktop + android). iOS is a later milestone." ;;
    *)   die "unknown platform '$platform'" ;;
  esac
}

cmd_dev() {
  build_backend
  have npx || die "npx not found (install Node.js)"
  font=$(read_font)
  [ -n "$font" ] && { mkdir -p public/fonts && cp "$LIB"/assets/fonts/*.ttf public/fonts/ 2>/dev/null || true; }
  echo "swiss: starting dev server"
  VITE_SWISS_FONT="$font" npx vite
}

# Android target — JSX → Kotlin (swiss-androidc) over android.widget Views,
# emitted as a self-contained Gradle project. Like the GTK/Win32 emit we stop
# before the compiler: build.sh runs Gradle (needs the Android SDK) to finish.
# If the app calls the Ezy backend (ezy.call), the backend is emitted to C and
# built into a JNI .so (needs the NDK); otherwise the app is pure Kotlin.
emit_android() {
  out="$1"
  aname=$(basename "$PWD")
  # a valid Kotlin/Java package segment from the project name
  seg=$(printf '%s' "$aname" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9'); [ -n "$seg" ] || seg=app
  pkg="com.swiss.$seg"; pkgpath="com/swiss/$seg"
  appmain="$out/app/src/main"
  ktdir="$appmain/kotlin/$pkgpath"
  rm -rf "$out"; mkdir -p "$ktdir" "$out/gradle/wrapper"

  gen_permissions   # swiss.json permissions → .swiss/permissions/ (uses-permission lines)

  # does the app call into the Ezy backend?  → JNI native lib; else pure Kotlin
  backend=0
  grep -qE 'ezy\.call\(' src/App.jsx 2>/dev/null && backend=1

  # 1) frontend: React/JSX → Kotlin (MainActivity.kt)
  echo "swiss: frontend JSX → Kotlin  →  $ktdir/MainActivity.kt"
  sig="$out/.backend.sig.json"
  node src/swiss/swiss-sig.mjs backend/*.ez --out "$sig" || die "swiss-sig failed"
  node src/swiss/swiss-androidc.mjs src/App.jsx --out "$ktdir/MainActivity.kt" \
       --pkg "$pkg" --sig "$sig" || die "frontend translation failed"

  # 2) backend (only if called): Ezy → C + a JNI bridge → libswissbackend.so
  nativeblock=""
  if [ "$backend" = 1 ]; then
    echo "swiss: backend  Ezy → C + JNI  →  $appmain/cpp/"
    mkdir -p "$appmain/cpp"
    ezy emit-c backend/main.ez > "$appmain/cpp/backend.c" || die "ezy emit-c failed"
    sed -i 's/^int main(/int __ezy_backend_main(/' "$appmain/cpp/backend.c"
    node -e '
      const fs=require("fs"); const sig=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const pkg=process.argv[2].replace(/\./g,"_");
      const jt=t=>t==="string"?"jstring":t==="float"?"jdouble":"jlong";
      const ct=t=>t==="string"?"char*":t==="float"?"double":"long long";
      const esc=s=>s.replace(/_/g,"_1");
      let o=`#include <jni.h>\n#include <string.h>\n\n`;
      for(const f in sig){ const s=sig[f];
        o+=`extern ${ct(s.ret)} ${f}(`+(s.args.length?s.args.map(a=>a==="string"?"const char*":ct(a)).join(", "):"void")+`);\n`; }
      o+=`\n`;
      for(const f in sig){ const s=sig[f];
        const params=["JNIEnv* env","jclass clz"].concat(s.args.map((a,i)=>`${jt(a)} a${i}`)).join(", ");
        o+=`JNIEXPORT ${jt(s.ret)} JNICALL Java_${pkg}_MainActivityKt_${esc(f)}(${params}) {\n`;
        const conv=[],pre=[],post=[];
        s.args.forEach((a,i)=>{ if(a==="string"){ pre.push(`  const char* c${i} = (*env)->GetStringUTFChars(env, a${i}, 0);`); conv.push(`c${i}`); post.push(`  (*env)->ReleaseStringUTFChars(env, a${i}, c${i});`);} else conv.push(`a${i}`); });
        if(pre.length) o+=pre.join("\n")+"\n";
        const call=`${f}(${conv.join(", ")})`;
        if(s.ret==="string"){ o+=`  char* _r = ${call};\n`+(post.length?post.join("\n")+"\n":"")+`  return (*env)->NewStringUTF(env, _r ? _r : "");\n`; }
        else { o+=`  ${jt(s.ret)} _r = (${jt(s.ret)})${call};\n`+(post.length?post.join("\n")+"\n":"")+`  return _r;\n`; }
        o+=`}\n\n`;
      }
      fs.writeFileSync(process.argv[3], o);
    ' "$sig" "$pkg" "$appmain/cpp/jni_bridge.c" || die "JNI bridge generation failed"
    cat > "$appmain/cpp/CMakeLists.txt" <<'CM'
cmake_minimum_required(VERSION 3.18)
project(swissbackend C)
add_library(swissbackend SHARED backend.c jni_bridge.c)
CM
    nativeblock='
    ndkVersion "26.1.10909125"
    externalNativeBuild { cmake { path "src/main/cpp/CMakeLists.txt" } }'
  fi
  rm -f "$sig"

  # 3) Gradle project scaffolding (platform widgets only — no AndroidX needed)
  perms=""
  [ -f .swiss/permissions/android-manifest.xml ] && perms=$(cat .swiss/permissions/android-manifest.xml)

  cat > "$out/settings.gradle" <<EOF
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "$aname"
include ":app"
EOF

  cat > "$out/build.gradle" <<'EOF'
plugins {
    id "com.android.application" version "8.1.4" apply false
    id "org.jetbrains.kotlin.android" version "1.9.22" apply false
}
EOF

  cat > "$out/gradle.properties" <<'EOF'
android.useAndroidX=false
org.gradle.jvmargs=-Xmx2048m
kotlin.code.style=official
EOF

  cat > "$out/gradle/wrapper/gradle-wrapper.properties" <<'EOF'
distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\://services.gradle.org/distributions/gradle-8.5-bin.zip
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
EOF

  cat > "$out/app/build.gradle" <<EOF
plugins {
    id "com.android.application"
    id "org.jetbrains.kotlin.android"
}
android {
    namespace "$pkg"
    compileSdk 34
    defaultConfig {
        applicationId "$pkg"
        minSdk 21
        targetSdk 34
        versionCode 1
        versionName "1.0"
    }$nativeblock
    buildTypes { release { minifyEnabled false } }
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
EOF

  mkdir -p "$appmain"
  cat > "$appmain/AndroidManifest.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
$perms
    <application
        android:label="$aname"
        android:theme="@android:style/Theme.Material.Light.DarkActionBar">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
EOF

  cat > "$out/build.sh" <<'EOF'
#!/bin/sh
# Finish the Android build: assemble a debug APK with Gradle.
# Toolchain (like GTK's cc / Win32's MinGW): the Android SDK + Gradle (+ the NDK
# if the app calls the Ezy backend). Point ANDROID_SDK_ROOT/ANDROID_HOME at the
# SDK and have `gradle` on PATH (or drop a Gradle wrapper into this dir).
set -e
if [ -n "$ANDROID_SDK_ROOT" ]; then echo "sdk.dir=$ANDROID_SDK_ROOT" > local.properties
elif [ -n "$ANDROID_HOME" ]; then echo "sdk.dir=$ANDROID_HOME" > local.properties
else echo "build.sh: set ANDROID_SDK_ROOT or ANDROID_HOME to your Android SDK" >&2; fi
if [ -x ./gradlew ]; then G=./gradlew; else G=gradle; fi
"$G" assembleDebug
echo "built app/build/outputs/apk/debug/app-debug.apk"
EOF
  chmod +x "$out/build.sh"

  echo "swiss: done — Android Gradle project emitted, not built."
  echo "       frontend: $ktdir/MainActivity.kt   (Kotlin / android.widget)"
  [ "$backend" = 1 ] && echo "       backend:  $appmain/cpp/   (Ezy → C + JNI, built by the NDK)"
  echo "       compile:  (cd $out && ./build.sh)   # needs the Android SDK + Gradle"
}

# ── Android build toolchain (SDK + Gradle + optional NDK), auto-provisioned ──
# Swiss manages its own copies under ~/.ezy/swiss (like the win32 GTK sysroot),
# so a fresh machine can build an APK after y/n consent — no Android Studio.
SWISS_ANDROID_SDK="$HOME/.ezy/swiss/android-sdk"
SWISS_GRADLE_DIR="$HOME/.ezy/swiss/gradle-8.5"
SWISS_NDK_VER="26.1.10909125"
SWISS_CMDTOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
SWISS_GRADLE_URL="https://services.gradle.org/distributions/gradle-8.5-bin.zip"

fetch() {  # $1=url $2=out
  if   have curl; then curl -fL --retry 3 "$1" -o "$2"
  elif have wget; then wget -O "$2" "$1"
  else die "need curl or wget to download build tools"; fi
}

ensure_java() {
  have java && return 0
  ask_yn "Android builds need a JDK 17+. Install openjdk-17-jdk now? (sudo apt-get)" \
    || die "aborted. Install a JDK 17+ and re-run."
  have apt-get || die "no apt-get — install a JDK 17+ manually, then re-run."
  eval "sudo apt-get install -y openjdk-17-jdk" || die "JDK install failed"
}

# locate an Android SDK (env / ~/Android/Sdk / managed), install cmdline-tools if
# missing, then install+license the required packages. Exports ANDROID_SDK_ROOT.
# $1=1 → also install the NDK + cmake (backend/JNI apps).
ensure_android_sdk() {
  want_ndk="$1"
  ANDROID_SDK=""
  for d in "$ANDROID_SDK_ROOT" "$ANDROID_HOME" "$HOME/Android/Sdk" "$SWISS_ANDROID_SDK"; do
    [ -n "$d" ] && [ -d "$d" ] && { ANDROID_SDK="$d"; break; }
  done
  [ -n "$ANDROID_SDK" ] || ANDROID_SDK="$SWISS_ANDROID_SDK"

  sdkm=""
  for p in "$ANDROID_SDK/cmdline-tools/latest/bin/sdkmanager" "$ANDROID_SDK/cmdline-tools/bin/sdkmanager" "$ANDROID_SDK/tools/bin/sdkmanager"; do
    [ -x "$p" ] && sdkm="$p" && break
  done
  if [ -z "$sdkm" ]; then
    echo "swiss: Android SDK command-line tools not found." >&2
    ask_yn "Download them (~120MB) and set up the SDK under $SWISS_ANDROID_SDK?" \
      || die "aborted. Install the Android SDK + set ANDROID_SDK_ROOT, or re-run and accept."
    have unzip || die "need 'unzip' to install the SDK (apt-get install unzip)"
    ANDROID_SDK="$SWISS_ANDROID_SDK"; mkdir -p "$ANDROID_SDK/cmdline-tools"
    tmp=$(mktemp -d)
    echo "swiss: downloading Android command-line tools…"
    fetch "$SWISS_CMDTOOLS_URL" "$tmp/cmdtools.zip" || die "cmdline-tools download failed"
    ( cd "$tmp" && unzip -q cmdtools.zip ) || die "unzip failed"
    rm -rf "$ANDROID_SDK/cmdline-tools/latest"; mv "$tmp/cmdline-tools" "$ANDROID_SDK/cmdline-tools/latest"
    rm -rf "$tmp"
    sdkm="$ANDROID_SDK/cmdline-tools/latest/bin/sdkmanager"
  fi
  export ANDROID_SDK_ROOT="$ANDROID_SDK"; export ANDROID_HOME="$ANDROID_SDK"

  pkgs="platform-tools platforms;android-34 build-tools;34.0.0"
  [ "$want_ndk" = 1 ] && pkgs="$pkgs ndk;$SWISS_NDK_VER cmake;3.22.1"
  need=0
  [ -x "$ANDROID_SDK/platform-tools/adb" ] || need=1
  [ -d "$ANDROID_SDK/platforms/android-34" ] || need=1
  [ -d "$ANDROID_SDK/build-tools/34.0.0" ] || need=1
  if [ "$want_ndk" = 1 ]; then [ -d "$ANDROID_SDK/ndk/$SWISS_NDK_VER" ] || need=1; fi
  if [ "$need" = 1 ]; then
    ask_yn "Install Android SDK packages ($pkgs)? (~250MB, ~700MB more with NDK)" \
      || die "aborted. Install the packages via sdkmanager and re-run."
    yes | "$sdkm" --sdk_root="$ANDROID_SDK" --licenses >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    "$sdkm" --sdk_root="$ANDROID_SDK" $pkgs || die "sdkmanager package install failed"
  fi
}

# Gradle: system gradle if present, else a managed 8.5. Sets $GRADLE.
ensure_gradle() {
  have gradle && { GRADLE=gradle; return 0; }
  [ -x "$SWISS_GRADLE_DIR/bin/gradle" ] && { GRADLE="$SWISS_GRADLE_DIR/bin/gradle"; return 0; }
  ask_yn "Gradle is required to build. Download Gradle 8.5 (~130MB) into $SWISS_GRADLE_DIR?" \
    || die "aborted. Install gradle on PATH and re-run."
  have unzip || die "need 'unzip' (apt-get install unzip)"
  tmp=$(mktemp -d)
  echo "swiss: downloading Gradle 8.5…"
  fetch "$SWISS_GRADLE_URL" "$tmp/gradle.zip" || die "gradle download failed"
  ( cd "$tmp" && unzip -q gradle.zip ) || die "unzip failed"
  mkdir -p "$(dirname "$SWISS_GRADLE_DIR")"; rm -rf "$SWISS_GRADLE_DIR"; mv "$tmp/gradle-8.5" "$SWISS_GRADLE_DIR"; rm -rf "$tmp"
  GRADLE="$SWISS_GRADLE_DIR/bin/gradle"
}

# Android target — emit the Gradle project (emit_android), provision the SDK +
# Gradle (+ NDK for backend apps) with consent, then assemble a debug APK.
build_android() {
  [ -f swiss.json ] || die "no swiss.json — run inside a Swiss project"
  have ezy  || die "ezy not found on PATH"
  have node || die "node not found (the translator runs on Node at build time)"
  [ -d "$LIB" ] && copy_runtime src/swiss

  name=$(basename "$PWD")
  work=.swiss/android
  echo "swiss: emitting Android Gradle project → $work/"
  emit_android "$work"

  backend=0; grep -qE 'ezy\.call\(' src/App.jsx 2>/dev/null && backend=1
  ensure_java
  ensure_android_sdk "$backend"
  ensure_gradle
  echo "sdk.dir=$ANDROID_SDK_ROOT" > "$work/local.properties"

  echo "swiss: assembling APK (gradle assembleDebug) — first run fetches AGP/Kotlin…"
  ( cd "$work" && JAVA_HOME="${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")}" \
    "$GRADLE" --no-daemon assembleDebug ) || die "gradle build failed"
  apk=$(find "$work/app/build/outputs/apk/debug" -name '*.apk' 2>/dev/null | head -1)
  [ -n "$apk" ] || die "build finished but no APK was produced"
  cp "$apk" "./$name-debug.apk"
  echo "swiss: built ./$name-debug.apk"
  echo "       install on a device/emulator:  adb install -r $name-debug.apk"
}

# emit-app: produce a *source* copy of the project with everything lowered to C
# but NOT linked — the React/JSX frontend translated to the platform's native C
# (GTK or Win32) and the Ezy backend run through `ezy emit-c`. Same directory
# structure as the original, with .jsx/.ez replaced by the emitted .c. Stops
# before the compiler, so you get the app "compiled to C, not to a binary".
cmd_emit_app() {
  platform=$(host_os); out=""
  while [ $# -gt 0 ]; do
    case "$1" in
      app)        shift ;;                    # allow "swiss emit app ..."
      --platform) platform="$2"; shift 2 ;;
      --out)      out="$2"; shift 2 ;;
      *)          shift ;;
    esac
  done
  [ -f swiss.json ] || die "no swiss.json — run inside a Swiss project"
  have ezy  || die "ezy not found on PATH"
  have node || die "node not found (the translators run on Node)"
  case "$platform" in
    windows)     tr=win32c; gui="Win32"; mode=native ;;
    linux|macos) tr=gtkc;   gui="GTK";   mode=native ;;
    android)     tr=androidc; gui="Android"; mode=android ;;
    web)         gui="web";              mode=web ;;
    *)    die "emit-app: unknown platform '$platform' (use linux|windows|macos|android|web)" ;;
  esac

  # keep the project's runtime/translators in sync with the installed lib first
  [ -d "$LIB" ] && copy_runtime src/swiss

  name=$(basename "$PWD")
  [ -n "$out" ] || out="${name}-emit-${platform}"

  # android emits a full Gradle project (not a C-source mirror) — handle + return
  if [ "$mode" = android ]; then
    echo "swiss: emitting Android Gradle project → $out/  (platform: android)"
    emit_android "$out"
    return
  fi

  echo "swiss: emitting $gui source copy → $out/  (platform: $platform)"
  rm -rf "$out"; mkdir -p "$out"
  # mirror the project tree, minus build junk / the out dir / the translators
  tar --exclude=./.swiss --exclude=./node_modules --exclude=./dist --exclude=./.git \
      --exclude='./*-emit-*' --exclude="./$out" --exclude="./$name" --exclude="./$name.exe" \
      --exclude='*.o' --exclude='./src/swiss/*.mjs' -cf - . | ( cd "$out" && tar -xf - )

  # web: JSX stays JSX (no C). The copy already carries the swiss widget sources
  # under src/swiss/, and `from 'swiss'` resolves to them (vite alias). To *see*
  # the resulting code with the widgets inlined (App + View/Text/Button/… in one
  # place, React kept external), also emit a single readable esbuild bundle.
  if [ "$mode" = web ]; then
    # bundle App.jsx (not main.jsx) — App imports the widgets + react, but not the
    # wasm backend, so the bundle is exactly your component + the resolved widgets.
    entry=src/App.jsx; [ -f "$entry" ] || entry=$(ls src/*.jsx 2>/dev/null | grep -v main | head -1)
    if [ -n "$entry" ] && npx --no-install esbuild --version >/dev/null 2>&1; then
      echo "swiss: bundling $entry → $out/App.web.js  (widgets inlined, readable)"
      npx --no-install esbuild "$entry" --bundle --format=esm --jsx=automatic \
        --loader:.js=jsx \
        --alias:swiss=./src/swiss/swiss.js --alias:swiss/bridge=./src/swiss/swiss-bridge.js \
        --external:react --external:react-dom --external:react-dom/client --external:react/jsx-runtime --external:react-reconciler \
        --outfile="$out/App.web.js" \
        && echo "swiss: → $out/App.web.js  (App + swiss widgets resolved into one file)" \
        || echo "swiss: esbuild bundle skipped — widget sources are under $out/src/swiss/"
    else
      echo "swiss: esbuild not available — widget sources are readable under $out/src/swiss/"
    fi
    echo "swiss: done — web sources emitted (JSX + inlined widget code)."
    echo "       widgets: $out/src/swiss/*.js   (View/Text/Button/Input, reconciler, host)"
    echo "       preview: (cd $out && npx vite)"
    return
  fi

  # 1) backend: Ezy → C (recycle `ezy emit-c`); replace the .ez sources with it
  echo "swiss: backend  Ezy → C   →  $out/backend/main.c"
  ezy emit-c backend/main.ez > "$out/backend/main.c" || die "ezy emit-c failed"
  rm -f "$out"/backend/*.ez

  # 2) frontend: React/JSX → native $gui C (build-time Node translator)
  echo "swiss: frontend JSX → $gui C  →  $out/src/App.c"
  sig="$out/.backend.sig.json"
  font=$(read_font)
  node src/swiss/swiss-sig.mjs backend/*.ez --out "$sig" || die "swiss-sig failed"
  if [ -n "$font" ]; then
    [ "$platform" = windows ] && ship_fonts "$out"   # bundled .ttf next to the exe
    echo "swiss: font \"$font\""
    node "src/swiss/swiss-${tr}.mjs" src/App.jsx --out "$out/src/App.c" \
         --title "$name" --sig "$sig" --font "$font" || die "frontend translation failed"
  else
    node "src/swiss/swiss-${tr}.mjs" src/App.jsx --out "$out/src/App.c" \
         --title "$name" --sig "$sig" || die "frontend translation failed"
  fi
  rm -f "$sig" "$out/src/App.jsx"

  # Win32 needs the POSIX shim + a themed/DPI manifest to compile; emit them too
  if [ "$platform" = windows ]; then
    mkdir -p "$out/src/swiss"
    cp src/swiss/swiss-winshim.c "$out/src/swiss/" 2>/dev/null || true
    cat > "$out/app.manifest" <<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency><dependentAssembly><assemblyIdentity
    type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0"
    processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
  </dependentAssembly></dependency>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2, PerMonitor</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>
XML
    printf '1 24 "app.manifest"\n' > "$out/app.rc"
  fi

  # 3) a build recipe to finish the last (linking) step by hand — we stop here
  if [ "$platform" = windows ]; then
    cat > "$out/build.sh" <<EOF
#!/bin/sh
# finish the Win32 build: compile the emitted C (no Swiss/Node needed).
set -e
CC=\${CC:-x86_64-w64-mingw32-gcc}
WINDRES=\${WINDRES:-x86_64-w64-mingw32-windres}
"\$WINDRES" app.rc -o manifest.o
"\$CC" src/App.c backend/main.c src/swiss/swiss-winshim.c manifest.o -o "$name.exe" \\
  -mwindows -static \\
  -luser32 -lgdi32 -lcomctl32 -lcomdlg32 -lshell32 -lole32 -lgdiplus -luxtheme -lwinpthread -lm
echo "built ./$name.exe"
EOF
  else
    cat > "$out/build.sh" <<EOF
#!/bin/sh
# finish the GTK build: compile the emitted C (no Swiss/Node needed).
set -e
CC=\${CC:-cc}
"\$CC" src/App.c backend/main.c \$(pkg-config --cflags --libs gtk+-3.0) -lm -o "$name"
echo "built ./$name"
# note: if the backend imports native EzyLibs (e.g. sqlite), add their -l/-L flags.
EOF
  fi
  chmod +x "$out/build.sh"

  echo "swiss: done — C sources emitted, not linked."
  echo "       backend:  $out/backend/main.c   (ezy emit-c)"
  echo "       frontend: $out/src/App.c        ($gui)"
  echo "       compile:  (cd $out && ./build.sh)"
}

case "$1" in
  new)     scaffold "$2" ;;
  build)    shift; cmd_build "$@" ;;
  package)  shift; cmd_package "$@" ;;
  emit-app) shift; cmd_emit_app "$@" ;;
  emit)     shift; cmd_emit_app "$@" ;;   # `swiss emit app [--platform ...]`
  dev)      cmd_dev ;;
  perms)   gen_permissions; cat .swiss/permissions/android-manifest.xml 2>/dev/null ;;
  *)
    echo "swiss — one React frontend + Ezy backend, many targets"
    echo "usage:"
    echo "  swiss new <name>                 scaffold a Swiss app"
    echo "  swiss dev                        web dev server (vite + wasm backend)"
    echo "  swiss build                      desktop GTK app for the host OS"
    echo "  swiss build --platform linux     desktop GTK app (linux)"
    echo "  swiss build --platform windows   native Win32 .exe (no GTK, system DLLs only)"
    echo "  swiss build --platform macos     desktop GTK app (macOS)"
    echo "  swiss build --platform android   Android APK (auto-provisions SDK/Gradle/NDK, y/n)"
    echo "  swiss build --platform web       web build (React DOM + wasm) → dist/"
    echo "  swiss package [--platform OS]    build + bundle a distributable (deps included)"
    echo "  swiss emit-app [--platform OS]   copy the project with JSX+Ezy lowered to C (not linked)"
    echo "  swiss emit-app --platform android  emit a Gradle project (JSX→Kotlin, backend→JNI)"
    echo "  swiss emit-app --platform web    copy + readable bundle with the swiss widgets inlined"
    echo "  (GTK is implicit on desktop; the OS picks the backend compile target)"
    exit 1 ;;
esac
