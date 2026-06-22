# Swiss — render condicional + ScrollView (Fase 1 del traductor GTK)

Demo de las capacidades añadidas en v0.3 del traductor GTK:
- Ternario en texto `{n % 2 == 0 ? "par" : "impar"}`.
- Render condicional `{n > 0 && <Text>positivo</Text>}` (muestra/oculta reactivo).
- Ternario de elementos `{n > 3 ? <A/> : <B/>}`.
- `<ScrollView>` (GtkScrolledWindow).
- Layout: `alignItems`, `flex`, `width`/`height`, `margin` en StyleSheet.

```bash
swiss new demo
# reemplaza src/App.jsx + backend/main.ez por estos
npm install
swiss build && ./demo
```
