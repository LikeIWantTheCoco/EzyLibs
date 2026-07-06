#!/bin/sh
# Swiss regression harness — for every case in cases/*.jsx, emit the app to each
# target and compile it. Catches a change breaking any target before it ships.
#
#   sh tests/run.sh                 # all targets (linux, windows, web)
#   sh tests/run.sh linux web       # only the named targets
#
# Requires: swiss on PATH, ezy + a MinGW toolchain (windows), GTK3 dev (linux),
# node/npm (web bundle). node_modules is installed once into tests/template.
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TMPL="$DIR/template"
CASES="$DIR/cases"
TARGETS=${*:-"linux windows web"}

command -v swiss >/dev/null || { echo "run.sh: 'swiss' not on PATH"; exit 2; }

# one-time deps for the template (react/babel/esbuild/vite) — cached
if [ ! -d "$TMPL/node_modules" ]; then
  echo "run.sh: installing template deps (once)…"
  ( cd "$TMPL" && npm install --silent --no-audit --no-fund ) || { echo "npm install failed"; exit 2; }
fi

pass=0; fail=0; fails=""
for c in "$CASES"/*.jsx; do
  name=$(basename "$c" .jsx)
  work=$(mktemp -d)
  cp -a "$TMPL"/. "$work"/
  ln -snf "$TMPL/node_modules" "$work/node_modules"
  cp "$c" "$work/src/App.jsx"
  for plat in $TARGETS; do
    out="emit-$plat"
    r="FAIL"
    if ( cd "$work" && swiss emit-app --platform "$plat" --out "$out" ) >/dev/null 2>&1; then
      if [ "$plat" = web ]; then
        [ -s "$work/$out/App.web.js" ] && r="ok"
      elif [ "$plat" = android ]; then
        # no Android SDK in CI → emit-only check (the .kt was produced), like web
        [ -n "$(find "$work/$out" -name MainActivity.kt 2>/dev/null)" ] && r="ok"
      else
        if ( cd "$work/$out" && ./build.sh ) >/dev/null 2>&1; then r="ok"; fi
      fi
    else
      r="EMIT-FAIL"
    fi
    printf '  %-14s %-8s %s\n' "$name" "$plat" "$r"
    if [ "$r" = "ok" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); fails="$fails $name/$plat"; fi
  done
  rm -rf "$work"
done

echo "──────────────────────────────"
echo "pass: $pass   fail: $fail"
[ -n "$fails" ] && { echo "failed:$fails"; exit 1; }
echo "all green"
