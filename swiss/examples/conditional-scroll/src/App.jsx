import { useState } from 'react';
import { View, Text, Button, ScrollView, StyleSheet } from 'swiss';

export default function App() {
  const [n, setN] = useState(0);
  return (
    <View style={styles.box}>
      <Text style={styles.h1}>Fase 1</Text>
      <View style={styles.row}>
        <Button title="-" onPress={() => setN(n - 1)} />
        <Text style={styles.num}>{n}</Text>
        <Button title="+" onPress={() => setN(n + 1)} />
      </View>
      <Text>{n % 2 == 0 ? "par" : "impar"}</Text>
      {n > 0 && <Text style={styles.pos}>positivo</Text>}
      {n > 3 ? <Text style={styles.big}>mayor que 3</Text> : <Text>3 o menos</Text>}
      <ScrollView style={styles.scroll}>
        <Text>fila 1</Text><Text>fila 2</Text><Text>fila 3</Text><Text>fila 4</Text>
        <Text>fila 5</Text><Text>fila 6</Text><Text>fila 7</Text><Text>fila 8</Text>
        <Text>fila 9</Text><Text>fila 10</Text><Text>fila 11</Text><Text>fila 12</Text>
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  box: { padding: 20, gap: 10, alignItems: 'center' },
  h1: { fontSize: 24, fontWeight: 'bold' },
  row: { flexDirection: 'row', gap: 12 },
  num: { fontSize: 18 },
  pos: { color: 'lightgreen' },
  big: { fontSize: 18, fontWeight: 'bold' },
  scroll: { height: 120 },
});
