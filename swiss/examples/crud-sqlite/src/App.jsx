import { useState, useEffect } from 'react';
import { View, Text, Button, Input, Switch, Tabs, Tab, List, StyleSheet, ezy, swiss } from 'swiss';

export default function App() {
  const [count, setCount] = useState(0);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [editId, setEditId] = useState(0);
  const [dark, setDark] = useState(true);
  const [dir, setDir] = useState('(carpeta por defecto)');

  useEffect(() => { setCount(ezy.call('products_refresh')); }, []);

  const save = () => {
    if (editId > 0) { ezy.call('product_update', editId, name, int(price)); }
    else { ezy.call('product_add', name, int(price)); }
    setName('');
    setPrice('');
    setEditId(0);
    setCount(ezy.call('products_refresh'));
  };

  const remove = (id) => {
    ezy.call('product_delete', id);
    setCount(ezy.call('products_refresh'));
  };

  const edit = (i) => {
    setEditId(ezy.call('product_id', i));
    setName(ezy.call('product_name', i));
    setPrice(str(ezy.call('product_price', i)));
  };

  const pickDir = () => {
    const d = swiss.pickFolder();
    if (d != '') {
      setDir(d);
      setCount(ezy.call('set_db_dir', d));
    }
  };

  const toggleTheme = (on) => {
    setDark(!on);
    swiss.setTheme(on);
  };

  return (
    <Tabs>
      <Tab title="Productos">
        <View style={styles.box}>
          <Text style={styles.h1}>Productos</Text>
          <Input value={name} onChange={setName} placeholder="Nombre" />
          <Input value={price} onChange={setPrice} placeholder="Precio" />
          <Button title="Guardar" onPress={save} />
          <List count={count} item={(i) => (
            <View style={styles.row}>
              <Text style={styles.cell}>{ezy.call('product_name', i)}</Text>
              <Text style={styles.cell}>{ezy.call('product_price', i)}</Text>
              <Button title="Editar" onPress={() => edit(i)} />
              <Button title="Borrar" onPress={() => remove(ezy.call('product_id', i))} />
            </View>
          )} />
        </View>
      </Tab>
      <Tab title="Configuración">
        <View style={styles.box}>
          <Text style={styles.h1}>Configuración</Text>
          <Button title="Elegir carpeta de la base de datos" onPress={pickDir} />
          <Text>{dir}</Text>
          <View style={styles.row}>
            <Switch value={dark} onChange={toggleTheme} />
            <Text>Tema claro (apagado = oscuro)</Text>
          </View>
        </View>
      </Tab>
    </Tabs>
  );
}

const styles = StyleSheet.create({
  box: { padding: 16, gap: 10 },
  h1: { fontSize: 22, fontWeight: 'bold' },
  row: { flexDirection: 'row', gap: 10 },
  cell: { fontSize: 14 },
});
