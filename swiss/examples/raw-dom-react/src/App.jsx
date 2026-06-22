import { useState } from 'react';

export default function App() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState('escribe algo y busca');

  const handleSearch = (e) => {
    e.preventDefault();
    setResult("Buscaste: " + query);
  };

  return (
    <div style={{ padding: '20px', maxWidth: '400px', margin: '0 auto' }}>
      <h1>Buscador</h1>
      <form onSubmit={handleSearch}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar..."
          style={{
            width: '100%',
            padding: '10px',
            fontSize: '16px',
            border: '1px solid #ccc',
            borderRadius: '4px'
          }}
        />
        <button
          type="submit"
          style={{
            marginTop: '10px',
            padding: '10px 20px',
            backgroundColor: '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          Buscar
        </button>
      </form>
      <p>{result}</p>
    </div>
  );
}
