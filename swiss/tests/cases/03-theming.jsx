import { useState } from 'react';
import { View, Text, Button, StyleSheet, setTheme } from 'swiss';
export default function App() {
  const [d, setD] = useState(false);
  return (<View style={styles.app}>
    <View style={styles.side}><Text style={styles.h}>Panel</Text><Text style={styles.m}>muted</Text></View>
    <Button title="Toggle" onPress={() => { setD(!d); setTheme(!d); }} style={styles.b} />
  </View>);
}
const styles = StyleSheet.create({
  app: { flexDirection: 'row', gap: 8, backgroundColor: 'bg' },
  side: { width: 160, padding: 12, gap: 6, backgroundColor: 'surface' },
  h: { fontWeight: 'bold', color: 'text' }, m: { color: 'muted' },
  b: { backgroundColor: 'primary', color: 'onPrimary', padding: 8, borderRadius: 6 },
});
