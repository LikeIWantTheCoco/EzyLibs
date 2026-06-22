// Swiss web HostConfig — realizes Swiss primitives as DOM nodes.
//
// Host instance types come from swiss-components.js:
//   swiss-view  → <div> (flex column by default, RN-like)
//   swiss-text  → <span>
//   swiss-button→ <button>   (onPress → click)
//   swiss-input → <input>    (onChange(value), value, placeholder)
//
// This is HostConfig #1. A native target ships its own file with the same
// surface; the reconciler and all components are reused unchanged.
import { styleToCss } from './swiss-stylesheet.js';

const TAG = {
  'swiss-view': 'div',
  'swiss-text': 'span',
  'swiss-button': 'button',
  'swiss-input': 'input',
};

// default layout per primitive (matches RN/Yoga: View is a flex column)
function applyDefaults(type, el) {
  if (type === 'swiss-view') {
    el.style.display = 'flex';
    el.style.flexDirection = 'column';
  }
}

// (re)apply props to a DOM node. Events are assigned as properties so a second
// pass overwrites cleanly (no listener leaks).
function applyProps(type, el, props) {
  el.onclick = null;
  el.oninput = null;
  for (const key in props) {
    if (key === 'children' || key === 'key' || key === 'ref') continue;
    const v = props[key];
    if (key === 'style') {
      // defaults first, user style wins
      el.removeAttribute('style');
      applyDefaults(type, el);
      Object.assign(el.style, styleToCss(v));
    } else if (key === 'onPress') {
      el.onclick = (e) => { e.preventDefault(); v && v(e); };
    } else if (key === 'onChange') {
      el.oninput = (e) => v && v(e.target.value);
    } else if (key === 'value') {
      el.value = v == null ? '' : String(v);
    } else if (key === 'placeholder') {
      el.placeholder = v;
    } else if (key === 'title' && type === 'swiss-button') {
      el.textContent = v;
    } else if (key === 'keyboardType') {
      el.type = v === 'numeric' ? 'number' : 'text';
    } else if (key === 'disabled') {
      el.disabled = !!v;
    }
  }
  if (!('style' in props)) applyDefaults(type, el);
}

const now =
  typeof performance === 'object' && performance.now
    ? () => performance.now()
    : () => Date.now();

export const hostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  isPrimaryRenderer: true,
  noTimeout: -1,
  now,
  scheduleTimeout: (fn, d) => setTimeout(fn, d),
  cancelTimeout: (id) => clearTimeout(id),

  getRootHostContext: () => ({}),
  getChildHostContext: (parent) => parent,
  getPublicInstance: (inst) => inst,
  getCurrentEventPriority: () => 0b0000000000000000000000000010000, // DefaultEventPriority
  prepareForCommit: () => null,
  resetAfterCommit: () => {},
  preparePortalMount: () => {},
  detachDeletedInstance: () => {},

  // a <swiss-text> whose only child is a string sets textContent directly,
  // so we don't make a separate text node for the common case.
  shouldSetTextContent: (type, props) =>
    type === 'swiss-text' &&
    (typeof props.children === 'string' || typeof props.children === 'number'),

  createInstance(type, props) {
    const tag = TAG[type] || 'div';
    const el = document.createElement(tag);
    applyProps(type, el, props);
    if (type === 'swiss-text' && (typeof props.children === 'string' || typeof props.children === 'number'))
      el.textContent = String(props.children);
    return el;
  },

  createTextInstance: (text) => document.createTextNode(text),

  appendInitialChild: (parent, child) => parent.appendChild(child),
  finalizeInitialChildren: () => false,

  appendChild: (parent, child) => parent.appendChild(child),
  appendChildToContainer: (container, child) => container.appendChild(child),
  insertBefore: (parent, child, before) => parent.insertBefore(child, before),
  insertInContainerBefore: (container, child, before) => container.insertBefore(child, before),
  removeChild: (parent, child) => parent.removeChild(child),
  removeChildFromContainer: (container, child) => container.removeChild(child),

  // tell the reconciler an update is needed; we reapply nextProps wholesale.
  prepareUpdate: () => true,
  commitUpdate(instance, _payload, type, _prev, nextProps) {
    applyProps(type, instance, nextProps);
    if (type === 'swiss-text' && (typeof nextProps.children === 'string' || typeof nextProps.children === 'number'))
      instance.textContent = String(nextProps.children);
  },
  commitTextUpdate: (node, _old, text) => { node.nodeValue = text; },

  clearContainer: (container) => { container.textContent = ''; },
};

export default hostConfig;
