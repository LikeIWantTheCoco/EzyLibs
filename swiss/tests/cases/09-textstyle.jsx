import { View, Text, StyleSheet } from 'swiss';
export default function App() {
  return (<View style={styles.app}>
    <Text style={styles.i}>italic</Text>
    <Text style={styles.u}>underline</Text>
    <Text style={styles.up}>upper me</Text>
    <Text style={styles.sp}>spaced</Text>
    <Text style={styles.lh}>Long paragraph that wraps across several lines with generous line height here.</Text>
  </View>);
}
const styles = StyleSheet.create({
  app: { padding: 16, gap: 6, backgroundColor: '#fff' },
  i: { fontStyle: 'italic' }, u: { textDecoration: 'underline' },
  up: { textTransform: 'uppercase' }, sp: { letterSpacing: 4 },
  lh: { width: 200, lineHeight: 2, fontSize: 14 },
});
