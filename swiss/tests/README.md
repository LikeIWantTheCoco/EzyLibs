# Swiss test harness

Regression check: every case in `cases/*.jsx` is emitted to each target and
compiled, so a change that breaks one target is caught before it ships.

```sh
sh tests/run.sh              # linux + windows + web
sh tests/run.sh linux web    # a subset
```

- **linux** (GTK) / **windows** (Win32): `swiss emit-app` then compile the emitted C.
- **web**: `swiss emit-app --platform web` then check the readable bundle built.

Deps (react/@babel/parser/esbuild/vite) install once into `template/node_modules`.
Add a `cases/NN-name.jsx` (a default-exported `App`) to cover a new feature.
