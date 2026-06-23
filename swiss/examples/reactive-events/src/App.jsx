import { useState } from 'react';
import { View, Text, Button, Input, StyleSheet } from 'swiss';

export default function App() {
  const [active, setActive] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [key, setKey] = useState('sin evento');

  return (
    <View style={styles.box}>
      <Button title={active ? "ON" : "OFF"} style={active ? styles.on : styles.off} onPress={() => setActive(!active)} />
      <Button title="pasa el mouse" style={[styles.card, hovered && styles.cardHover]}
        onMouseEnter={() => setKey("hover ON")} onMouseLeave={() => setKey("hover OFF")} />
      <Input placeholder="escribe aqui" onKeyDown={() => setKey("tecla presionada")} />
      <Button title="doble click aqui" onDoubleClick={() => setKey("doble click!")} />
      <Text style={styles.h}>{key}</Text>
    </View>
  );
}
const styles = StyleSheet.create({
  box: { padding: 18, gap: 10, width: 460 },
  on: { backgroundColor: '#0a84ff', color: 'white', fontWeight: 'bold' },
  off: { backgroundColor: '#555', color: '#ccc' },
  card: { padding: 14, backgroundColor: '#333', color: 'white' },
  cardHover: { backgroundColor: '#a0309f', color: 'white' },
  h: { fontSize: 18, fontWeight: 'bold' },
});
