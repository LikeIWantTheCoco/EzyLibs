import { useState } from 'react';
import { View, Text, Button, StyleSheet, ezy } from 'swiss';

// Counter logic lives in Ezy (backend/main.ez); React just renders.
export default function App() {
  const [n, setN] = useState(0);
  return (
    <View style={styles.box}>
      <Text style={styles.title}>Swiss counter</Text>
      <Text>Count: {n}</Text>
      <Button title="+1" onPress={() => setN(ezy.call('bump'))} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { padding: 24, gap: 12 },
  title: { fontSize: 24, fontWeight: 'bold' },
});
