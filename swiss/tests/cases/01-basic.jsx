import { useState } from 'react';
import { View, Text, Button, Input, StyleSheet } from 'swiss';
export default function App() {
  const [t, setT] = useState('hi');
  return (<View style={styles.app}>
    <Text style={styles.h}>Basic</Text>
    <Input value={t} onChange={setT} placeholder="type..." style={{ padding: 8 }} />
    <Button title="Clear" onPress={() => setT('')} style={styles.b} />
  </View>);
}
const styles = StyleSheet.create({
  app: { padding: 16, gap: 8, backgroundColor: '#fff' },
  h: { fontSize: 20, fontWeight: 'bold' },
  b: { backgroundColor: '#2563eb', color: 'white', padding: 8, borderRadius: 6, width: 120 },
});
