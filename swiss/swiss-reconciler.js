// Swiss reconciler — wraps react-reconciler with a swappable platform HostConfig.
//
// The SAME reconciler drives every Swiss target. Only the HostConfig changes:
//   web      → swiss-host-web.js (creates DOM nodes)        ← v0.1
//   gtk      → (future) emits widget ops over the C bridge
//   android  → (future) emits ops over JNI
//
// This is the React Native architecture: React + react-reconciler + a host
// config per platform. App code (View/Text/Button/…) never knows the target.
import Reconciler from 'react-reconciler';

// Build a renderer from a platform HostConfig. Returns { render(element, container) }.
export function makeRenderer(hostConfig) {
  const recon = Reconciler(hostConfig);
  const roots = new WeakMap();

  return {
    render(element, container) {
      let root = roots.get(container);
      if (!root) {
        // legacy (sync) root — concurrent features are a v0.2 concern.
        root = recon.createContainer(container, 0, null, false, null, 'swiss', () => {}, null);
        roots.set(container, root);
      }
      recon.updateContainer(element, root, null, null);
      return root;
    },
    reconciler: recon,
  };
}
