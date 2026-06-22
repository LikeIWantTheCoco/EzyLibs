# Swiss counter — one App.jsx, web + GTK

The SAME `src/App.jsx` and `backend/main.ez` build to either target. `App.jsx`
imports `{ ezy } from 'swiss'` and calls `ezy.call('bump')` synchronously; the
backend is plain native-typed Ezy (`fn bump() -> int`).

```bash
swiss new mycounter        # scaffolds exactly this
cd mycounter && npm install

swiss build --platform web    # React → DOM (reconciler) + Ezy → wasm (typed ccall)
swiss build --platform gtk    # React → GTK C (translator) + Ezy → native (FFI); → ./mycounter
```

`swiss-sig.mjs` extracts the backend signatures once; the web bridge uses them
to type the wasm `ccall`, the GTK translator to type the C `extern`. That shared
signature is what lets one frontend + one backend serve both targets.
