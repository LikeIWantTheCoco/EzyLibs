// Swiss native — web target. The SAME native surface as swiss-native.ez, but
// backed by browser APIs (on web the Ezy backend is wasm, so the native C `os`
// libs aren't there). Swiss routes `native.*` to this on web and to the Ezy
// backend (ezy.call('swiss_*')) on native targets — one API, every target.
//
//   import { native } from 'swiss';
//   await native.request('notifications');
//   native.notify('Hi', 'from the web');
//
// Capabilities the web can't provide (brightness, real fs paths, gyroscope on
// desktop, …) resolve to a safe default and console.warn once.

const warned = new Set();
const na = (name, ret) => { if (!warned.has(name)) { console.warn(`swiss.native.${name}: unavailable on web`); warned.add(name); } return ret; };

export const native = {
  // permissions
  async request(name) {
    if (name === 'notifications' && 'Notification' in window) return (await Notification.requestPermission()) === 'granted' ? 1 : 0;
    if (name === 'location') return 1; // geolocation prompts on first use
    return 1;
  },
  has(name) { return name === 'notifications' && 'Notification' in window ? (Notification.permission === 'granted' ? 1 : 0) : 1; },

  // files (browser: pick to read, blob to save)
  openDialog(_title, accept = '') {
    return new Promise((res) => {
      const i = document.createElement('input'); i.type = 'file'; if (accept) i.accept = accept;
      i.onchange = () => { const f = i.files[0]; if (!f) return res(''); const r = new FileReader(); r.onload = () => res(r.result); r.readAsText(f); };
      i.click();
    });
  },
  saveDialog(name, text = '') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = name || 'download.txt'; a.click();
    URL.revokeObjectURL(a.href); return name;
  },
  read() { return na('read', ''); }, write() { return na('write', 0); }, append() { return na('append', 0); },
  home() { return na('home', ''); }, tmp() { return na('tmp', ''); },

  // system
  notify(title, body) { if ('Notification' in window && Notification.permission === 'granted') { new Notification(title, { body }); return 1; } return 0; },
  clipSet(t) { return navigator.clipboard ? (navigator.clipboard.writeText(t), 1) : na('clipSet', 0); },
  clipGet() { return navigator.clipboard ? navigator.clipboard.readText() : na('clipGet', ''); },
  openUrl(u) { window.open(u, '_blank'); return 1; },
  async battery() { if (navigator.getBattery) { const b = await navigator.getBattery(); return Math.round(b.level * 100); } return na('battery', -1); },
  async onAc() { if (navigator.getBattery) { const b = await navigator.getBattery(); return b.charging ? 1 : 0; } return na('onAc', -1); },
  brightness() { return na('brightness', -1); }, setBrightness() { return na('setBrightness', 0); },
  screenW() { return window.screen.width; }, screenH() { return window.screen.height; },

  // location
  location() {
    return new Promise((res) => {
      if (!navigator.geolocation) return res('');
      navigator.geolocation.getCurrentPosition(p => res(`${p.coords.latitude},${p.coords.longitude}`), () => res(''));
    });
  },

  // motion (DeviceMotion/Orientation; needs a user-gesture permission on iOS Safari)
  onMotion(cb) {
    if (!('DeviceMotionEvent' in window)) return na('onMotion', 0);
    window.addEventListener('devicemotion', (e) => {
      const a = e.accelerationIncludingGravity || {};
      cb({ ax: a.x || 0, ay: a.y || 0, az: a.z || 0 });
    });
    return 1;
  },
  steps() { return na('steps', -1); },

  // background
  bgEvery(ms, cb) { return setInterval(cb, ms); },
  bgStop(id) { clearInterval(id); return 1; },
};

export default native;
