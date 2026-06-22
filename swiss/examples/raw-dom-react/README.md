# Swiss — React DOM crudo → GTK3

El traductor GTK acepta JSX de React DOM estándar (sin componentes Swiss):
tags HTML (`div/h1/p/form/input/button/...`), estilos inline `style={{…}}`,
`e.target.value` en onChange, `<form onSubmit>`, `type="submit"`,
`e.preventDefault()`. Pega React normal y compila a un binario GTK nativo.

```bash
swiss new search && cd search && npm install
# pega cualquier componente React DOM en src/App.jsx
swiss build && ./search
```

Mapeo: div/section/form→GtkBox, h1-h6/p/span/label→GtkLabel (h* bold), input→
GtkEntry, button→GtkButton, img→GtkImage, hr→GtkSeparator. Estilos inline:
padding/margin/width/maxWidth/fontSize/color/backgroundColor/border/borderRadius/
textAlign → CSS provider + APIs GTK. `margin:'0 auto'`→centrado, `width:'100%'`→
expand.
