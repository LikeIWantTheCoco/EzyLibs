import { render } from 'swiss';
import App from './App.jsx';
import EzyModule from './backend.js';     // ezy → wasm (built by `swiss build`)
import sigs from './backend.sig.json';     // fn signatures (built by `swiss build`)

// Swiss loads the wasm and wires `ezy` BEFORE mounting, so ezy.call is sync.
render(<App />, document.getElementById('root'), { backend: EzyModule, sigs });
