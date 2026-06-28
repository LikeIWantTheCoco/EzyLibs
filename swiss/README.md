# Swiss

**One React/JSX frontend + one Ezy backend → many native targets.**

You write your UI once in React (`<View>`, `<Text>`, `<Button>`, …) and your
logic once in Ezy (compiled to native C / wasm). Swiss renders that UI to each
platform's real widgets and bridges the two.

The **platform is the OS**, not the renderer. Desktop OSes (linux/windows/macos)
use GTK implicitly; `web` uses the DOM. Swiss compiles the Ezy backend for that
OS automatically.

```bash
swiss build                      # desktop app for the HOST os (GTK on linux/macos)
swiss build --platform linux     # desktop GTK (linux)
swiss build --platform windows   # NATIVE Win32 .exe (no GTK, system DLLs only)
swiss build --platform macos     # desktop GTK (macOS)
swiss build --platform web       # React DOM + Ezy wasm → dist/
swiss package --platform windows # build + zip the self-contained .exe (no DLLs to bundle)
swiss package --platform linux   # build + bundle ELF + its .so closure
swiss dev                        # web dev server (vite)
```

`swiss package` produces a distributable. **Windows is native Win32**, so the
`.exe` already links only system DLLs — packaging just drops it in
`dist/<name>-windows/` and zips it (nothing to bundle). The **linux/macos** GTK
builds run **without GTK installed** by bundling the `ldd` closure + a launcher.

Desktop builds reuse **ezy's** cross toolchain (`ezy toolchain --platform X` →
the C compiler, auto-installing MinGW/NDK/osxcross with consent). For **linux/
macos** the **GTK3 SDK** is offered the same way: if missing, `swiss build` asks
`y/N` and installs it (`libgtk-3-dev` / `gtk3-devel` / `gtk+3`, by package
manager); set `SWISS_GTK_SYSROOT` for a cross target with no clean distro
package. The **windows** target needs no GTK at all — just MinGW (which ezy
provisions), since the frontend is native Win32.

| Platform | Frontend | Backend | Status |
|----------|----------|---------|--------|
| `web` | React → **DOM** (runtime reconciler) | Ezy → wasm (typed ccall) | ✅ v0.1 |
| `linux` (host) | React → **GTK C** (build-time translator) | Ezy → native, FFI in-process | ✅ v0.1 |
| `windows` | React → **native Win32 C** (build-time translator) | Ezy → native (cross, MinGW) | ✅ v0.1 |
| `macos` | React → GTK C | Ezy → native (cross) | ◐ toolchain reused; needs target GTK SDK |
| `android` | React → Android Views (JNI) | Ezy → `.so` (NDK) | ⏳ planned |
| `ios` | React → UIKit (FFI) | Ezy → static lib | ⏳ planned |

**Three translation strategies, by design:**

- **Web = runtime reconciler.** React + `react-reconciler` run in the browser; a
  HostConfig builds DOM. JSON bridge over wasm `ccall` (carries objects/arrays).
- **GTK = build-time translator (`swiss-gtkc.mjs`).** React/JSX is compiled to
  standalone GTK3 C — **no JS engine in the app**. React semantics are lowered to
  native imperative code (Svelte-style: `useState`→struct cell, `setState`→update
  only the widgets that read it). `ezy.call('f')` → a direct C call into the Ezy
  backend linked in-process (native types, no marshalling). One native binary.
  Used for linux/macos desktop.
- **Win32 = build-time translator (`swiss-win32c.mjs`).** Same Svelte-style
  lowering, but emits **native Win32 C** — `<Button>`→`CreateWindow("BUTTON")`,
  `setState`→`SetWindowText`/`SendMessage` on just the controls that read the
  cell. Win32 has no box layout, so the app carries a tiny runtime stack/flex
  **layout engine** (a node tree re-laid-out on `WM_SIZE`). The `.exe` links only
  the Windows **system DLLs** (user32/gdi32/comctl32/comdlg32/shell32/ole32) — so
  it's a single self-contained binary: **no GTK SDK to install, no DLL bundle.**

  Subset (v0.1): View/Text/Button/Input/TextArea/Checkbox/Switch/Select/Slider/
  ProgressBar/Separator/Image/List, `useState`/`useMemo`/`useEffect`/`useRef`,
  derived consts, helper methods, presentational components, `{expr}` text,
  `{cond && <X/>}` / `{a ? <X/> : <Y/>}`, `{arr.map(...)}`, `onPress`/`onChange`,
  reactive text/label/disabled/visibility, `int()`/`str()`/`Math.*`, string
  methods, `setInterval`/`setTimeout`. Styles: padding/gap/flexDirection/width/
  height/flex/align/justify + fontSize/fontWeight/color/backgroundColor.

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

## Native device access (the `os` layer)

Device access — files & paths, file pickers, notifications, clipboard,
brightness, battery, screen, **permissions, GPS, motion sensors, background
tasks** — goes through **one** API, the `os` library family. This is the only
sanctioned way; don't shell out or call platform APIs directly from an app.

**Native targets (desktop/mobile)** — in your Ezy backend:

```ezy
import "swiss-native.ez"          # the facade over the os libs (auto-links them)

fn save(text: string) -> int:
{
    p = swiss_save_dialog("Save", "note.txt")
    if p.len() == 0: { return 0 }
    swiss_write(p, text) ; swiss_notify("Saved", p) ; return 1
}
fn locate() -> string:            # permission-gated
{
    if swiss_request("location") == 0: { return "" }
    return swiss_location()
}
```

**Web target** — the same surface from JS (native C libs aren't in wasm):

```js
import { native } from 'swiss';
await native.request('notifications');
native.notify('Hi', 'from the web');
const loc = await native.location();
```

### Permissions — declare them twice

Every permission an app uses must be declared in **both** places:

1. **`swiss.json` `"permissions"`** — build-time. `swiss build` emits the
   platform manifests from this (`.swiss/permissions/android-manifest.xml`
   `<uses-permission>` + `ios-info.plist` usage keys / `UIBackgroundModes`).
   Preview with `swiss perms`.
2. **At runtime** — `swiss_request("location")` (backend) or
   `native.request('location')` (web), before using the capability.

```json
// swiss.json
{ "permissions": ["location", "activity", "background", "notifications"] }
```

Names: `location camera microphone storage notifications contacts activity
bluetooth background`. On desktop everything is granted (no runtime model);
mobile shows the system prompt. Background work (`swiss_bg_every`, …) needs the
`"background"` permission on mobile.
