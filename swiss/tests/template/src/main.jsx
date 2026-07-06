import { render } from 'swiss';
import App from './App.jsx';
import EzyModule from './backend.js';
import sigs from './backend.sig.json';
render(<App />, document.getElementById('root'), { backend: EzyModule, sigs });
