import { useState } from 'react';
import { View, Text, Button, Input, StyleSheet } from 'swiss';

export default function App() {
  const [todos, setTodos] = useState([]);
  const [text, setText] = useState('');
  const [nextId, setNextId] = useState(1);

  const add = () => {
    if (text.trim().length > 0) {
      setTodos([...todos, { id: nextId, label: text }]);
      setNextId(nextId + 1);
      setText('');
    }
  };
  const remove = (id) => { setTodos(todos.filter(t => t.id != id)); };

  return (
    <View style={styles.box}>
      <Text style={styles.h1}>Todos ({todos.length})</Text>
      <View style={styles.row}>
        <Input value={text} onChange={setText} placeholder="Nueva tarea" />
        <Button title="Anadir" onPress={add} />
      </View>
      {todos.map(t => (
        <View style={styles.item}>
          <Text style={styles.lbl}>{t.label}</Text>
          <Button title="x" onPress={() => remove(t.id)} />
        </View>
      ))}
    </View>
  );
}
const styles = StyleSheet.create({
  box: { padding: 20, gap: 8, width: 460 },
  h1: { fontSize: 22, fontWeight: 'bold' },
  row: { flexDirection: 'row', gap: 8 },
  item: { flexDirection: 'row', gap: 12 },
  lbl: { fontSize: 16 },
});
