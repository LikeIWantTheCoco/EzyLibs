import { View, Text, StyleSheet } from 'swiss';
// .map over a const/derived scalar array → build-time unroll (static list)
const TABS = ['Home', 'Search', 'Profile'];
export default function App() {
  return (<View style={styles.app}>
    <Text style={styles.h}>Tabs</Text>
    <View style={styles.row}>
      {TABS.map((label, i) => (
        <Text key={i} style={styles.tab}>{i}: {label}</Text>
      ))}
    </View>
    {['a', 'b', 'c'].map((c) => (<Text key={c} style={styles.tab}>{c}</Text>))}
  </View>);
}
const styles = StyleSheet.create({
  app: { padding: 16, gap: 8, backgroundColor: '#fff' },
  h: { fontSize: 20, fontWeight: 'bold' },
  row: { flexDirection: 'row', gap: 8 },
  tab: { padding: 8, backgroundColor: '#eee', borderRadius: 6 },
});
