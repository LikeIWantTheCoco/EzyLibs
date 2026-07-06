import { View, Text, StyleSheet } from 'swiss';
export default function App() {
  return (<View style={styles.app}>
    <Text>base</Text>
    <View style={styles.modal}><Text style={{ color: 'white' }}>Modal</Text></View>
  </View>);
}
const styles = StyleSheet.create({
  app: { padding: 16, backgroundColor: '#fff' },
  modal: { position: 'absolute', top: 40, left: 30, padding: 16, backgroundColor: '#1e293b', borderRadius: 10, zIndex: 10 },
});
