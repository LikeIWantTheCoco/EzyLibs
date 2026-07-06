import { View, Text, StyleSheet } from 'swiss';
export default function App() {
  return (<View style={styles.app}><View style={styles.g}><Text style={{ color: 'white' }}>Grad</Text></View></View>);
}
const styles = StyleSheet.create({
  app: { padding: 16, backgroundColor: '#fff' },
  g: { padding: 24, borderRadius: 12, background: 'linear-gradient(135deg, #667eea, #764ba2)' },
});
