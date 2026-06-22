import { useState, useEffect } from 'react';
import { View, Text, Button, Checkbox, Slider, ProgressBar, Select, Separator, StyleSheet, ezy } from 'swiss';

// custom presentational component with destructured props
const Badge = ({ label, n }) => (
  <View style={styles.badge}>
    <Text style={styles.badgeText}>{label}: {n}</Text>
  </View>
);

export default function App() {
  const [checked, setChecked] = useState(true);
  const [vol, setVol] = useState(40);
  const [sel, setSel] = useState(0);
  const [loaded, setLoaded] = useState(ezy.call('counter'));
  const [name, setName] = useState("  Hola Mundo  ");

  useEffect(() => { setVol(vol + 5); }, []);

  return (
    <>
      <View style={styles.box}>
        <Text style={styles.h1}>Fases 2-4</Text>
        <Badge label="loaded" n={loaded} />
        <Badge label="trim len" n={name.trim().length} />
        <Text>{name.trim().toUpperCase()}</Text>
        <Separator />
        <View style={styles.row}>
          <Checkbox value={checked} onChange={setChecked} label="activo" />
          {checked && <Text style={styles.ok}>marcado</Text>}
        </View>
        <Slider value={vol} min={0} max={100} onChange={setVol} />
        <Text>volumen: {vol}</Text>
        <ProgressBar value={vol} max={100} />
        <Select value={sel} options={["rojo", "verde", "azul"]} onChange={setSel} />
        <Text>opcion: {sel}</Text>
      </View>
    </>
  );
}
const styles = StyleSheet.create({
  box: { padding: 20, gap: 10, alignItems: 'center', width: 420 },
  h1: { fontSize: 22, fontWeight: 'bold' },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  ok: { color: 'lightgreen', fontWeight: 'bold' },
  badge: { padding: 6, backgroundColor: '#335', borderRadius: 6 },
  badgeText: { color: 'white' },
});
