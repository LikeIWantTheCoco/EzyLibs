import { View, Text, StyleSheet } from 'swiss';
export default function App() {
  return (<View style={styles.app}><View style={styles.wrap}>
    <Text style={styles.t}>A</Text><Text style={styles.t}>B</Text><Text style={styles.t}>C</Text>
    <Text style={styles.t}>D</Text><Text style={styles.t}>E</Text><Text style={styles.t}>F</Text>
  </View></View>);
}
const styles = StyleSheet.create({
  app: { padding: 12, backgroundColor: '#fff' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, width: 180 },
  t: { backgroundColor: 'primary', color: 'onPrimary', padding: 6, borderRadius: 10 },
});
