# Swiss — estilos reactivos + eventos (GTK)

- Estilo reactivo: `style={cond ? styles.a : styles.b}` y `style={[base, cond && styles.x]}` → swap de clase CSS al cambiar el estado.
- Título reactivo de Button: `title={active ? "ON" : "OFF"}`.
- Eventos: `onMouseEnter/onMouseLeave`, `onKeyDown`, `onFocus/onBlur`, `onDoubleClick` (en widgets con ventana: Button/Input).

`swiss build && ./reactive-events`
