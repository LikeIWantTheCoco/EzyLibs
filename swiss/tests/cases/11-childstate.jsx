import { useState, useEffect } from 'react';
import { View, Text, Button, StyleSheet } from 'swiss';

// a child component with its OWN state + effect + a prop + children
function Panel({ title, children }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { /* mount */ }, []);
  return (<View style={styles.panel}>
    <Button title={title} onPress={() => setOpen(!open)} style={styles.head} />
    {open && <View style={styles.body}>{children}</View>}
  </View>);
}

export default function App() {
  const [n, setN] = useState(0);
  return (<View style={styles.app}>
    <Text style={styles.h}>Panels</Text>
    <Panel title="First">
      <Text>hello from first</Text>
    </Panel>
    <Panel title="Second">
      <Button title={'bump ' + n} onPress={() => setN(n + 1)} style={styles.head} />
    </Panel>
  </View>);
}

const styles = StyleSheet.create({
  app: { padding: 16, gap: 8, backgroundColor: '#fff' },
  h: { fontSize: 20, fontWeight: 'bold' },
  panel: { gap: 4, borderRadius: 6, borderWidth: 1, borderColor: '#ddd', padding: 8 },
  head: { backgroundColor: '#2563eb', color: 'white', padding: 8, borderRadius: 6 },
  body: { padding: 8, backgroundColor: '#f5f5f5', borderRadius: 6 },
});
