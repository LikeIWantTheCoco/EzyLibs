// swiss-jsx-core — shared front-end for the Swiss build-time translators.
//
// Both native translators (swiss-gtkc / swiss-win32c) parse the SAME React/JSX
// with @babel/parser and lower the SAME semantics; only the widget emission and
// C runtime differ. This module owns everything that is backend-agnostic — the
// AST utilities, the component analysis (state cells, methods, refs, derived
// values, record shapes), and the expression/statement code generation — so a
// fix lands once for every target.
//
// The generated C uses a small `swiss_*` helper API (swiss_aprintf, swiss_concat,
// swiss_strdup, swiss_upper, …). Each backend's runtime defines those (libc on
// win32, thin GLib wrappers on gtk), which lets cexpr/genStmt be identical.
import { parse as babelParse } from '@babel/parser';
// semantic theme tokens live in a dependency-free module (shared with the web
// runtime); re-export so the native translators keep importing them from here.
export { THEME, TOKENS, isToken } from './swiss-theme.mjs';

export function parse(src) { return babelParse(src, { sourceType: 'module', plugins: ['jsx'] }); }

export function cstr(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}
export const cType = (t) => (t === 'float' ? 'double' : t === 'string' ? 'const char*' : t === 'void' ? 'void' : 'long long');
export const stripParens = (n) => (n && n.type === 'ParenthesizedExpression' ? n.expression : n);

export function walk(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const k in node) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'leadingComments' || k === 'trailingComments') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, fn));
    else if (v && typeof v.type === 'string') walk(v, fn);
  }
}

// ───────────────────────── declarations ─────────────────────────
function collectStyles(ast) {
  const styles = {};
  for (const n of ast.program.body)
    walk(n, (node) => {
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
          node.callee.object.name === 'StyleSheet' && node.callee.property.name === 'create') {
        for (const p of node.arguments[0].properties) styles[p.key.name || p.key.value] = objLiteral(p.value);
      }
    });
  return styles;
}
function objLiteral(node) {
  const out = {};
  for (const p of node.properties) {
    const v = p.value;
    out[p.key.name || p.key.value] =
      v.type === 'NumericLiteral' ? v.value :
      v.type === 'StringLiteral' ? v.value :
      v.type === 'UnaryExpression' && v.operator === '-' ? -v.argument.value : null;
  }
  return out;
}
function findComponent(ast, err) {
  for (const n of ast.program.body)
    if (n.type === 'ExportDefaultDeclaration') {
      const d = n.declaration;
      if (d.type === 'FunctionDeclaration' || d.type === 'ArrowFunctionExpression' || d.type === 'FunctionExpression') return d;
      // `export default Name;` → resolve the identifier to its declaration
      if (d.type === 'Identifier') {
        for (const m of ast.program.body) {
          if (m.type === 'FunctionDeclaration' && m.id && m.id.name === d.name) return m;
          if (m.type === 'VariableDeclaration')
            for (const v of m.declarations)
              if (v.id.name === d.name && v.init && (v.init.type === 'ArrowFunctionExpression' || v.init.type === 'FunctionExpression')) return v.init;
        }
      }
    }
  err('no default-exported function component found');
}

// ─────────────── stateful child components (build-time inline) ───────────────
// A custom component that declares its own useState/useEffect is inlined at
// each *static* usage site: its state/effect/derived decls are cloned into the
// root component's body (α-renamed with a unique per-instance prefix) and its
// return JSX is spliced in place of <Child/>. Downstream collection, the effect
// scan, and the JSX builder then treat the child's state as ordinary root
// state — no per-target work. Props become injected `const <prefix>x = <caller>`
// bindings; {children} is replaced by the caller's children. A stateful child
// inside a dynamic .map can't be statically allocated → hard error (see PARITY).
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'leadingComments', 'trailingComments']);
const jsxTag = (el) => (el.openingElement.name.type === 'JSXIdentifier' ? el.openingElement.name.name : null);
const constDecl = (name, init) => ({ type: 'VariableDeclaration', kind: 'const', declarations: [{ type: 'VariableDeclarator', id: { type: 'Identifier', name }, init }] });
const jsxHasContent = (n) => !(n.type === 'JSXText' && !n.value.trim());

function renameLocals(node, names, prefix) {
  const rn = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'Identifier') { if (names.has(n.name)) n.name = prefix + n.name; return; }
    for (const k in n) {
      if (SKIP_KEYS.has(k)) continue;
      if (n.type === 'MemberExpression' && k === 'property' && !n.computed) continue;
      if ((n.type === 'ObjectProperty' || n.type === 'ObjectMethod') && k === 'key' && !n.computed) continue;
      if (n.type === 'JSXAttribute' && k === 'name') continue;
      if ((n.type === 'JSXOpeningElement' || n.type === 'JSXClosingElement') && k === 'name') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(rn); else if (v && typeof v.type === 'string') rn(v);
    }
  };
  rn(node);
}

