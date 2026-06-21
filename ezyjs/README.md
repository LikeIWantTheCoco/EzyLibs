# ezyjs — JS ↔ Ezy connection library

Call Ezy functions from JavaScript with one small library, two backends and the
same `app.call(fn, ...args)` API:

| Backend | Runs Ezy as | Where | Ezy side |
|---------|-------------|-------|----------|
| **Node bridge** | a native binary, line-RPC over stdio | Node / desktop / server | `#include "bridge.ez"` + `rpc_serve()` |
| **wasm wrapper** | WebAssembly (emscripten) | browser / Node | plain exported `fn`s |

`ezy.js` is the whole library; the Ezy program is the heavy lifting (compiled to
native or wasm) — no fat glue to hand-edit.

## Node bridge (like python-bridge: spawn the process, talk over stdio)

`bridge.ez` gives you a tiny RPC server. Handlers take a `[int]` and return `int`:

```ezy
#include "bridge.ez"
n = 1
fn bump(args: [int]) -> int: { global n  n = n + 1  return n }
fn add(args: [int]) -> int:  { return args[0] + args[1] }
fn main(): { rpc_register("bump", bump)  rpc_register("add", add)  rpc_serve() }
```

```bash
ezy compile counter.ez -o counter      # native binary
```

```js
const Ezy = require('./ezy.js');
const app = Ezy.spawn('./counter');
await app.call('bump');        // 2, 3, 4 …  (state lives in the Ezy process)
await app.call('add', 2, 3);   // 5
app.close();
```

## wasm wrapper (browser)

Plain functions, exported automatically; the wasm path calls them by name:

```ezy
n = 1
fn bump() -> int: { global n  n = n + 1  return n }
fn add(a: int, b: int) -> int: { return a + b }
```

```bash
ezy compile --release --platform web math.ez -o math   # → math.js (16K) + math.wasm (12K)
```

The web build is a single self-contained `.js` (the wasm is embedded), so there
is **no `.wasm` file and no web server needed** — just open the HTML:

```html
<script src="math.js"></script>     <!-- EzyModule factory, wasm embedded -->
<script src="ezy.js"></script>
<script>
  Ezy.wasm(EzyModule).then((app) => console.log(app.call('add', 2, 3)));  // 5
</script>
```

## Notes

- Ezy `int` is 64-bit → it crosses the JS boundary as `BigInt`; `ezy.js` marshals
  numbers for you on the wasm path.
- Node handlers use a uniform `(args: [int]) -> int` shape (so `rpc_serve` can
  dispatch by name); wasm calls the real function signature directly.
- `flush()` (built-in) pushes a response immediately — `rpc_serve` calls it.
- Use `--release` for web: size-optimized + Closure-minified (≈5× smaller).
