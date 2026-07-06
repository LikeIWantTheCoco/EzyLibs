import { useState } from 'react';
import { View, Text, Checkbox, Switch, Slider, Select, TextArea, StyleSheet } from 'swiss';
export default function App() {
  const [on, setOn] = useState(false);
  const [v, setV] = useState(30);
  const [s, setS] = useState(0);
  const [n, setN] = useState('x');
  return (<View style={styles.app}>
    <Checkbox label="ok" value={on} onChange={setOn} />
    <Switch label="sw" value={on} onChange={setOn} />
    <Slider value={v} min={0} max={100} onChange={setV} />
    <Select options={['a', 'b', 'c']} value={s} onChange={setS} />
    <TextArea value={n} onChange={setN} style={{ height: 50 }} />
  </View>);
}
const styles = StyleSheet.create({ app: { padding: 16, gap: 8, backgroundColor: '#fff' } });