// replace {children}/{props.children} with the caller's kids, at any depth —
// including JSX nested inside expression containers ({cond && <V>{children}</V>})
function substituteChildren(root, callerKids) {
  const isChildrenRef = (e) => e && ((e.type === 'Identifier' && e.name === 'children') ||
    (e.type === 'MemberExpression' && e.object.type === 'Identifier' && e.object.name === 'props' && e.property.name === 'children'));
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if ((n.type === 'JSXElement' || n.type === 'JSXFragment') && n.children) {
      const out = [];
      for (const ch of n.children) {
        if (ch.type === 'JSXExpressionContainer' && isChildrenRef(ch.expression)) callerKids.forEach((k) => out.push(structuredClone(k)));
        else out.push(ch);
      }
      n.children = out;
    }
    for (const k in n) {
      if (SKIP_KEYS.has(k)) continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(root);
}

function inlineStatefulComponents(ast, comp, err) {
  const returnsJSX = (fn) => {
    const isJ = (x) => x && (x.type === 'JSXElement' || x.type === 'JSXFragment' || (x.type === 'ParenthesizedExpression' && isJ(x.expression)));
    return fn.body.type === 'BlockStatement' ? fn.body.body.some((s) => s.type === 'ReturnStatement' && isJ(s.argument)) : isJ(fn.body);
  };
  const compNodes = {};
  for (const n of ast.program.body) {
    if (n.type === 'ExportDefaultDeclaration') continue;
    if (n.type === 'FunctionDeclaration' && n.id && returnsJSX(n)) compNodes[n.id.name] = n;
    if (n.type === 'VariableDeclaration')
      for (const d of n.declarations)
        if (d.init && (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression') && returnsJSX(d.init)) compNodes[d.id.name] = d.init;
  }
  const stateful = new Set();
  for (const name in compNodes) {
    let s = false;
    walk(compNodes[name].body, (n) => { if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && /^use(State|Effect|Reducer)$/.test(n.callee.name)) s = true; });
    if (s) stateful.add(name);
  }
  if (!stateful.size) return;

  let inst = 0;
  const hoisted = [];

  function inlineOne(node, useEl, prefix) {
    const clone = structuredClone(node);
    const stmts = clone.body.type === 'BlockStatement' ? clone.body.body : [{ type: 'ReturnStatement', argument: clone.body }];
    const locals = new Set();
    for (const st of stmts)
      if (st.type === 'VariableDeclaration')
        for (const d of st.declarations) {
          if (d.id.type === 'ArrayPattern') d.id.elements.forEach((e) => e && e.type === 'Identifier' && locals.add(e.name));
          else if (d.id.type === 'Identifier') locals.add(d.id.name);
        }
    const param = clone.params[0];
    const propNames = new Set(); const defaults = {};
    if (param && param.type === 'ObjectPattern') {
      for (const p of param.properties) {
        if (p.type === 'RestElement') continue;
        propNames.add(p.key.name);
        if (p.value && p.value.type === 'AssignmentPattern') defaults[p.key.name] = p.value.right;
      }
    } else if (param && param.type === 'Identifier') {
      err(`stateful component <${jsxTag(useEl)}> must destructure its props ({ ... }); a bare \`props\` param is not supported on native targets`, useEl);
    }
    const a = {};
    for (const at of useEl.openingElement.attributes || []) if (at.type === 'JSXAttribute') a[at.name.name] = at.value;
    const callerKids = (useEl.children || []).filter(jsxHasContent);

    let ret = null;
    for (const st of stmts) if (st.type === 'ReturnStatement') ret = st.argument;
    ret = stripParens(ret);
    if (!ret) err(`stateful component <${jsxTag(useEl)}> must return JSX`, useEl);
    substituteChildren(ret, callerKids);

    const hoist = stmts.filter((st) => st.type !== 'ReturnStatement');
    const allNames = new Set([...locals, ...propNames]);
    for (const st of hoist) renameLocals(st, allNames, prefix);
    renameLocals(ret, allNames, prefix);

    for (const nm of propNames) {
      if (nm === 'children') continue;
      const at = a[nm];
      let val;
      if (at !== undefined) val = at === null ? { type: 'BooleanLiteral', value: true } : (at.type === 'JSXExpressionContainer' ? at.expression : { type: 'StringLiteral', value: at.value });
      else if (defaults[nm]) val = defaults[nm];
      else val = { type: 'NumericLiteral', value: 0 };
      hoist.unshift(constDecl(prefix + nm, val));
    }
    hoisted.push(...hoist);
    return ret;
  }

  // walk any node; replace stateful <Child/> wherever it appears; flip inMap at .map
  function process(node, inMap) {
    if (!node || typeof node.type !== 'string') return node;
    if (node.type === 'JSXElement') {
      const tag = jsxTag(node);
      if (stateful.has(tag)) {
        if (inMap) err(`stateful component <${tag}> inside .map is not supported on native targets — lift its state to the parent or give it a fixed position`, node);
        const repl = inlineOne(compNodes[tag], node, `__c${inst++}_`);
        return process(repl, inMap);
      }
      processKids(node, inMap); return node;
    }
    if (node.type === 'JSXFragment') { processKids(node, inMap); return node; }
    const nextMap = inMap || (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'map');
    for (const k in node) {
      if (SKIP_KEYS.has(k)) continue;
      const v = node[k];
      if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) if (v[i] && typeof v[i].type === 'string') v[i] = process(v[i], nextMap); }
      else if (v && typeof v.type === 'string') node[k] = process(v, nextMap);
    }
    return node;
  }
  function processKids(jsx, inMap) {
    if (!jsx.children) return;
    for (let i = 0; i < jsx.children.length; i++) jsx.children[i] = process(jsx.children[i], inMap);
  }

  // process the root component's return JSX, then prepend hoisted decls
  if (comp.body.type === 'BlockStatement') {
    for (const st of comp.body.body) if (st.type === 'ReturnStatement') st.argument = process(st.argument, false);
    if (hoisted.length) { const ret = comp.body.body.findIndex((s) => s.type === 'ReturnStatement'); comp.body.body.splice(ret < 0 ? comp.body.body.length : ret, 0, ...hoisted); }
  } else {
    const body = process(comp.body, false);
    comp.body = hoisted.length ? { type: 'BlockStatement', body: [...hoisted, { type: 'ReturnStatement', argument: body }] } : body;
  }
}

