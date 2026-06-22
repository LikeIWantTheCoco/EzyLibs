# Swiss — todo list (array de objetos en estado + .map idiomático)

Demuestra el modelo de colección del traductor GTK (v0.5): `useState([])` →
array dinámico de un struct inferido; `setTodos([...todos, {id, label}])` (push),
`todos.map(t => <Row/>)` (lista reactiva), `todos.filter(t => t.id != id)`
(borrar), `todos.length`. Sin backend ni FFI de arrays — colección en memoria.

```bash
swiss new todo && cd todo && npm install
# reemplaza src/App.jsx por este
swiss build && ./todo
```
