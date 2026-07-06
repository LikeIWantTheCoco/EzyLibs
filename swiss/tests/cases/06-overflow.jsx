import { View, Text, StyleSheet } from 'swiss';
export default function App() {
  return (<View style={styles.app}>
    <View style={styles.card}>
      <View style={styles.head}><Text style={{ color: 'white' }}>Head</Text></View>
      <View style={styles.body}><Text>Body</Text></View>
    </View>
    <View style={styles.scroll}>
      <Text>r1</Text><Text>r2</Text><Text>r3</Text><Text>r4</Text><Text>r5</Text><Text>r6</Text>
    </View>
  </View>);
}
const styles = StyleSheet.create({
  app: { padding: 12, gap: 8, backgroundColor: '#eee' },
  card: { width: 200, borderRadius: 16, overflow: 'hidden' },
  head: { padding: 12, backgroundColor: 'primary' }, body: { padding: 12, backgroundColor: '#fff' },
  scroll: { height: 80, overflow: 'auto', border: '1px solid #ccc', borderRadius: 6, padding: 6, gap: 4 },
});