// Build the shared front-end for one component. Returns a context object the
// backend's widget builder draws on (cexpr, genStmt, the cell tables, the
// shared `out` accumulator, etc.).
export function createFrontend(ast, opts) {
  const sigs = (opts && opts.sigs) || {};
  const err = (msg, node) => { const loc = node && node.loc ? ` (line ${node.loc.start.line})` : ''; throw new Error(`${(opts && opts.tag) || 'swiss'}: ${msg}${loc}`); };
  const styles = collectStyles(ast);
  const comp = findComponent(ast, err);
  inlineStatefulComponents(ast, comp, err);

  const cells = [];   // useState
  const methods = []; // helper arrows / useCallback
  const refs = [];    // useRef
  const derived = {}; // const x = expr (inlined, reactive)
  for (const stmt of comp.body.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) {
      const init = d.init;
      if (init && init.type === 'CallExpression' && init.callee.name === 'useState') {
        const [valId, setId] = d.id.elements;
        const setName = setId ? setId.name : '__noset_' + valId.name;   // read-only state: const [x] = useState(...)
        const a = init.arguments[0];
        let t = 'int', ctype = 'long long', cinit = '0', initNode = null, initObj = null, initArr = null;
        if (a) {
          if (a.type === 'StringLiteral') { t = 'string'; ctype = 'const char*'; cinit = cstr(a.value); }
          else if (a.type === 'BooleanLiteral') { t = 'bool'; cinit = a.value ? '1' : '0'; }
          else if (a.type === 'NumericLiteral') { if (Number.isInteger(a.value)) cinit = String(a.value); else { t = 'float'; ctype = 'double'; cinit = String(a.value); } }
          else if (a.type === 'ArrayExpression') { t = 'array'; ctype = null; cinit = null; initArr = a; }
          else if (a.type === 'ObjectExpression') { t = 'object'; ctype = null; cinit = null; initObj = a; }
          else {
            initNode = a;
            if (a.type === 'CallExpression' && a.callee.type === 'MemberExpression' && a.callee.object.name === 'ezy') {
              const r = sigs[a.arguments[0].value] ? sigs[a.arguments[0].value].ret : 'int';
              t = r === 'string' ? 'string' : r === 'float' ? 'float' : 'int'; ctype = cType(t);
            }
          }
        }
        cells.push({ name: valId.name, setter: setName, ctype, cinit, t, initNode, initObj, initArr });
      } else if (init && init.type === 'CallExpression' && init.callee.name === 'useMemo') {
        const arrow = init.arguments[0];
        const vb = arrow.body;
        const valExpr = vb.type === 'BlockStatement' ? (vb.body.find((s) => s.type === 'ReturnStatement') || {}).argument : vb;
        const memoDeps = init.arguments[1] && init.arguments[1].type === 'ArrayExpression'
          ? init.arguments[1].elements.filter((e) => e.type === 'Identifier').map((e) => e.name) : [];
        cells.push({ name: d.id.name, setter: '__memo_' + d.id.name, ctype: 'long long', cinit: null, t: 'int', initNode: valExpr, isMemo: true, memoDeps });
      } else if (init && init.type === 'CallExpression' && init.callee.name === 'useCallback') {
        methods.push({ name: d.id.name, node: init.arguments[0] });
      } else if (init && init.type === 'CallExpression' && init.callee.name === 'useRef') {
        const a = init.arguments[0];
        let rt = 'int', rc = 'long long', ci = '0';
        if (a) {
          if (a.type === 'StringLiteral') { rt = 'string'; rc = 'const char*'; ci = cstr(a.value); }
          else if (a.type === 'NullLiteral') { rt = 'widget'; rc = opts.widgetType; ci = 'NULL'; }
          else if (a.type === 'NumericLiteral') { ci = String(a.value); }
        }
        refs.push({ name: d.id.name, t: rt, ctype: rc, cinit: ci });
      } else if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
        methods.push({ name: d.id.name, node: init });
      } else if (init && d.id.type === 'Identifier') {
        derived[d.id.name] = init;
      }
    }
  }
  // module-level `const X = <literal>` (outside the component) are also derived —
  // e.g. `const TABS = ['Home','Search']` used in a build-time .map unroll. The
  // component body wins on name collision, so only add names not already set.
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) {
      if (d.id.type !== 'Identifier' || !d.init || derived[d.id.name]) continue;
      const it = d.init;
      if (it.type === 'CallExpression') continue; // StyleSheet.create / hooks handled elsewhere
      derived[d.id.name] = it;
    }
  }
  const cellByName = (n) => cells.find((c) => c.name === n);
  const cellBySetter = (n) => cells.find((c) => c.setter === n);
  const methodByName = (n) => methods.find((m) => m.name === n);
  const refByName = (n) => refs.find((r) => r.name === n);

  // presentational components (inlined on use)
  const returnsJSX = (fn) => {
    const isJ = (x) => x && (x.type === 'JSXElement' || x.type === 'JSXFragment' || (x.type === 'ParenthesizedExpression' && isJ(x.expression)));
    return fn.body.type === 'BlockStatement' ? fn.body.body.some((s) => s.type === 'ReturnStatement' && isJ(s.argument)) : isJ(fn.body);
  };
  const components = [];
  for (const n of ast.program.body) {
    if (n.type === 'ExportDefaultDeclaration') continue;
    if (n.type === 'FunctionDeclaration' && n.id && returnsJSX(n)) components.push({ name: n.id.name, node: n });
    if (n.type === 'VariableDeclaration')
      for (const d of n.declarations)
        if (d.init && (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression') && returnsJSX(d.init))
          components.push({ name: d.id.name, node: d.init });
  }
  const componentByName = (n) => components.find((c) => c.name === n);

  // record-shape inference
  const tInfer = (node) => {
    if (!node) return 'int';
    try { const t = cexpr(node, {}).t; if (t && t !== 'void') return t; } catch (e) { /* fall back */ }
    if (node.type === 'StringLiteral') return 'string';
    if (node.type === 'BooleanLiteral') return 'bool';
    if (node.type === 'NumericLiteral') return Number.isInteger(node.value) ? 'int' : 'float';
    if (node.type === 'Identifier') { const c = cellByName(node.name); return c ? c.t : 'int'; }
    if (node.type === 'CallExpression') {
      if (node.callee.name === 'str') return 'string';
      if (node.callee.type === 'MemberExpression' && node.callee.object.name === 'ezy') { const r = sigs[node.arguments[0].value]; return r ? (r.ret === 'string' ? 'string' : r.ret === 'float' ? 'float' : 'int') : 'int'; }
    }
    return 'int';
  };
  for (const c of cells.filter((x) => x.t === 'array')) {
    const fields = {};
    const collectObj = (o) => { for (const p of o.properties) if ((p.type === 'ObjectProperty' || p.type === 'Property') && p.key) { const k = p.key.name || p.key.value; if (!(k in fields)) fields[k] = tInfer(p.value); } };
    if (c.initArr) for (const el of c.initArr.elements) if (el && el.type === 'ObjectExpression') collectObj(el);  // shape from the initial array
    walk(comp, (n) => {
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === c.setter)
        walk(n, (o) => { if (o.type === 'ObjectExpression') collectObj(o); });
    });
    c.fields = Object.keys(fields).map((k) => ({ name: k, t: fields[k], ctype: cType(fields[k]) }));
    c.struct = `Item_${c.name}`; c.arrtype = `Arr_${c.name}`; c.ctype = c.arrtype;
  }
  const arrayCells = cells.filter((c) => c.t === 'array');
  for (const c of cells.filter((x) => x.t === 'object')) {
    const fields = {};
    const collect = (obj) => { for (const p of obj.properties) if ((p.type === 'ObjectProperty' || p.type === 'Property') && p.key) { const k = p.key.name || p.key.value; if (!(k in fields)) fields[k] = tInfer(p.value); } };
    if (c.initObj) collect(c.initObj);
    walk(comp, (n) => { if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === c.setter) walk(n, (o) => { if (o.type === 'ObjectExpression') collect(o); }); });
    c.fields = Object.keys(fields).map((k) => ({ name: k, t: fields[k], ctype: cType(fields[k]) }));
    c.struct = `Obj_${c.name}`; c.ctype = c.struct;
  }
  const objectCells = cells.filter((c) => c.t === 'object');

  const deps = {}; cells.forEach((c) => (deps[c.name] = []));
  const stateFields = [];
  const out = { updates: [], fns: [], build: [], externs: new Set(), lists: [], postShow: [] };
  let uid = 0; const vid = (p) => `${p}${uid++}`;
  let hN = 0; const nextH = () => hN++;

  // ── expression: returns { c, t } (emits the swiss_* C helper API) ──
  function cexpr(node, scope) {
    switch (node.type) {
      case 'NumericLiteral': return { c: String(node.value), t: 'int' };
      case 'StringLiteral': return { c: cstr(node.value), t: 'string' };
      case 'BooleanLiteral': return { c: node.value ? '1' : '0', t: 'bool' };
      case 'Identifier': {
        if (scope[node.name]) return { c: scope[node.name].c, t: scope[node.name].t };
        const cell = cellByName(node.name);
        if (cell) return { c: 's->' + cell.name, t: cell.t };
        if (derived[node.name]) return cexpr(derived[node.name], scope);
        err(`unknown identifier '${node.name}'`, node);
        break;
      }
      case 'ParenthesizedExpression': return cexpr(node.expression, scope);
      case 'OptionalMemberExpression':
      case 'MemberExpression': {
        if (node.property.name === 'value' && node.object.type === 'MemberExpression' && node.object.property.name === 'target' && scope.__evtext)
          return { c: scope.__evtext, t: 'string' };
        if (node.property.name === 'current' && node.object.type === 'Identifier' && refByName(node.object.name)) {
          const r = refByName(node.object.name); return { c: `s->${r.name}__current`, t: r.t === 'widget' ? 'int' : r.t };
        }
        if (node.object.type === 'Identifier' && scope[node.object.name] && scope[node.object.name].rec) {
          const r = scope[node.object.name]; const f = (r.shape || []).find((x) => x.name === node.property.name);
          return { c: `${r.rec}.${node.property.name}`, t: f ? f.t : 'int' };
        }
        if (node.object.type === 'Identifier' && cellByName(node.object.name) && cellByName(node.object.name).t === 'array' && node.property.name === 'length')
          return { c: `s->${node.object.name}.len`, t: 'int' };
        if (node.property.name === 'length' && node.object.type === 'CallExpression' && node.object.callee.type === 'MemberExpression' &&
            node.object.callee.property.name === 'filter' && node.object.callee.object.type === 'Identifier' &&
            cellByName(node.object.callee.object.name) && cellByName(node.object.callee.object.name).t === 'array') {
          const cell = cellByName(node.object.callee.object.name); const arrow = node.object.arguments[0];
          const fs = {}; if (arrow.params[0]) fs[arrow.params[0].name] = { rec: `s->${cell.name}.data[_i]`, shape: cell.fields };
          return { c: `({ long long _c = 0; for (long long _i = 0; _i < s->${cell.name}.len; _i++) if (${cexpr(stripParens(arrow.body), fs).c}) _c++; _c; })`, t: 'int' };
        }
        if (node.object.type === 'Identifier' && cellByName(node.object.name) && cellByName(node.object.name).t === 'object') {
          const oc = cellByName(node.object.name); const f = (oc.fields || []).find((x) => x.name === node.property.name);
          return { c: `s->${oc.name}.${node.property.name}`, t: f ? f.t : 'int' };
        }
        if (node.object.name === 'props' && scope.__props && scope.__props[node.property.name]) return scope.__props[node.property.name];
        if (node.property.name === 'length') { const o = cexpr(node.object, scope); return { c: `((long long)strlen(${o.c}))`, t: 'int' }; }
        err('unsupported member access', node); break;
      }
      case 'ConditionalExpression': {
        const test = cexpr(node.test, scope);
        const a = cexpr(node.consequent, scope), b = cexpr(node.alternate, scope);
        return { c: `(${test.c} ? ${a.c} : ${b.c})`, t: a.t === 'void' ? b.t : a.t };
      }
      case 'UnaryExpression': {
        const a = cexpr(node.argument, scope);
        if (node.operator === '!') return { c: `(!${a.c})`, t: 'bool' };
        if (node.operator === '-') return { c: `(-${a.c})`, t: a.t };
        err(`unsupported unary '${node.operator}'`, node); break;
      }
      case 'LogicalExpression': {
        const l = cexpr(node.left, scope), r = cexpr(node.right, scope);
        if (node.operator === '??') return { c: `(${l.c} ? ${l.c} : ${r.c})`, t: r.t };
        return { c: `(${l.c} ${node.operator === '&&' ? '&&' : '||'} ${r.c})`, t: 'bool' };
      }
      case 'BinaryExpression': {
        const l = cexpr(node.left, scope), r = cexpr(node.right, scope);
        let op = node.operator === '===' ? '==' : node.operator === '!==' ? '!=' : node.operator;
        if (op === '+' && (l.t === 'string' || r.t === 'string')) {
          const S = (x) => x.t === 'string' ? x.c : x.t === 'float' ? `swiss_aprintf("%g", (double)(${x.c}))` : `swiss_aprintf("%lld", (long long)(${x.c}))`;
          return { c: `swiss_concat(${S(l)}, ${S(r)})`, t: 'string' };
        }
        if ((op === '==' || op === '!=') && (l.t === 'string' || r.t === 'string')) return { c: `(strcmp(${l.c}, ${r.c}) ${op} 0)`, t: 'bool' };
        if (op === '**') return { c: `((long long)pow((double)(${l.c}), (double)(${r.c})))`, t: 'int' };
        const t = ['==', '!=', '<', '>', '<=', '>='].includes(op) ? 'bool' : (l.t === 'float' || r.t === 'float') ? 'float' : 'int';
        return { c: `(${l.c} ${op} ${r.c})`, t };
      }
      case 'TemplateLiteral': {
        let fmt = ''; const args = [];
        node.quasis.forEach((q, i) => {
          fmt += q.value.cooked.replace(/%/g, '%%');
          if (i < node.expressions.length) {
            const e = cexpr(node.expressions[i], scope);
            fmt += e.t === 'string' ? '%s' : e.t === 'float' ? '%g' : '%lld';
            args.push(e.t === 'string' ? e.c : e.t === 'float' ? `(double)(${e.c})` : `(long long)(${e.c})`);
          }
        });
        return { c: `swiss_aprintf(${cstr(fmt)}${args.length ? ', ' + args.join(', ') : ''})`, t: 'string' };
      }
      case 'OptionalCallExpression':
      case 'CallExpression': {
        const c = node.callee;
        if (c.type === 'Identifier' && (c.name === 'int' || c.name === 'parseInt')) {
          const a = cexpr(node.arguments[0], scope);
          return { c: a.t === 'string' ? `atoll(${a.c})` : `((long long)${a.c})`, t: 'int' };
        }
        if (c.type === 'Identifier' && c.name === 'parseFloat') {
          const a = cexpr(node.arguments[0], scope);
          return { c: a.t === 'string' ? `atof(${a.c})` : `((double)${a.c})`, t: 'float' };
        }
        if (c.type === 'Identifier' && c.name === 'Number') {
          const a = cexpr(node.arguments[0], scope);
          return { c: a.t === 'string' ? `atoll(${a.c})` : `(${a.c})`, t: 'int' };
        }
        if (c.type === 'Identifier' && c.name === 'str') {
          const a = cexpr(node.arguments[0], scope);
          return { c: `swiss_aprintf("%lld", (long long)(${a.c}))`, t: 'string' };
        }
        // browser globals: alert/confirm (bare) → dialog; console.* → no-op
        if (c.type === 'Identifier' && c.name === 'alert') {
          const a = node.arguments[0] ? cexpr(node.arguments[0], scope) : { c: '""' };
          return { c: `swiss_alert(${a.t === 'string' ? a.c : `swiss_aprintf("%lld", (long long)(${a.c}))`})`, t: 'void' };
        }
        if (c.type === 'Identifier' && c.name === 'confirm') {
          const a = node.arguments[0] ? cexpr(node.arguments[0], scope).c : '""';
          return { c: `swiss_confirm(${a})`, t: 'bool' };
        }
        if (c.type === 'MemberExpression' && c.object.name === 'console') return { c: '((void)0)', t: 'void' };
        if (c.type === 'Identifier' && c.name === 'setTheme') {   // setTheme(dark) — dark/light toggle
          const a = node.arguments[0] ? cexpr(node.arguments[0], scope).c : '0';
          return { c: `swiss_set_theme(${a})`, t: 'void' };
        }
        if (c.type === 'MemberExpression' && c.object.name === 'Math') {
          const A = node.arguments.map((x) => cexpr(x, scope).c);
          const m = c.property.name;
          const mm = { floor: 'floor', ceil: 'ceil', round: 'round', abs: 'fabs', sqrt: 'sqrt', pow: 'pow', min: 'fmin', max: 'fmax' }[m];
          if (mm) return { c: `((long long)${mm}(${A.map((x) => `(double)(${x})`).join(', ')}))`, t: 'int' };
          if (m === 'random') return { c: `(rand() / (double)RAND_MAX)`, t: 'float' };
        }
        if (c.type === 'MemberExpression' && c.object.name === 'ezy' && c.property.name === 'call') {
          const fn = node.arguments[0].value;
          out.externs.add(fn);
          const args = node.arguments.slice(1).map((a) => cexpr(a, scope).c);
          const ret = sigs[fn] ? sigs[fn].ret : 'int';
          return { c: `${fn}(${args.join(', ')})`, t: ret === 'string' ? 'string' : ret === 'void' ? 'void' : 'int' };
        }
        if (c.type === 'MemberExpression' && c.object.name === 'swiss') {
          if (c.property.name === 'pickFolder') return { c: 'swiss_pick_folder()', t: 'string' };
          if (c.property.name === 'pickFile') return { c: 'swiss_pick_file()', t: 'string' };
          if (c.property.name === 'setTheme') return { c: `swiss_set_theme(${cexpr(node.arguments[0], scope).c})`, t: 'void' };
          if (c.property.name === 'alert') return { c: `swiss_alert(${cexpr(node.arguments[0], scope).c})`, t: 'void' };
          if (c.property.name === 'confirm') return { c: `swiss_confirm(${cexpr(node.arguments[0], scope).c})`, t: 'bool' };
        }
        if (c.type === 'Identifier' && (c.name === 'setInterval' || c.name === 'setTimeout')) {
          const tl = []; genStmts(node.arguments[0].body, { ...scope }, tl);
          const id = `timer_${hN++}`;
          out.fns.push(`static void ${id}(SwissState* s) {\n  (void)s;\n${tl.join('\n')}\n}`);
          return { c: `swiss_timer_add(${cexpr(node.arguments[1], scope).c}, ${id}, ${c.name === 'setInterval' ? '1' : '0'})`, t: 'int' };
        }
        if (c.type === 'Identifier' && (c.name === 'clearInterval' || c.name === 'clearTimeout'))
          return { c: `swiss_timer_clear(${cexpr(node.arguments[0], scope).c})`, t: 'void' };
        if (c.type === 'MemberExpression') {
          const recv = cexpr(c.object, scope), m = c.property.name;
          const a0 = node.arguments[0] ? cexpr(node.arguments[0], scope).c : null;
          const a1 = node.arguments[1] ? cexpr(node.arguments[1], scope).c : null;
          if (m === 'trim') return { c: `swiss_trim(${recv.c})`, t: 'string' };
          if (m === 'toUpperCase') return { c: `swiss_upper(${recv.c})`, t: 'string' };
          if (m === 'toLowerCase') return { c: `swiss_lower(${recv.c})`, t: 'string' };
          if (m === 'includes') return { c: `(strstr(${recv.c}, ${a0}) != NULL)`, t: 'bool' };
          if (m === 'startsWith') return { c: `swiss_startswith(${recv.c}, ${a0})`, t: 'bool' };
          if (m === 'endsWith') return { c: `swiss_endswith(${recv.c}, ${a0})`, t: 'bool' };
          if (m === 'indexOf') return { c: `swiss_indexof(${recv.c}, ${a0})`, t: 'int' };
          if (m === 'substring' || m === 'slice') return { c: `swiss_substr(${recv.c}, ${a0}, ${a1 || '-1'})`, t: 'string' };
          if (m === 'replace' || m === 'replaceAll') return { c: `swiss_replace(${recv.c}, ${a0}, ${a1})`, t: 'string' };
        }
        err('unsupported call expression', node); break;
      }
      default: err(`unsupported expression '${node.type}'`, node);
    }
  }

  // ── statements → C lines ──
  function genStmts(body, scope, lines) {
    const stmts = body.type === 'BlockStatement' ? body.body
      : /Statement$/.test(body.type) ? [body]
      : [{ type: 'ExpressionStatement', expression: body }];
    for (const st of stmts) genStmt(st, scope, lines);
  }
  function genStmt(st, scope, lines) {
    if (st.type === 'VariableDeclaration') {
      for (const d of st.declarations) {
        const v = cexpr(d.init, scope);
        scope[d.id.name] = { c: d.id.name, t: v.t };
        lines.push(`  ${cType(v.t === 'bool' ? 'int' : v.t)} ${d.id.name} = ${v.c};`);
      }
      return;
    }
    if (st.type === 'IfStatement') {
      const cond = cexpr(st.test, scope);
      lines.push(`  if (${cond.c}) {`);
      genStmts(st.consequent, scope, lines);
      if (st.alternate) { lines.push('  } else {'); genStmts(st.alternate, scope, lines); }
      lines.push('  }');
      return;
    }
    if (st.type === 'ReturnStatement') return;
    if (st.type === 'BreakStatement') { lines.push('  break;'); return; }
    if (st.type === 'ContinueStatement') { lines.push('  continue;'); return; }
    if (st.type === 'SwitchStatement') {
      const d = cexpr(st.discriminant, scope);
      if (d.t === 'string') err('switch on a string is not supported (use if/else)', st);
      lines.push(`  switch (${d.c}) {`);
      for (const cs of st.cases) {
        lines.push(cs.test ? `  case ${cexpr(cs.test, scope).c}:` : '  default:');
        for (const s2 of cs.consequent) genStmt(s2, scope, lines);
      }
      lines.push('  }');
      return;
    }
    if (st.type === 'ForStatement' || st.type === 'WhileStatement') {
      if (st.type === 'WhileStatement') lines.push(`  while (${cexpr(st.test, scope).c}) {`);
      else {
        const sc = { ...scope };
        let initS = '';
        if (st.init && st.init.type === 'VariableDeclaration') { const d = st.init.declarations[0]; sc[d.id.name] = { c: d.id.name, t: 'int' }; initS = `long long ${d.id.name} = ${cexpr(d.init, sc).c}`; }
        const test = st.test ? cexpr(st.test, sc).c : '1';
        lines.push(`  for (${initS}; ${test}; ${st.update && st.update.type === 'UpdateExpression' ? cexpr(st.update.argument, sc).c + st.update.operator : (st.update ? cexpr(st.update, sc).c : '')}) {`);
        scope = sc;
      }
      genStmts(st.body, scope, lines);
      lines.push('  }');
      return;
    }
    if (st.type === 'ExpressionStatement') {
      const e = st.expression;
      if (e.type === 'AssignmentExpression') {
        const v = cexpr(e.right, scope);
        if (e.left.type === 'MemberExpression' && e.left.property.name === 'current' && refByName(e.left.object.name)) {
          lines.push(`  s->${e.left.object.name}__current ${e.operator} ${v.c};`); return;
        }
        if (e.left.type === 'Identifier' && scope[e.left.name]) { lines.push(`  ${e.left.name} ${e.operator} ${v.c};`); return; }
        err('unsupported assignment target', e);
      }
      if (e.type === 'UpdateExpression' && e.argument.type === 'Identifier' && scope[e.argument.name]) { lines.push(`  ${e.argument.name}${e.operator};`); return; }
      if (e.type === 'CallExpression' && e.callee.type === 'MemberExpression' &&
          (e.callee.property.name === 'preventDefault' || e.callee.property.name === 'stopPropagation')) return;
      if (e.type === 'CallExpression' && e.callee.type === 'Identifier' && cellBySetter(e.callee.name)) {
        const cell = cellBySetter(e.callee.name);
        if (cell.t === 'array') { genArraySet(cell, e.arguments[0], scope, lines); lines.push(`  swiss_update_${cell.name}(s);`); return; }
        if (cell.t === 'object') {
          const o = e.arguments[0];
          if (o.type !== 'ObjectExpression') err('setObject expects an object literal', o);
          for (const p of o.properties) {
            if (p.type === 'SpreadElement') continue;
            const fn = p.key.name || p.key.value;
            const f = cell.fields.find((x) => x.name === fn);
            const v = cexpr(p.value, scope);
            lines.push(`  s->${cell.name}.${fn} = ${f && f.t === 'string' ? `swiss_strdup(${v.c})` : v.c};`);
          }
          lines.push(`  swiss_update_${cell.name}(s);`); return;
        }
        const arg = e.arguments[0];
        if (arg.type === 'ArrowFunctionExpression') {
          const sc = { ...scope }; if (arg.params[0]) sc[arg.params[0].name] = { c: `s->${cell.name}`, t: cell.t };
          const ve = arg.body.type === 'BlockStatement' ? (arg.body.body.find((s) => s.type === 'ReturnStatement') || {}).argument : arg.body;
          lines.push(`  s->${cell.name} = ${cexpr(ve, sc).c};`); lines.push(`  swiss_update_${cell.name}(s);`); return;
        }
        const v = cexpr(arg, scope);
        lines.push(`  s->${cell.name} = ${v.c};`);
        lines.push(`  swiss_update_${cell.name}(s);`);
        return;
      }
      if (e.type === 'CallExpression' && e.callee.type === 'Identifier' && methodByName(e.callee.name)) {
        const args = e.arguments.map((a) => cexpr(a, scope).c);
        lines.push(`  method_${e.callee.name}(s${args.length ? ', ' + args.join(', ') : ''});`);
        return;
      }
      const v = cexpr(e, scope);
      lines.push(`  ${v.c};`);
      return;
    }
    err(`unsupported statement '${st.type}'`, st);
  }

  function objLit(cell, obj, scope) {
    const inits = cell.fields.map((f) => {
      const p = obj.properties.find((pr) => (pr.key.name || pr.key.value) === f.name);
      if (!p) return `.${f.name} = ${f.t === 'string' ? '""' : '0'}`;
      const v = cexpr(p.value, scope);
      return `.${f.name} = ${f.t === 'string' ? `swiss_strdup(${v.c})` : v.c}`;
    });
    return `(${cell.struct}){ ${inits.join(', ')} }`;
  }
  function genArraySet(cell, arg, scope, lines) {
    arg = stripParens(arg);
    if (arg.type === 'ArrayExpression') {
      const hasSpread = arg.elements.some((e) => e && e.type === 'SpreadElement');
      if (!hasSpread) lines.push(`  s->${cell.name}.len = 0;`);
      for (const el of arg.elements) {
        if (!el || el.type === 'SpreadElement') continue;
        if (el.type === 'ObjectExpression') lines.push(`  arrpush_${cell.name}(&s->${cell.name}, ${objLit(cell, el, scope)});`);
        else err('array elements must be object literals', el);
      }
      return;
    }
    if (arg.type === 'CallExpression' && arg.callee.type === 'MemberExpression' && arg.callee.property.name === 'filter') {
      const fp = arg.arguments[0].params;
      const rs = { ...scope };
      if (fp[0] && fp[0].name !== '_') rs[fp[0].name] = { rec: `s->${cell.name}.data[_i]`, shape: cell.fields };
      if (fp[1]) rs[fp[1].name] = { c: '_i', t: 'int' };   // (item, index) => …
      const pred = cexpr(stripParens(arg.arguments[0].body), rs).c;
      lines.push(`  { long long _w = 0; for (long long _i = 0; _i < s->${cell.name}.len; _i++) { if (${pred}) s->${cell.name}.data[_w++] = s->${cell.name}.data[_i]; } s->${cell.name}.len = _w; }`);
      return;
    }
    err('unsupported array setState (use [...x, {..}], [{..}], [], or x.filter(...))', arg);
  }

  // React snapshot semantics: within one event handler / helper, a state read
  // sees the render-time value even after setX — setX schedules, it doesn't
  // mutate the binding. The C lowering writes s->cell immediately, so snapshot
  // every scalar cell that's both written and read in this body into a local,
  // and resolve reads to it (writes still target s->cell). Without this,
  // `setDark(!dark); setTheme(!dark)` would read the just-changed value.
  function snapDecls(node, baseScope) {
    const written = new Set();
    walk(node, (n) => { if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && cellBySetter(n.callee.name)) written.add(cellBySetter(n.callee.name).name); });
    const decls = []; const scope = { ...baseScope };
    for (const name of written) {
      const cell = cellByName(name);
      if (!cell || cell.t === 'array' || cell.t === 'object') continue;   // structs mutate in place
      decls.push(`  ${cType(cell.t === 'bool' ? 'int' : cell.t)} _snap_${name} = s->${name};`);
      scope[name] = { c: `_snap_${name}`, t: cell.t };
    }
    return { decls, scope };
  }

  // component helper methods → C functions: method_<name>(SwissState* s, …)
  function emitMethods() {
    for (const m of methods) {
      const params = m.node.params.map((p) => p.name);
      const base = {};
      params.forEach((p) => (base[p] = { c: p, t: 'int' }));
      const { decls, scope } = snapDecls(m.node.body, base);
      const lines = [...decls];
      genStmts(m.node.body, scope, lines);
      const sig = params.map((p) => `long long ${p}`).join(', ');
      out.fns.push(`static void method_${m.name}(SwissState* s${sig ? ', ' + sig : ''}) {\n${lines.join('\n')}\n}`);
    }
  }

  // handler body → C lines. `valName` is the backend's event-value expression
  // (or null). Binds the arrow's value param so the body can read it. The
  // backend wraps these lines in its own callback signature.
  function handlerBody(fn, scope, valName) {
    const lines = [];
    if (fn.type === 'Identifier' && cellBySetter(fn.name)) {
      const cell = cellBySetter(fn.name);
      lines.push(`  s->${cell.name} = ${valName || '0'}; swiss_update_${cell.name}(s);`);
    } else if (fn.type === 'Identifier' && methodByName(fn.name)) {
      const arity = methodByName(fn.name).node.params.length;
      const arg = valName || (arity > 0 ? '0' : '');
      lines.push(`  method_${fn.name}(s${arg ? ', ' + arg : ''});`);
    } else if (fn.type === 'ArrowFunctionExpression') {
      const { decls, scope: hscope } = snapDecls(fn.body, scope);   // React snapshot of written+read cells
      if (valName && fn.params[0]) { lines.push(`  long long ${fn.params[0].name} = ${valName};`); hscope[fn.params[0].name] = { c: fn.params[0].name, t: 'int' }; }
      lines.push(...decls);
      genStmts(fn.body, hscope, lines);
    } else {
      err('handler must be an arrow function or a helper name', fn);
    }
    return lines;
  }

  // useMemo: infer the recomputed type + register a recompute on each dep cell
  for (const c of cells.filter((x) => x.isMemo)) {
    const v = cexpr(c.initNode, {});
    c.t = v.t === 'void' ? 'int' : v.t; c.ctype = cType(c.t);
    for (const dn of c.memoDeps) if (deps[dn]) deps[dn].push(`s->${c.name} = ${v.c}; swiss_update_${c.name}(s);`);
  }

  // all state cells an expression depends on (follows derived consts)
  const cellsIn = (node) => {
    const s = new Set();
    const visit = (n) => walk(n, (x) => { if (x.type === 'Identifier') { if (cellByName(x.name)) s.add(x.name); else if (derived[x.name]) visit(derived[x.name]); } });
    visit(node);
    return s;
  };
  const jsxOf = (n) => { n = stripParens(n); return n && (n.type === 'JSXElement' || n.type === 'JSXFragment') ? n : null; };

  // root JSX of the component
  const rootJSX = () => { let j = null; for (const s of comp.body.body) if (s.type === 'ReturnStatement') j = stripParens(s.argument); if (!j) err('component must return JSX'); return j; };

  return {
    err, sigs, styles, comp, cells, methods, refs, derived, components,
    cellByName, cellBySetter, methodByName, refByName, componentByName,
    arrayCells, objectCells, deps, out, stateFields, vid, nextH,
    cexpr, genStmt, genStmts, genArraySet, objLit, emitMethods, handlerBody,
    cellsIn, jsxOf, tInfer, rootJSX,
  };
}
