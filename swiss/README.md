# Swiss

**One React/JSX frontend + one Ezy backend → many native targets.**

You write your UI once in React (`<View>`, `<Text>`, `<Button>`, …) and your
logic once in Ezy (compiled to native C / wasm). Swiss renders that UI to each
platform's real widgets and bridges the two.

The **platform is the OS**, not the renderer. Desktop OSes (linux/windows/macos)
use GTK implicitly; `web` uses the DOM. Swiss compiles the Ezy backend for that
OS automatically.

```bash
swiss build                      # desktop GTK app for the HOST os
swiss build --platform linux     # desktop GTK (linux)
swiss build --platform windows   # desktop GTK (.exe)
swiss build --platform macos     # desktop GTK (macOS)
swiss build --platform web       # React DOM + Ezy wasm → dist/
swiss package --platform windows # build + bundle a self-contained .exe (DLLs incl.)
swiss package --platform linux   # build + bundle ELF + its .so closure
swiss dev                        # web dev server (vite)
```

`swiss package` produces a distributable that runs **without GTK installed**:
on windows it copies the recursive DLL closure (via `objdump`) + GTK data + a
font next to the `.exe` (→ `dist/<name>-windows/` and a `.zip`); on linux it
bundles the `ldd` closure + a launcher. The windows GTK3 SDK itself is
auto-provisioned on first cross build (MSYS2 closure → `~/.ezy/swiss/sysroot/`).

Desktop builds reuse **ezy's** cross toolchain (`ezy toolchain --platform X` →
the C compiler, auto-installing MinGW/NDK/osxcross with consent) and the **GTK3
SDK** is offered the same way: if missing, `swiss build` asks `y/N` and installs
it (`libgtk-3-dev` / `gtk3-devel` / `gtk+3` / mingw GTK3, by package manager).
A cross target with no clean distro package: set `SWISS_GTK_SYSROOT` to a GTK3
sysroot (MSYS2 mingw64 / gvsbuild / MXE).

| Platform | Frontend | Backend | Status |
|----------|----------|---------|--------|
| `web` | React → **DOM** (runtime reconciler) | Ezy → wasm (typed ccall) | ✅ v0.1 |
| `linux` (host) | React → **GTK C** (build-time translator) | Ezy → native, FFI in-process | ✅ v0.1 |
| `windows` / `macos` | React → GTK C | Ezy → native (cross) | ◐ toolchain reused; needs target GTK SDK |
| `android` | React → Android Views (JNI) | Ezy → `.so` (NDK) | ⏳ planned |
| `ios` | React → UIKit (FFI) | Ezy → static lib | ⏳ planned |

**Two translation strategies, by design:**

- **Web = runtime reconciler.** React + `react-reconciler` run in the browser; a
  HostConfig builds DOM. JSON bridge over wasm `ccall` (carries objects/arrays).
- **GTK = build-time translator (`swiss-gtkc.mjs`).** React/JSX is compiled to
  standalone GTK3 C — **no JS engine in the app**. React semantics are lowered to
  native imperative code (Svelte-style: `useState`→struct cell, `setState`→update
  only the widgets that read it). `ezy.call('f')` → a direct C call into the Ezy
  backend linked in-process (native types, no marshalling). One native binary.

  Subset (v0.1): function component, `useState`, `View/Text/Button`, `{expr}`
  text, `onPress`; handlers limited to `setX(<simple expr | ezy.call>)`.

## Architecture

Swiss is built like React Native: **React + a custom `react-reconciler` +
one HostConfig per platform.** Your components (`View`/`Text`/…) are
platform-agnostic; only the HostConfig changes.

```
        App.jsx   (imports View/Text/Button from 'swiss' — never <div>)
                          │
              React + react-reconciler          ← shared by every target
                          │  createInstance / commitUpdate / …
        ┌─────────────────┼──────────────────┬───────────────┐
        ▼                 ▼                  ▼               ▼
   host-web (DOM)    host-gtk (C)      host-android (JNI)   …
```

v0.1 ships **only `host-web`** (`swiss-host-web.js`). The reconciler, the
components, the bridge, `StyleSheet`, and the CLI are all reused unchanged when
native HostConfigs land — web is the first backend, not a throwaway.

## Bridge (frontend ↔ Ezy)

Every exported Ezy function uses one signature so objects/arrays cross the wasm
boundary as JSON (scalars alone can't carry records):

```ezy
# backend/main.ez
fn name(req: string) -> string   # req = JSON array of args; return = JSON value
```

```jsx
import { connectEzy } from 'swiss';
import EzyModule from './backend.js';        // ezy compile --platform web-esm

const ezy = await connectEzy(EzyModule);
const n   = await ezy.call('bump');           // JSON.parse'd return
await ezy.call('save', { name, age });        // args JSON.stringify'd
```

## Quick start

```bash
ezyl install swiss          # installs the runtime + the `swiss` CLI
swiss new myapp
cd myapp && npm install
swiss dev                   # compiles backend → wasm, runs Vite
swiss build --platform web  # production build → dist/
```

## Components (v0.1)

`View` `Text` `Button` `Input` `FlatList` + `StyleSheet`. Styles use the
RN-ish subset (flex layout, padding/margin, fontSize, colors) so the same keys
port to native widget props later. `View` defaults to a flex column.

## Status

v0.1 — web target end-to-end (reconciler verified under jsdom; bridge verified
against a real Ezy wasm build). Native HostConfigs (GTK first) are the next
milestone.
