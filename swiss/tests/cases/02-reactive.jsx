import { useState } from 'react';
import { View, Text, Button, StyleSheet } from 'swiss';
export default function App() {
  const [tab, setTab] = useState(0);
  return (<View style={styles.app}>
    <Text style={tab === 0 ? styles.on : styles.off}>Tab Uno</Text>
    <View style={tab === 1 ? styles.cardOn : styles.cardOff}><Text>Card</Text></View>
    <Button title={tab ? 'ON' : 'OFF'} onPress={() => setTab(tab ? 0 : 1)} style={tab ? styles.gOn : styles.gOff} />
  </View>);
}
const styles = StyleSheet.create({
  app: { padding: 16, gap: 8, backgroundColor: 'bg' },
  on: { color: 'primary', fontWeight: 'bold' }, off: { color: 'muted' },
  cardOn: { padding: 12, backgroundColor: 'primary', borderRadius: 8 },
  cardOff: { padding: 12, backgroundColor: 'surface', borderRadius: 4 },
  gOn: { backgroundColor: 'success', color: 'onPrimary', padding: 8, borderRadius: 6, width: 100 },
  gOff: { backgroundColor: 'muted', color: 'onPrimary', padding: 8, borderRadius: 6, width: 100 },
});
