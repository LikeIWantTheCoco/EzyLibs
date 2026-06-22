# Swiss CRUD + SQLite (desktop GTK)

Full-screen product manager: two tabs (Productos = CRUD list, Configuración =
folder picker + dark/light Switch), products persisted in SQLite, loaded on
open. Exercises the v0.2 GTK translator: `useEffect`, `Input`/`onChange`,
`Switch`, `Tabs`/`Tab`, dynamic `List` (rebuilt on a count cell) with per-row
Editar/Borrar handlers, `swiss.pickFolder()` (GtkFileChooser), `swiss.setTheme()`,
component helper functions, `int()`/`str()`.

```bash
swiss new shop
# replace src/App.jsx + backend/main.ez with these
npm install
swiss build          # native GTK binary (links the sqlite EzyLib via FFI)
./shop
```

Backend = native-typed Ezy using the `sqlite` EzyLib; the list crosses the FFI
as scalars (count + indexed getters), no JSON. Desktop/native only (SQLite is an
ELF lib — it doesn't cross-compile to wasm/windows).
