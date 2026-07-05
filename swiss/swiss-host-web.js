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
  'swiss-checkbox': 'label',   // <label><input type=checkbox> text</label>
  'swiss-switch': 'label',
  'swiss-slider': 'input',      // type=range
  'swiss-select': 'select',
  'swiss-textarea': 'textarea',
  'swiss-progress': 'progress',
  'swiss-image': 'img',
  'swiss-separator': 'hr',
};
// widgets that are a <label> wrapping a real control + a text node
const WRAP = { 'swiss-checkbox': 'checkbox', 'swiss-switch': 'checkbox' };

// default layout per primitive (matches RN/Yoga: View is a flex column)
function applyDefaults(type, el) {
  // RN/Yoga box model: width/height include padding+border (the native targets
  // lay out this way too). Browsers default to content-box, so force border-box
  // on every widget to keep web sizing identical to native/JSX.
  el.style.boxSizing = 'border-box';
  if (type === 'swiss-view') {
    el.style.display = 'flex';
    el.style.flexDirection = 'column';
  } else if (type === 'swiss-button') {
    // strip the native <button> chrome (the ugly gray/black border + OS bevel)
    // so buttons are flat like the native targets; the JSX style still overrides.
    el.style.appearance = 'none';
    el.style.webkitAppearance = 'none';
    el.style.border = 'none';
    el.style.background = 'transparent';
    el.style.font = 'inherit';
    el.style.color = 'inherit';
    el.style.cursor = 'pointer';
    el.style.padding = '0';
    // focus ring is styled globally (accent, matching GTK/win32) — see swiss.js
  }
}

// wrapped widgets keep the real control on el._input; others act on el itself
const ctrlOf = (type, el) => (WRAP[type] ? el._input : el);

// (re)apply props to a DOM node. Events are assigned as properties so a second
// pass overwrites cleanly (no listener leaks).
function applyProps(type, el, props) {
  const c = ctrlOf(type, el);
  c.onclick = null; c.oninput = null; c.onchange = null;
  c.onmouseenter = null; c.onmouseleave = null; c.onfocus = null; c.onblur = null;
  for (const key in props) {
    if (key === 'children' || key === 'key' || key === 'ref') continue;
    const v = props[key];
    if (key === 'style') {
      el.removeAttribute('style'); applyDefaults(type, el); Object.assign(el.style, styleToCss(v));
    } else if (key === 'onPress') {
      c.onclick = (e) => { e.preventDefault(); v && v(e); };
    } else if (key === 'onMouseEnter' || key === 'onHoverIn') {
      c.onmouseenter = (e) => v && v(e);
    } else if (key === 'onMouseLeave' || key === 'onHoverOut') {
      c.onmouseleave = (e) => v && v(e);
    } else if (key === 'onFocus') {
      c.onfocus = (e) => v && v(e);
    } else if (key === 'onBlur') {
      c.onblur = (e) => v && v(e);
    } else if (key === 'onChange') {
      if (type === 'swiss-checkbox' || type === 'swiss-switch') c.onchange = (e) => v && v(e.target.checked);
      else if (type === 'swiss-slider') c.oninput = (e) => v && v(Number(e.target.value));
      else if (type === 'swiss-select') c.onchange = (e) => v && v(e.target.selectedIndex);
      else c.oninput = (e) => v && v(e.target.value);
    } else if (key === 'value') {
      if (type === 'swiss-checkbox' || type === 'swiss-switch') c.checked = !!v;
      else if (type === 'swiss-select') c.selectedIndex = Number(v) || 0;
      else if (type === 'swiss-progress') c.value = Number(v) || 0;
      else c.value = v == null ? '' : String(v);
    } else if (key === 'checked') {
      c.checked = !!v;
    } else if (key === 'min' || key === 'max') {
      c[key] = v;
    } else if (key === 'options') {
      c.innerHTML = '';
      (v || []).forEach((o) => { const op = document.createElement('option'); op.textContent = String(o && typeof o === 'object' ? (o.label != null ? o.label : o.value) : o); c.appendChild(op); });
      if (props.value != null) c.selectedIndex = Number(props.value) || 0;
    } else if (key === 'label') {
      if (el._label) el._label.textContent = ' ' + v;
    } else if (key === 'placeholder') {
      c.placeholder = v;
    } else if (key === 'src' && type === 'swiss-image') {
      c.src = v;
    } else if (key === 'title' && type === 'swiss-button') {
      el.textContent = v;
    } else if (key === 'keyboardType') {
      c.type = v === 'numeric' ? 'number' : 'text';
    } else if (key === 'disabled') {
      c.disabled = !!v;
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
    if (WRAP[type]) {   // <label><input type=checkbox> labeltext</label>
      const inp = document.createElement('input'); inp.type = 'checkbox';
      const lbl = document.createTextNode('');
      el.appendChild(inp); el.appendChild(lbl);
      el._input = inp; el._label = lbl;
      el.style.display = 'inline-flex'; el.style.alignItems = 'center'; el.style.gap = '6px'; el.style.cursor = 'pointer';
    } else if (type === 'swiss-slider') {
      el.type = 'range';
    }
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
