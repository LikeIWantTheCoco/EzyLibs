# Swiss — widgets + composición (Fases 2-4 del traductor GTK)

Showcase de v0.4: Checkbox, Slider, ProgressBar, Select, Separator (+ Image/
TextArea disponibles), estilos backgroundColor/borderRadius/align, useState con
init no literal (`ezy.call`), métodos de string (`.trim().toUpperCase().length`),
`useEffect`, render condicional, y un **componente propio con props** (`Badge`)
dentro de un **Fragment** raíz.

```bash
swiss new demo && cd demo && npm install
# reemplaza src/App.jsx + backend/main.ez por estos
swiss build && ./demo
```

Pendiente (futuro): arrays/objetos en estado + `.map` idiomático (hoy se usa el
componente `<List count item>` para colecciones).
