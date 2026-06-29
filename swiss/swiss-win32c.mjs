// swiss-win32c — Swiss native Win32 translator (BUILD TIME ONLY; never shipped).
//
// React/JSX ──@babel/parser──▶ AST ──lower──▶ native Win32 C  (no JS engine, no
// GTK). The app links only the Windows system DLLs (user32 / gdi32 / comctl32 /
// comdlg32) — so the .exe is self-contained: no 480MB GTK SDK, no DLL bundle.
//
// Same React semantics as the GTK translator (Svelte-style lowering): useState →
// struct cells, setState → update only the controls that read the cell, .map
// lists → a container rebuilt on change, ezy.call('f',…) → a direct C call into
// the Ezy backend linked in-process.
//
// Win32 has no box layout, so the generated app carries a tiny runtime layout
// engine (a node tree + a two-pass stack/flex layout, re-run on WM_SIZE).
//
// Supported subset (v0.1): function component (default export), useState
// (int/string/bool), object/array state, useMemo, useEffect, useRef, component
// helpers, derived consts, presentational components, View/Text/Button/Input/
// Checkbox/Select/Slider/ProgressBar/TextArea/Separator/Image/List, {expr} text,
// {cond && <X/>} / {a ? <X/> : <Y/>}, {arr.map(...)}, onPress/onChange, reactive
// text/label/disabled/visibility, int()/str()/Math.*, string methods, timers.
//
// Usage:  node swiss-win32c.mjs App.jsx --out frontend.c [--title T] [--sig s.json]
import { parse } from '@babel/parser';
import { readFileSync, writeFileSync, existsSync } from 'fs';

function err(msg, node) {
  const loc = node && node.loc ? ` (line ${node.loc.start.line})` : '';
  throw new Error(`swiss-win32c: ${msg}${loc}`);
}
function cstr(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}
const cType = (t) => (t === 'float' ? 'double' : t === 'string' ? 'const char*' : t === 'void' ? 'void' : 'long long');

function walk(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const k in node) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'leadingComments' || k === 'trailingComments') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, fn));
    else if (v && typeof v.type === 'string') walk(v, fn);
  }
}
const stripParens = (n) => (n && n.type === 'ParenthesizedExpression' ? n.expression : n);

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
function findComponent(ast) {
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

// ───────────────────────── emit ─────────────────────────
function emit(ast, opts) {
  const sigs = opts.sigs || {};
  const styles = collectStyles(ast);
  const comp = findComponent(ast);

  const cells = [];   // useState
  const methods = []; // helper arrows
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
          else if (a.type === 'NullLiteral') { rt = 'widget'; rc = 'HWND'; ci = 'NULL'; }
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

  // array/object record shape inference
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
  for (const c of cells.filter((x) => x.isMemo)) {
    const v = cexpr(c.initNode, {});
    c.t = v.t === 'void' ? 'int' : v.t; c.ctype = cType(c.t);
    for (const dn of c.memoDeps) if (deps[dn]) deps[dn].push(`s->${c.name} = ${v.c}; swiss_update_${c.name}(s);`);
  }

  const stateFields = []; // extra HWND fields in SwissState
  const out = { updates: [], fns: [], build: [], externs: new Set(), lists: [], postShow: [], cmds: [], fonts: new Set(), colors: false };
  let uid = 0; const vid = (p) => `${p}${uid++}`;
  let cmdN = 100;

  // ── expression: returns { c, t } ──
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
        // browser globals: alert/confirm (bare) → MessageBox; console.* → no-op
        if (c.type === 'Identifier' && c.name === 'alert') {
          const a = node.arguments[0] ? cexpr(node.arguments[0], scope) : { c: '""' };
          return { c: `swiss_alert(${a.t === 'string' ? a.c : `swiss_aprintf("%lld", (long long)(${a.c}))`})`, t: 'void' };
        }
        if (c.type === 'Identifier' && c.name === 'confirm') {
          const a = node.arguments[0] ? cexpr(node.arguments[0], scope).c : '""';
          return { c: `swiss_confirm(${a})`, t: 'bool' };
        }
        if (c.type === 'MemberExpression' && c.object.name === 'console') return { c: '((void)0)', t: 'void' };
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

  // ── statement list → C lines ──
  function genStmts(body, scope, lines) {
    // block → its statements; a bare statement (e.g. `if (x) return;`) → itself;
    // a bare expression (arrow `() => expr`) → wrap as an expression statement.
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

  // ── component helper methods → C functions ──
  function emitMethods() {
    for (const m of methods) {
      const params = m.node.params.map((p) => p.name);
      const scope = {};
      params.forEach((p) => (scope[p] = { c: p, t: 'int' }));
      const lines = [];
      genStmts(m.node.body, scope, lines);
      const sig = params.map((p) => `long long ${p}`).join(', ');
      out.fns.push(`static void method_${m.name}(SwissState* s${sig ? ', ' + sig : ''}) {\n${lines.join('\n')}\n}`);
    }
  }

  // ── handlers → C callbacks, dispatched from WndProc by command id ──
  let hN = 0;
  // how each control kind reads its event value (the value passed to onChange)
  const VAL = {
    toggle: '(SendMessageA(w, BM_GETCHECK, 0, 0) == BST_CHECKED)',
    range: '(long long)SendMessageA(w, TBM_GETPOS, 0, 0)',
    combo: '(long long)SendMessageA(w, CB_GETCURSEL, 0, 0)',
  };
  // build a callback body and register it under a fresh command id; returns {id}
  function emitHandler(attrNode, scope, kind) {
    const fn = attrNode.expression;
    const id = `cb_${hN++}`;
    const lines = [];
    const valName = VAL[kind] ? '_v' : null;
    if (fn.type === 'Identifier' && cellBySetter(fn.name)) {
      const cell = cellBySetter(fn.name);
      lines.push(`  s->${cell.name} = ${valName || '0'}; swiss_update_${cell.name}(s);`);
    } else if (fn.type === 'Identifier' && methodByName(fn.name)) {
      const arity = methodByName(fn.name).node.params.length;
      const arg = valName || (arity > 0 ? '0' : '');
      lines.push(`  method_${fn.name}(s${arg ? ', ' + arg : ''});`);
    } else if (fn.type === 'ArrowFunctionExpression') {
      const hscope = { ...scope };
      if (valName && fn.params[0]) { lines.push(`  long long ${fn.params[0].name} = ${valName};`); hscope[fn.params[0].name] = { c: fn.params[0].name, t: 'int' }; }
      genStmts(fn.body, hscope, lines);   // bind the event-value param so the body can read it
    } else {
      err('handler must be an arrow function or a helper name', fn);
    }
    if (scope.__index) lines.unshift(`  long long ${scope.__indexName} = (long long)GetWindowLongPtrA(w, GWLP_USERDATA);`);
    const pre = VAL[kind] ? `  long long _v = ${VAL[kind]}; (void)_v;\n` : '';
    out.fns.push(`static void ${id}(SwissState* s, HWND w) {\n  (void)w;\n${pre}${lines.join('\n')}\n}`);
    return id;
  }
  // register a control's command callback: id → (cb, notification code)
  function command(cbName, code) { const id = cmdN++; out.cmds.push({ id, cb: cbName, code }); return id; }

  // ── styles ──
  function parseInline(obj) {
    const num = (s) => { const m = String(s).match(/-?\d+/); return m ? parseInt(m[0]) : 0; };
    const o = {};
    for (const p of obj.properties) {
      if (p.type !== 'ObjectProperty' && p.type !== 'Property') continue;
      const k = p.key.name || p.key.value;
      const v = p.value;
      const raw = v.type === 'StringLiteral' ? v.value : v.type === 'NumericLiteral' ? v.value : null;
      if (raw == null) continue;
      const s = String(raw);
      if (k === 'padding') o.padding = num(s);
      else if (k === 'margin') { if (/auto/.test(s)) o.alignSelf = 'center'; else o.margin = num(s); }
      else if (k === 'marginTop') o.marginTop = num(s);
      else if (k === 'marginBottom') o.marginBottom = num(s);
      else if (k === 'marginLeft') o.marginLeft = num(s);
      else if (k === 'marginRight') o.marginRight = num(s);
      else if (k === 'alignSelf') o.alignSelf = s;
      else if (k === 'width') { if (s === '100%') o.fillCross = true; else o.width = num(s); }
      else if (k === 'maxWidth' || k === 'minWidth') o.width = num(s);
      else if (k === 'height' || k === 'maxHeight' || k === 'minHeight') o.height = num(s);
      else if (k === 'flex' || k === 'flexGrow') o.flex = num(s);
      else if (k === 'fontSize') o.fontSize = num(s);
      else if (k === 'fontWeight') o.fontWeight = s;
      else if (k === 'color') o.color = s;
      else if (k === 'backgroundColor' || k === 'background') o.backgroundColor = s;
      else if (k === 'borderRadius') o.borderRadius = num(s);
      else if (k === 'textAlign') o.textAlign = s;
      else if (k === 'flexDirection') o.flexDirection = s;
      else if (k === 'gap') o.gap = num(s);
      else if (k === 'alignItems') o.alignItems = s;
      else if (k === 'justifyContent') o.justifyContent = s;
    }
    return o;
  }
  // one style source → object: inline {{…}}, styles.x ref, or [styles.a, styles.b]
  function resolveOne(e) {
    if (!e) return {};
    if (e.type === 'ObjectExpression') return parseInline(e);
    if (e.type === 'MemberExpression' && e.object.name === 'styles') return styles[e.property.name] || {};
    if (e.type === 'ArrayExpression') {
      const names = [];
      for (const el of e.elements) if (el && el.type === 'MemberExpression' && el.object.name === 'styles') names.push(el.property.name);
      return Object.assign({}, ...names.map((n) => styles[n] || {}));
    }
    return {};
  }
  // resolve a style= attr. A ternary `cond ? styles.a : styles.b` takes layout
  // from the consequent and records the condition so dynamic props (color) can
  // be chosen at runtime.
  function resolveStyle(node) {
    if (!node || node.type !== 'JSXExpressionContainer') return null;
    const e = node.expression;
    if (e.type === 'ConditionalExpression') {
      const a = resolveOne(e.consequent), b = resolveOne(e.alternate);
      const merged = { ...a }; merged.__cond = { test: e.test, a, b }; return merged;
    }
    const o = resolveOne(e);
    return Object.keys(o).length ? o : null;
  }

  function attrs(el) { const o = {}; for (const a of el.openingElement.attributes) if (a.type === 'JSXAttribute') o[a.name.name] = a.value; return o; }
  const elName = (el) => el.openingElement.name.name;
  const strAttr = (a) => !a ? '' : a.type === 'StringLiteral' ? a.value : a.type === 'JSXExpressionContainer' && a.expression.type === 'StringLiteral' ? a.expression.value : '';

  // colorref literal from a CSS color (#rgb / #rrggbb / a few names) → 0xBBGGRR
  function colorref(s) {
    if (!s) return null;
    const NAMED = { black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', gray: '808080', grey: '808080' };
    let h = NAMED[String(s).toLowerCase()] || String(s).replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
    out.colors = true;
    return `RGB(0x${r}, 0x${g}, 0x${b})`;
  }
  // emit a font for a style (size/weight) and return its HFONT C expr (cached at runtime)
  function fontFor(st) {
    if (!st || (st.fontSize == null && st.fontWeight == null)) return null;
    const sz = Number(st.fontSize || 0), bold = st.fontWeight === 'bold' || Number(st.fontWeight) >= 600 ? 1 : 0;
    return `swiss_font(${sz}, ${bold})`;
  }
  // style → node-create extra args (layout) + post-create control tweaks
  function nodeArgs(st) {
    const dir = st && st.flexDirection === 'row' ? 1 : 0;
    const pad = Number((st && st.padding) || 0);
    const gap = Number((st && st.gap) || 0);
    const w = st && st.width != null ? Number(st.width) : -1;
    const h = st && st.height != null ? Number(st.height) : -1;
    const flex = st && (st.flex || st.flexGrow) ? Number(st.flex || st.flexGrow) : 0;
    const ALIGN = { center: 1, 'flex-end': 2, end: 2, stretch: 3, start: 0, 'flex-start': 0 };
    const align = st && ALIGN[st.alignItems] != null ? ALIGN[st.alignItems] : (dir === 0 ? 3 : 0); // column default stretch
    const justify = st && ALIGN[st.justifyContent] != null ? ALIGN[st.justifyContent] : 0;
    const selfalign = st && ALIGN[st.alignSelf] != null && ALIGN[st.alignSelf] !== 3 ? ALIGN[st.alignSelf] : 0; // self-align in parent (margin auto / alignSelf)
    const m = Number((st && st.margin) || 0);
    const side = (k) => st && st[k] != null ? Number(st[k]) : m;
    const mt = side('marginTop'), mb = side('marginBottom'), ml = side('marginLeft'), mr = side('marginRight');
    const fillcross = st && (st.fillCross || (st.flex || st.flexGrow)) ? 1 : 0;  // width:100% / flex → fill parent cross-axis
    const radius = st && st.borderRadius ? Number(st.borderRadius) : 0;
    return { dir, pad, gap, w, h, flex, align, justify, selfalign, mt, mb, ml, mr, fillcross, radius };
  }
  // apply font + text color to a freshly created control hwnd expr
  function applyControl(hw, st, kind, scope) {
    // every control gets the common Segoe UI font (default size/weight unless
    // styled) so all controls match the web/gtk default font, not the dated
    // system GUI font.
    const sz = st && st.fontSize ? Number(st.fontSize) : 0;
    const bold = st && (st.fontWeight === 'bold' || Number(st.fontWeight) >= 600) ? 1 : 0;
    out.build.push(`  SendMessageA(${hw}, WM_SETFONT, (WPARAM)swiss_font(${sz}, ${bold}), TRUE);`);
    // text color — static, or chosen at runtime for a `cond ? a : b` style
    let col = st && colorref(st.color);
    const cnd = st && st.__cond;
    if (cnd && (cnd.a.color || cnd.b.color)) {
      const ca = colorref(cnd.a.color) || 'RGB(0,0,0)', cb = colorref(cnd.b.color) || 'RGB(0,0,0)';
      col = `(${cexpr(cnd.test, scope || {}).c} ? ${ca} : ${cb})`;
    }
    if (col) out.build.push(`  swiss_set_color(${hw}, ${col});`);
    // a Text paints opaque on its own backgroundColor, else the inherited panel
    // bg (so text on a colored View shows correctly without transparency)
    const bg = kind === 'text' ? ((st && colorref(st.backgroundColor)) || (scope && scope.__bg)) : null;
    if (bg) out.build.push(`  swiss_set_bg(${hw}, ${bg});`);
  }

  // text children → an snprintf snippet writing into a control's text
  function textSnippet(el, scope, targetExpr) {
    const parts = []; const reads = new Set(); let dynamic = false;
    for (const ch of el.children) {
      if (ch.type === 'JSXText') { const t = ch.value.replace(/\s+/g, ' '); if (t.trim() !== '') parts.push({ lit: t }); }
      else if (ch.type === 'JSXExpressionContainer' && ch.expression.type !== 'JSXEmptyExpression') {
        const v = cexpr(ch.expression, scope); parts.push({ expr: v.c, t: v.t }); dynamic = true;
        cellsIn(ch.expression).forEach((c) => reads.add(c));
      }
    }
    let fmt = ''; const args = [];
    for (const p of parts) { if (p.lit != null) fmt += p.lit.replace(/%/g, '%%'); else { fmt += p.t === 'string' ? '%s' : p.t === 'float' ? '%g' : '%lld'; args.push(p.t === 'string' ? p.expr : p.t === 'float' ? `(double)(${p.expr})` : `(long long)(${p.expr})`); } }
    const snippet = `{ char _b[1024]; snprintf(_b, sizeof _b, ${cstr(fmt)}${args.length ? ', ' + args.join(', ') : ''}); SetWindowTextA(${targetExpr}, _b); }`;
    return { snippet, reads, dynamic, staticText: parts.map((p) => p.lit || '').join('') };
  }

  // create a leaf control HWND (child of the main window) with common styles
  function ctl(cls, style, text, kind) {
    const v = vid('w');
    out.build.push(`  HWND ${v} = CreateWindowExA(0, ${cls}, ${text != null ? text : 'NULL'}, WS_CHILD | WS_VISIBLE${style ? ' | ' + style : ''}, 0, 0, 0, 0, g_main, NULL, g_hinst, NULL);`);
    return v;
  }

  // ── recursive node builder. returns a C expr of type Node* ──
  function build(el, parent, scope) {
    if (el.type === 'JSXFragment') {
      const v = vid('frag');
      out.build.push(`  Node* ${v} = swiss_view(0, 0, 0, -1, -1, 0, 3, 0);`);
      buildChildren(el.children, v, scope);
      if (parent) out.build.push(`  swiss_add(${parent}, ${v});`);
      return v;
    }
    const tag = elName(el);
    const a = attrs(el);
    const cmp = componentByName(tag);
    if (cmp) return inlineComponent(cmp, el, parent, scope);
    const HTMLMAP = {
      div: 'View', section: 'View', main: 'View', header: 'View', footer: 'View', nav: 'View', article: 'View', ul: 'View', ol: 'View', li: 'View', form: 'View',
      h1: 'Text', h2: 'Text', h3: 'Text', h4: 'Text', h5: 'Text', h6: 'Text', p: 'Text', span: 'Text', label: 'Text', a: 'Text', strong: 'Text', small: 'Text',
      input: 'Input', textarea: 'TextArea', button: 'Button', img: 'Image', hr: 'Separator', select: 'Select',
    };
    const name = HTMLMAP[tag] || tag;
    let st = resolveStyle(a.style);
    const HSIZE = { h1: 28, h2: 23, h3: 19, h4: 16 };
    if (HSIZE[tag]) st = Object.assign({ fontSize: HSIZE[tag], fontWeight: 'bold' }, st || {});
    const na = nodeArgs(st);
    const mkNode = (hw) => `swiss_leaf(${hw}, ${na.w}, ${na.h}, ${na.flex})`;
    const selfStep = (nv) => {
      if (na.selfalign) out.build.push(`  ${nv}->selfalign = ${na.selfalign};`);
      if (na.fillcross) out.build.push(`  ${nv}->fillcross = 1;`);
      if (na.radius) out.build.push(`  ${nv}->radius = ${na.radius};`);
      if (na.mt || na.mb || na.ml || na.mr) out.build.push(`  ${nv}->mt = ${na.mt}; ${nv}->mb = ${na.mb}; ${nv}->ml = ${na.ml}; ${nv}->mr = ${na.mr};`);
    };
    // control height: explicit height wins; else derive from vertical padding +
    // font size (the browser/GTK box model — Win32 controls have no CSS padding,
    // so a 10px-padded 16px input must be sized to ~font+2*pad, not a fixed 24).
    const leafH = (fallback) => {
      if (na.h >= 0) return na.h;
      const padV = st && st.padding != null ? Number(st.padding) : 0;
      const fs = st && st.fontSize ? Number(st.fontSize) : 0;
      if (!padV && !fs) return fallback;
      return (fs || 16) + 2 * padV + 8;
    };
    const pack = (nodeExpr) => { if (parent) out.build.push(`  swiss_add(${parent}, ${nodeExpr});`); };
    const dyn = planDynVisible; // (handled in buildCond)

    if (name === 'View' || name === 'Tab') {
      const v = vid('v');
      out.build.push(`  Node* ${v} = swiss_view(${na.dir}, ${na.pad}, ${na.gap}, ${na.flex}, ${na.w}, ${na.h}, ${na.justify}, ${na.align});`);
      const bg = st && colorref(st.backgroundColor);
      if (bg) out.build.push(`  ${v}->bg = ${bg}; ${v}->hasbg = 1;`);
      // propagate the effective panel background to descendants so their text
      // controls paint opaque on the right color (no transparency → no flicker)
      let childScope = { ...scope, __bg: bg || scope.__bg };
      if (tag === 'form' && a.onSubmit) childScope.__form = a.onSubmit;
      buildChildren(el.children, v, childScope);
      selfStep(v); pack(v); return v;
    }
    if (name === 'ScrollView') {  // no native scroll in v0.1 → plain column
      const v = vid('v');
      out.build.push(`  Node* ${v} = swiss_view(0, ${na.pad}, ${na.gap}, 1, -1, -1, ${na.justify}, 3);`);
      buildChildren(el.children, v, scope);
      pack(v); return v;
    }
    if (name === 'Text') {
      const info = textSnippet(el, scope, '');
      const ssAlign = st && st.textAlign === 'center' ? 'SS_CENTER' : st && st.textAlign === 'right' ? 'SS_RIGHT' : 'SS_LEFT';  // honor JSX textAlign (default left)
      if (info.dynamic) {
        if (scope.__inrow) {
          const hw = ctl('"STATIC"', ssAlign, 'NULL', 'text');
          out.build.push(`  ${textSnippet(el, scope, hw).snippet}`);
          applyControl(hw, st, 'text', scope); const n = vid('n');
          out.build.push(`  Node* ${n} = ${mkNode(hw)};`); selfStep(n); pack(n); return n;
        }
        const f = vid('lbl'); stateFields.push(`  HWND ${f};`);
        out.build.push(`  s->${f} = CreateWindowExA(0, "STATIC", NULL, WS_CHILD | WS_VISIBLE | ${ssAlign}, 0, 0, 0, 0, g_main, NULL, g_hinst, NULL);`);
        const real = textSnippet(el, scope, `s->${f}`);
        out.build.push(`  ${real.snippet}`);
        info.reads.forEach((cn) => deps[cn].push(real.snippet));
        applyControl(`s->${f}`, st, 'text', scope);
        const n = vid('n'); out.build.push(`  Node* ${n} = ${mkNode(`s->${f}`)};`); selfStep(n); pack(n); return n;
      }
      const hw = ctl('"STATIC"', ssAlign, cstr(info.staticText), 'text');
      applyControl(hw, st, 'text', scope);
      const n = vid('n'); out.build.push(`  Node* ${n} = ${mkNode(hw)};`); selfStep(n); pack(n); return n;
    }
    if (name === 'Button') {
      let label = '', dynTitle = null;
      if (a.title && a.title.type === 'StringLiteral') label = a.title.value;
      else if (a.title && a.title.type === 'JSXExpressionContainer') { if (a.title.expression.type === 'StringLiteral') label = a.title.expression.value; else dynTitle = a.title.expression; }
      else if (!a.title) label = el.children.filter((c) => c.type === 'JSXText').map((c) => c.value.trim()).filter(Boolean).join(' ');
      let press = a.onPress || a.onClick;
      const isSubmit = strAttr(a.type) === 'submit' && scope.__form;
      if (!press && isSubmit) press = scope.__form;
      const id = press ? command(emitHandler(press, scope, 'click'), 'BN_CLICKED') : 0;
      const hw = vid('w');
      // a styled button (backgroundColor/color) is owner-drawn so it can honor
      // those colors (native Win32 buttons ignore them); plain buttons stay
      // native (themed v6). A submit button is the form default (Enter triggers).
      const bgCol = colorref(st && st.backgroundColor), fgCol = colorref(st && st.color);
      const owner = bgCol || fgCol;
      const bstyle = owner ? 'BS_OWNERDRAW' : isSubmit ? 'BS_DEFPUSHBUTTON' : 'BS_PUSHBUTTON';
      out.build.push(`  HWND ${hw} = CreateWindowExA(0, "BUTTON", ${cstr(label)}, WS_CHILD | WS_VISIBLE | ${bstyle} | WS_TABSTOP, 0, 0, 0, 0, g_main, (HMENU)(INT_PTR)${id}, g_hinst, NULL);`);
      if (owner) out.build.push(`  swiss_btn_style(${hw}, ${bgCol || '0'}, ${bgCol ? 1 : 0}, ${fgCol || '0'}, ${fgCol ? 1 : 0}, ${na.radius});`);
      if (scope.__index) out.build.push(`  SetWindowLongPtrA(${hw}, GWLP_USERDATA, (LONG_PTR)${scope.__index.c});`);
      if (dynTitle) {
        const tv = cexpr(dynTitle, scope);
        const tw = scope.__inrow ? hw : stash(hw);
        const snip = `SetWindowTextA(${tw}, ${tv.t === 'string' ? tv.c : `swiss_aprintf("%lld", (long long)(${tv.c}))`});`;
        out.build.push('  ' + snip);
        if (!scope.__inrow) cellsIn(dynTitle).forEach((cn) => deps[cn] && deps[cn].push(snip));
      }
      if (a.disabled && a.disabled.type === 'JSXExpressionContainer') {
        const bw = scope.__inrow ? hw : stash(hw);
        const snip = `EnableWindow(${bw}, !(${cexpr(a.disabled.expression, scope).c}));`;
        out.build.push(`  ${snip}`); if (!scope.__inrow) cellsIn(a.disabled.expression).forEach((cn) => deps[cn].push(snip));
      }
      applyControl(hw, st, 'btn', scope);
      const n = vid('n'); out.build.push(`  Node* ${n} = swiss_leaf(${hw}, ${na.w}, ${leafH(-1)}, ${na.flex});`); selfStep(n); pack(n); return n;
    }
    if (name === 'Input') {
      const f = vid('ent'); stateFields.push(`  HWND ${f};`);
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      let id = 0;
      if (a.onChange) {
        const h = a.onChange.expression;
        const cb = `cb_${hN++}`;
        const lines = [];
        if (h.type === 'Identifier' && cellBySetter(h.name)) {
          const tc = cellBySetter(h.name);
          lines.push(`  s->${tc.name} = swiss_gettext(w); swiss_update_${tc.name}(s);`);
        } else if (h.type === 'ArrowFunctionExpression') {
          genStmts(h.body, { ...scope, __evtext: `swiss_gettext(w)` }, lines);
        } else err('Input onChange must be a setter or (e)=>setX(e.target.value)', a.onChange);
        out.fns.push(`static void ${cb}(SwissState* s, HWND w) {\n  (void)w;\n${lines.join('\n')}\n}`);
        id = command(cb, 'EN_CHANGE');
      }
      out.build.push(`  s->${f} = CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", NULL, WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL, 0, 0, 0, 0, g_main, (HMENU)(INT_PTR)${id}, g_hinst, NULL);`);
      const ph = strAttr(a.placeholder);
      if (ph) out.build.push(`  SendMessageW(s->${f}, EM_SETCUEBANNER, TRUE, (LPARAM)L${cwstr(ph)});`);
      if (cell) {
        out.build.push(`  SetWindowTextA(s->${f}, ${cell.t === 'string' ? `s->${cell.name}` : '""'});`);
        deps[cell.name].push(`{ char* _t = swiss_gettext(s->${f}); if (strcmp(_t, s->${cell.name}) != 0) SetWindowTextA(s->${f}, s->${cell.name}); free(_t); }`);
      }
      applyControl(`s->${f}`, st, 'edit', scope);
      const nh = leafH(24);   // width auto (-1) → fills a stretch parent; height from padding+font
      const n = vid('n'); out.build.push(`  Node* ${n} = swiss_leaf(s->${f}, ${na.w}, ${nh}, ${na.flex});`); selfStep(n); pack(n); return n;
    }
    if (name === 'TextArea') {
      const f = vid('ta'); stateFields.push(`  HWND ${f};`);
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      let id = 0;
      if (a.onChange && a.onChange.expression.type === 'Identifier' && cellBySetter(a.onChange.expression.name)) {
        const tc = cellBySetter(a.onChange.expression.name);
        const cb = `cb_${hN++}`;
        out.fns.push(`static void ${cb}(SwissState* s, HWND w) {\n  s->${tc.name} = swiss_gettext(w); swiss_update_${tc.name}(s);\n}`);
        id = command(cb, 'EN_CHANGE');
      }
      out.build.push(`  s->${f} = CreateWindowExA(WS_EX_CLIENTEDGE, "EDIT", NULL, WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_MULTILINE | ES_AUTOVSCROLL | WS_VSCROLL, 0, 0, 0, 0, g_main, (HMENU)(INT_PTR)${id}, g_hinst, NULL);`);
      if (cell) {
        out.build.push(`  SetWindowTextA(s->${f}, s->${cell.name});`);
        deps[cell.name].push(`{ char* _t = swiss_gettext(s->${f}); if (strcmp(_t, s->${cell.name}) != 0) SetWindowTextA(s->${f}, s->${cell.name}); free(_t); }`);
      }
      applyControl(`s->${f}`, st, 'edit', scope);
      const nh = na.h < 0 ? 80 : na.h;
      const n = vid('n'); out.build.push(`  Node* ${n} = swiss_leaf(s->${f}, ${na.w}, ${nh}, ${na.flex || 1});`); selfStep(n); pack(n); return n;
    }
    if (name === 'Checkbox' || name === 'Switch') {
      const f = vid('chk'); stateFields.push(`  HWND ${f};`);
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      const id = a.onChange ? command(emitHandler(a.onChange, scope, 'toggle'), 'BN_CLICKED') : 0;
      out.build.push(`  s->${f} = CreateWindowExA(0, "BUTTON", ${cstr(strAttr(a.label))}, WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX | WS_TABSTOP, 0, 0, 0, 0, g_main, (HMENU)(INT_PTR)${id}, g_hinst, NULL);`);
      if (cell) {
        out.build.push(`  SendMessageA(s->${f}, BM_SETCHECK, s->${cell.name} ? BST_CHECKED : BST_UNCHECKED, 0);`);
        deps[cell.name].push(`SendMessageA(s->${f}, BM_SETCHECK, s->${cell.name} ? BST_CHECKED : BST_UNCHECKED, 0);`);
      }
      applyControl(`s->${f}`, st, 'text', scope);
      const n = vid('n'); out.build.push(`  Node* ${n} = swiss_leaf(s->${f}, ${na.w}, ${na.h < 0 ? 22 : na.h}, ${na.flex});`); selfStep(n); pack(n); return n;
    }
    if (name === 'Select') {
      const f = vid('cmb'); stateFields.push(`  HWND ${f};`);
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      const id = a.onChange ? command(emitHandler(a.onChange, scope, 'combo'), 'CBN_SELCHANGE') : 0;
      out.build.push(`  s->${f} = CreateWindowExA(0, "COMBOBOX", NULL, WS_CHILD | WS_VISIBLE | WS_TABSTOP | CBS_DROPDOWNLIST | WS_VSCROLL, 0, 0, 0, 0, g_main, (HMENU)(INT_PTR)${id}, g_hinst, NULL);`);
      const opts = a.options && a.options.expression && a.options.expression.type === 'ArrayExpression' ? a.options.expression.elements : [];
      for (const o of opts) out.build.push(`  SendMessageA(s->${f}, CB_ADDSTRING, 0, (LPARAM)${cstr(o.value)});`);
      if (cell) {
        out.build.push(`  SendMessageA(s->${f}, CB_SETCURSEL, s->${cell.name}, 0);`);
        deps[cell.name].push(`if (SendMessageA(s->${f}, CB_GETCURSEL, 0, 0) != s->${cell.name}) SendMessageA(s->${f}, CB_SETCURSEL, s->${cell.name}, 0);`);
      }
      const n = vid('n'); out.build.push(`  Node* ${n} = swiss_leaf(s->${f}, ${na.w}, ${na.h < 0 ? 24 : na.h}, ${na.flex});`); selfStep(n); pack(n); return n;
    }
    if (name === 'Slider') {
      const f = vid('sl'); stateFields.push(`  HWND ${f};`);
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      const min = Number(strAttr(a.min) || (a.min && a.min.expression && a.min.expression.value) || 0);
      const max = Number(strAttr(a.max) || (a.max && a.max.expression && a.max.expression.value) || 100);
      out.build.push(`  s->${f} = CreateWindowExA(0, TRACKBAR_CLASS, NULL, WS_CHILD | WS_VISIBLE | WS_TABSTOP | TBS_HORZ, 0, 0, 0, 0, g_main, NULL, g_hinst, NULL);`);
      out.build.push(`  SendMessageA(s->${f}, TBM_SETRANGE, TRUE, MAKELONG(${min}, ${max}));`);
      if (cell) {
        out.build.push(`  SendMessageA(s->${f}, TBM_SETPOS, TRUE, s->${cell.name});`);
        deps[cell.name].push(`if ((long long)SendMessageA(s->${f}, TBM_GETPOS, 0, 0) != s->${cell.name}) SendMessageA(s->${f}, TBM_SETPOS, TRUE, s->${cell.name});`);
      }
      if (a.onChange) { const cb = emitHandler(a.onChange, scope, 'range'); out.build.push(`  swiss_track(s->${f}, ${cb});`); }
      const n = vid('n'); out.build.push(`  Node* ${n} = swiss_leaf(s->${f}, ${na.w}, ${na.h < 0 ? 28 : na.h}, ${na.flex});`); selfStep(n); pack(n); return n;
    }
    if (name === 'ProgressBar') {
      const f = vid('pb'); stateFields.push(`  HWND ${f};`);
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      const max = Number(strAttr(a.max) || (a.max && a.max.expression && a.max.expression.value) || 100);
      out.build.push(`  s->${f} = CreateWindowExA(0, PROGRESS_CLASS, NULL, WS_CHILD | WS_VISIBLE, 0, 0, 0, 0, g_main, NULL, g_hinst, NULL);`);
      out.build.push(`  SendMessageA(s->${f}, PBM_SETRANGE, 0, MAKELPARAM(0, ${max}));`);
      if (cell) {
        const setf = `SendMessageA(s->${f}, PBM_SETPOS, (WPARAM)s->${cell.name}, 0);`;
        out.build.push(`  ${setf}`); deps[cell.name].push(setf);
      }
      const n = vid('n'); out.build.push(`  Node* ${n} = swiss_leaf(s->${f}, ${na.w}, ${na.h < 0 ? 22 : na.h}, ${na.flex});`); selfStep(n); pack(n); return n;
    }
    if (name === 'Separator') {
      const hw = ctl('"STATIC"', 'SS_ETCHEDHORZ', 'NULL', 'other');
      const n = vid('n'); out.build.push(`  Node* ${n} = swiss_leaf(${hw}, ${na.w}, ${na.h < 0 ? 2 : na.h}, ${na.flex});`); selfStep(n); pack(n); return n;
    }
    if (name === 'Image') {
      const f = vid('img');
      out.build.push(`  HWND ${f} = CreateWindowExA(0, "STATIC", NULL, WS_CHILD | WS_VISIBLE | SS_BITMAP | SS_REALSIZECONTROL, 0, 0, 0, 0, g_main, NULL, g_hinst, NULL);`);
      out.build.push(`  swiss_set_image(${f}, ${cstr(strAttr(a.src))});`);
      const n = vid('n'); out.build.push(`  Node* ${n} = swiss_leaf(${f}, ${na.w < 0 ? 120 : na.w}, ${na.h < 0 ? 120 : na.h}, ${na.flex});`); selfStep(n); pack(n); return n;
    }
    if (name === 'List') {
      const countExpr = a.count.expression;
      const countCell = countExpr.type === 'Identifier' ? cellByName(countExpr.name) : null;
      const itemFn = a.item.expression;
      const idxName = itemFn.params[0] ? itemFn.params[0].name : 'i';
      const box = vid('list'); stateFields.push(`  Node* ${box};`);
      out.build.push(`  s->${box} = swiss_view(0, ${na.pad}, ${na.gap || 6}, ${na.flex}, ${na.w}, ${na.h}, ${na.justify}, 3);`);
      const rowFn = `swiss_row_${out.lists.length}`;
      const rebuildFn = `swiss_list_rebuild_${out.lists.length}`;
      out.lists.push({ box, rowFn, rebuildFn, itemFn, idxName, countCell, bg: st && colorref(st.backgroundColor) || scope.__bg });
      if (countCell) deps[countCell.name].push(`${rebuildFn}(s);`);
      pack(`s->${box}`); return `s->${box}`;
    }
    err(`unsupported component <${name}>`, el);
  }
  const planDynVisible = true;

  // ── children loop ──
  const cellsIn = (node) => {
    const s = new Set();
    const visit = (n) => walk(n, (x) => { if (x.type === 'Identifier') { if (cellByName(x.name)) s.add(x.name); else if (derived[x.name]) visit(derived[x.name]); } });
    visit(node);
    return s;
  };
  const jsxOf = (n) => { n = stripParens(n); return n && (n.type === 'JSXElement' || n.type === 'JSXFragment') ? n : null; };
  function buildChildren(children, parentVar, scope) {
    for (const ch of children) {
      if (ch.type === 'JSXElement' || ch.type === 'JSXFragment') { build(ch, parentVar, scope); continue; }
      if (ch.type === 'JSXExpressionContainer' && ch.expression.type !== 'JSXEmptyExpression') {
        const ex = stripParens(ch.expression);
        if (scope.__children && ((ex.type === 'Identifier' && ex.name === 'children') ||
            (ex.type === 'MemberExpression' && ex.object.name === 'props' && ex.property.name === 'children'))) {
          buildChildren(scope.__children.nodes, parentVar, scope.__children.scope); continue;
        }
        if (ex.type === 'CallExpression' && ex.callee.type === 'MemberExpression' && ex.callee.property.name === 'map') {
          const o = ex.callee.object;
          if (o.type === 'Identifier' && cellByName(o.name) && cellByName(o.name).t === 'array') { buildMap(ex, parentVar, scope, o.name, null); continue; }
          if (o.type === 'CallExpression' && o.callee.type === 'MemberExpression' && o.callee.property.name === 'filter' &&
              o.callee.object.type === 'Identifier' && cellByName(o.callee.object.name) && cellByName(o.callee.object.name).t === 'array') {
            buildMap(ex, parentVar, scope, o.callee.object.name, o.arguments[0]); continue;
          }
        }
        buildCond(ch.expression, parentVar, scope);
      }
    }
  }
  function buildMap(ex, parent, scope, arrName, filterArrow) {
    const cell = cellByName(arrName);
    const itName = ex.arguments[0].params[0] ? ex.arguments[0].params[0].name : 'it';
    const idxParam = ex.arguments[0].params[1] ? ex.arguments[0].params[1].name : null;
    const itemJSX = stripParens(ex.arguments[0].body);
    const box = vid('map'); stateFields.push(`  Node* ${box};`);
    out.build.push(`  s->${box} = swiss_view(0, 0, 6, 0, -1, -1, 0, 3);`);
    if (parent) out.build.push(`  swiss_add(${parent}, s->${box});`);
    out.lists.push({ kind: 'map', box, rowFn: `swiss_map_${out.lists.length}`, rebuildFn: `swiss_maprebuild_${out.lists.length}`, itemJSX, itName, idxParam, cell, filterArrow, bg: scope.__bg });
    const L = out.lists[out.lists.length - 1];
    const reads = cellsIn(itemJSX); reads.add(cell.name);
    if (filterArrow) cellsIn(filterArrow.body).forEach((c) => reads.add(c));
    reads.forEach((cn) => { if (deps[cn] && !deps[cn].includes(`${L.rebuildFn}(s);`)) deps[cn].push(`${L.rebuildFn}(s);`); });
  }
  function inlineComponent(comp, el, parent, callerScope) {
    const a = attrs(el);
    const scope = {};
    const param = comp.node.params[0];
    if (param && param.type === 'ObjectPattern') {
      for (const pr of param.properties) {
        const key = pr.key.name, av = a[key];
        scope[key] = av === undefined ? { c: '0', t: 'int' }
          : av.type === 'JSXExpressionContainer' ? cexpr(av.expression, callerScope)
          : { c: cstr(av.value), t: 'string' };
      }
    } else if (param && param.type === 'Identifier') {
      scope.__props = {};
      for (const k in a) { const av = a[k]; scope.__props[k] = av.type === 'JSXExpressionContainer' ? cexpr(av.expression, callerScope) : { c: cstr(av.value), t: 'string' }; }
    }
    scope.__children = { nodes: el.children, scope: callerScope };
    const body = comp.node.body;
    const jsx = body.type === 'BlockStatement' ? (body.body.find((s) => s.type === 'ReturnStatement') || {}).argument : body;
    return build(stripParens(jsx), parent, scope);
  }
  // store a built node's control HWND in state so visibility snippets can reach it
  const stash = (hw) => { const f = vid('cond'); stateFields.push(`  HWND ${f};`); out.build.push(`  s->${f} = ${hw};`); return `s->${f}`; };
  // store a built Node* in state so reactive snippets (run outside swiss_build_ui) reach it
  const stashNode = (node) => { if (String(node).startsWith('s->')) return node; const f = vid('cnode'); stateFields.push(`  Node* ${f};`); out.build.push(`  s->${f} = ${node};`); return `s->${f}`; };
  // {cond && <X/>} and {a ? <X/> : <Y/>} → build + reactive ShowWindow (+ relayout)
  function buildCond(expr, parentVar, scope) {
    expr = stripParens(expr);
    if (scope.__inrow) {
      if (expr.type === 'LogicalExpression' && expr.operator === '&&') {
        const el = jsxOf(expr.right); if (!el) return;
        const at = out.build.length; build(el, parentVar, scope); const sl = out.build.splice(at);
        out.build.push(`  if (${cexpr(expr.left, scope).c}) {`, ...sl, '  }'); return;
      }
      if (expr.type === 'ConditionalExpression') {
        const ae = jsxOf(expr.consequent), be = jsxOf(expr.alternate);
        if (ae && be) {
          const at = out.build.length; build(ae, parentVar, scope); const sa = out.build.splice(at);
          build(be, parentVar, scope); const sb = out.build.splice(at);
          out.build.push(`  if (${cexpr(expr.test, scope).c}) {`, ...sa, '  } else {', ...sb, '  }'); return;
        }
      }
    }
    if (expr.type === 'LogicalExpression' && expr.operator === '&&') {
      const el = jsxOf(expr.right); if (!el) return;
      const node = stashNode(build(el, parentVar, scope));
      const snip = `swiss_node_show(${node}, (${cexpr(expr.left, scope).c}));`;
      out.postShow.push(snip);
      cellsIn(expr.left).forEach((cn) => deps[cn].push(snip));
      return;
    }
    if (expr.type === 'ConditionalExpression') {
      const ae = jsxOf(expr.consequent), be = jsxOf(expr.alternate);
      if (ae && be) {
        const na = stashNode(build(ae, parentVar, scope)), nb = stashNode(build(be, parentVar, scope));
        const snip = `{ int _c = (${cexpr(expr.test, scope).c}); swiss_node_show(${na}, _c); swiss_node_show(${nb}, !_c); }`;
        out.postShow.push(snip);
        cellsIn(expr.test).forEach((cn) => deps[cn].push(snip));
        return;
      }
    }
    err('only {cond && <El/>} or {cond ? <A/> : <B/>} JSX expression children are supported', expr);
  }

  // ── list/map row builders ──
  function emitLists() {
    for (const L of out.lists) {
      const saved = out.build; out.build = [];
      let idxVar, jsx, rowScope, countC, skip = '';
      if (L.kind === 'map') {
        idxVar = '_mi';
        rowScope = { __index: { c: idxVar, t: 'int' }, __indexName: idxVar, __inrow: true };
        rowScope[L.itName] = { rec: `s->${L.cell.name}.data[${idxVar}]`, shape: L.cell.fields };
        if (L.idxParam) rowScope[L.idxParam] = { c: idxVar, t: 'int' };
        jsx = L.itemJSX; countC = `s->${L.cell.name}.len`;
        if (L.filterArrow) {
          const fs = { ...rowScope }; const fp = L.filterArrow.params[0];
          if (fp) fs[fp.name] = { rec: `s->${L.cell.name}.data[${idxVar}]`, shape: L.cell.fields };
          skip = `    if (!(${cexpr(stripParens(L.filterArrow.body), fs).c})) continue;\n`;
        }
      } else {
        idxVar = L.idxName;
        rowScope = { __index: { c: idxVar, t: 'int' }, __indexName: idxVar, __inrow: true };
        rowScope[idxVar] = { c: idxVar, t: 'int' };
        jsx = L.itemFn.body; countC = L.countCell ? 's->' + L.countCell.name : '0';
      }
      if (L.bg) rowScope.__bg = L.bg;   // rows inherit the list container's panel bg (opaque text)
      const rootVar = build(stripParens(jsx), null, rowScope);
      const rowBody = out.build; out.build = saved;
      out.fns.push(`static Node* ${L.rowFn}(SwissState* s, long long ${idxVar}) {\n${rowBody.join('\n')}\n  return ${rootVar};\n}`);
      out.fns.push(
        `static void ${L.rebuildFn}(SwissState* s) {\n` +
        `  swiss_node_clear(s->${L.box});\n` +
        `  for (long long ${idxVar} = 0; ${idxVar} < ${countC}; ${idxVar}++) {\n` +
        skip +
        `    swiss_add(s->${L.box}, ${L.rowFn}(s, ${idxVar}));\n` +
        `  }\n  swiss_relayout();\n}`
      );
    }
  }

  // ── go ──
  emitMethods();
  const rootJSX = (() => { let j = null; for (const s of comp.body.body) if (s.type === 'ReturnStatement') j = stripParens(s.argument); if (!j) err('component must return JSX'); return j; })();
  const rootVar = build(rootJSX, null, {});
  emitLists();

  // useEffect(fn, deps) → run at startup, re-run on listed cell changes
  const initLines = [];
  let effN = 0;
  for (const s of comp.body.body)
    walk(s, (n) => {
      if (n.type === 'CallExpression' && n.callee.name === 'useEffect') {
        const id = `swiss_effect_${effN++}`;
        const lines = [];
        genStmts(n.arguments[0].body, {}, lines);
        out.fns.push(`static void ${id}(SwissState* s) {\n${lines.join('\n')}\n}`);
        initLines.push(`  ${id}(s);`);
        const da = n.arguments[1];
        if (da && da.type === 'ArrayExpression')
          for (const d of da.elements) { const cell = d.type === 'Identifier' ? cellByName(d.name) : null; if (cell) deps[cell.name].push(`${id}(s);`); }
      }
    });

  const initCellLines = cells.filter((c) => c.initNode).map((c) => `  s->${c.name} = ${cexpr(c.initNode, {}).c};`);
  for (const c of objectCells)
    if (c.initObj) for (const p of c.initObj.properties) {
      if (p.type === 'SpreadElement' || !p.key) continue;
      const fn = p.key.name || p.key.value; const f = c.fields.find((x) => x.name === fn);
      initCellLines.push(`  s->${c.name}.${fn} = ${f && f.t === 'string' ? `swiss_strdup(${cexpr(p.value, {}).c})` : cexpr(p.value, {}).c};`);
    }
  // seed initial array-state elements (useState([{…}, …]))
  for (const c of arrayCells)
    if (c.initArr) for (const el of c.initArr.elements)
      if (el && el.type === 'ObjectExpression') initCellLines.push(`  arrpush_${c.name}(&s->${c.name}, ${objLit(c, el, {})});`);
  // render seeded list/map rows once at startup (before any state change)
  for (const L of out.lists) initLines.push(`  ${L.rebuildFn}(s);`);

  // every cell-update ends by re-running layout (text/visibility can change size)
  for (const c of cells)
    out.updates.push(`static void swiss_update_${c.name}(SwissState* s) {\n${deps[c.name].map((d) => '  ' + d).join('\n')}\n  swiss_relayout();\n}`);

  const externDecls = [...out.externs].map((f) => {
    const s = sigs[f]; if (!s) return `extern long long ${f}();`;
    return `extern ${cType(s.ret)} ${f}(${s.args.length ? s.args.map(cType).join(', ') : 'void'});`;
  }).join('\n');

  // WM_COMMAND dispatch table (buttons / edits / checkboxes / combos)
  const cmdCases = out.cmds.map((cd) =>
    `    if (LOWORD(wp) == ${cd.id} && HIWORD(wp) == ${cd.code}) { ${cd.cb}(&S, (HWND)lp); return 0; }`
  ).join('\n');

  return `// Generated by swiss-win32c — do not edit.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>
#include <shlobj.h>
#include <commdlg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <ctype.h>
#include <limits.h>
#include <math.h>

${externDecls || '// (no ezy backend calls)'}

${objectCells.map((c) => `typedef struct { ${c.fields.map((f) => `${f.ctype} ${f.name};`).join(' ') || 'int _u;'} } ${c.struct};`).join('\n')}
${arrayCells.map((c) =>
  `typedef struct { ${c.fields.map((f) => `${f.ctype} ${f.name};`).join(' ') || 'int _u;'} } ${c.struct};\n` +
  `typedef struct { ${c.struct}* data; long long len, cap; } ${c.arrtype};\n` +
  `static void arrpush_${c.name}(${c.arrtype}* a, ${c.struct} v) { if (a->len >= a->cap) { a->cap = a->cap ? a->cap * 2 : 8; a->data = realloc(a->data, a->cap * sizeof(${c.struct})); } a->data[a->len++] = v; }`
).join('\n')}

// ── runtime layout node tree (stack/flex, recomputed on resize) ──
typedef struct Node {
  HWND hwnd;                 // control window (NULL for a pure container)
  struct Node** kids; int nkids, kcap;
  int dir, pad, gap;         // dir: 0=column 1=row
  int w, h, flex;            // requested size (-1 auto) + main-axis grow factor
  int justify, align;        // main / cross alignment (0 start 1 center 2 end 3 stretch)
  int selfalign;             // self cross-align in parent (0 inherit, 1 center, 2 end) — margin auto / alignSelf
  int fillcross;             // fill parent cross-axis (width:100% / flex) — else content-sized (web inline-block)
  int radius;                // borderRadius (px) — rounded via a window region
  int mt, mb, ml, mr;        // margins (outer spacing around the node)
  int rx, ry, rw, rh;        // last laid-out rect (for background painting)
  COLORREF bg; int hasbg, visible;
} Node;

static HINSTANCE g_hinst;
static HWND g_main;
static Node* g_root;

static Node* swiss_node_new(void) { Node* n = (Node*)calloc(1, sizeof(Node)); n->w = n->h = -1; n->visible = 1; return n; }
static Node* swiss_view(int dir, int pad, int gap, int flex, int w, int h, int justify, int align) {
  Node* n = swiss_node_new(); n->dir = dir; n->pad = pad; n->gap = gap; n->flex = flex; n->w = w; n->h = h; n->justify = justify; n->align = align; return n;
}
static Node* swiss_leaf(HWND hwnd, int w, int h, int flex) { Node* n = swiss_node_new(); n->hwnd = hwnd; n->w = w; n->h = h; n->flex = flex; return n; }
static void swiss_add(Node* p, Node* c) {
  if (p->nkids >= p->kcap) { p->kcap = p->kcap ? p->kcap * 2 : 8; p->kids = (Node**)realloc(p->kids, p->kcap * sizeof(Node*)); }
  p->kids[p->nkids++] = c;
}
static void swiss_node_show(Node* n, int show) { n->visible = show ? 1 : 0; if (n->hwnd) ShowWindow(n->hwnd, show ? SW_SHOW : SW_HIDE); }
static void swiss_node_free(Node* n) {
  for (int i = 0; i < n->nkids; i++) swiss_node_free(n->kids[i]);
  if (n->hwnd) DestroyWindow(n->hwnd);
  free(n->kids); free(n);
}
static void swiss_node_clear(Node* n) { for (int i = 0; i < n->nkids; i++) swiss_node_free(n->kids[i]); n->nkids = 0; }

// natural (measured) size of a leaf control, by its window class + text
static void swiss_measure_leaf(Node* n, int* mw, int* mh) {
  char cls[64] = {0}; GetClassNameA(n->hwnd, cls, sizeof cls);
  int isbtn = !lstrcmpiA(cls, "BUTTON"), isstat = !lstrcmpiA(cls, "STATIC");
  int tw = 0, th = 18;
  if (isbtn || isstat) {
    char buf[1024]; int len = GetWindowTextA(n->hwnd, buf, sizeof buf);
    HDC dc = GetDC(n->hwnd); HFONT f = (HFONT)SendMessageA(n->hwnd, WM_GETFONT, 0, 0);
    HGDIOBJ old = f ? SelectObject(dc, f) : NULL; SIZE sz = {0, 0};
    GetTextExtentPoint32A(dc, buf, len, &sz); if (old) SelectObject(dc, old); ReleaseDC(n->hwnd, dc);
    tw = sz.cx; th = sz.cy ? sz.cy : 18;
  }
  *mw = (n->w >= 0) ? n->w : (isbtn ? tw + 28 : isstat ? tw + 2 : 160);
  *mh = (n->h >= 0) ? n->h : (isbtn ? th + 12 : th);
}

static void swiss_measure(Node* n, int* mw, int* mh) {
  if (n->hwnd) { swiss_measure_leaf(n, mw, mh); return; }
  int main = 0, cross = 0, vis = 0;
  for (int i = 0; i < n->nkids; i++) {
    Node* k = n->kids[i]; if (!k->visible) continue;
    int cw, ch; swiss_measure(k, &cw, &ch);
    int cm = (n->dir ? cw : ch) + (n->dir ? k->ml + k->mr : k->mt + k->mb);  // + main-axis margins
    int cc = (n->dir ? ch : cw) + (n->dir ? k->mt + k->mb : k->ml + k->mr);  // + cross-axis margins
    main += cm; if (cc > cross) cross = cc; vis++;
  }
  if (vis > 1) main += n->gap * (vis - 1);
  main += 2 * n->pad; cross += 2 * n->pad;
  int w = n->dir ? main : cross, h = n->dir ? cross : main;
  *mw = (n->w >= 0) ? n->w : w; *mh = (n->h >= 0) ? n->h : h;
}

static void swiss_arrange(Node* n, int x, int y, int w, int h) {
  int moved = (n->rx != x || n->ry != y || n->rw != w || n->rh != h);  // skip no-op moves (less flicker)
  n->rx = x; n->ry = y; n->rw = w; n->rh = h;   // remember rect for bg painting
  if (n->hwnd) {
    if (moved) {
      MoveWindow(n->hwnd, x, y, w, h, TRUE);
      if (n->radius > 0)  // borderRadius → clip the control to a rounded rect
        SetWindowRgn(n->hwnd, CreateRoundRectRgn(0, 0, w + 1, h + 1, n->radius * 2, n->radius * 2), TRUE);
    }
    return;
  }
  int ix = x + n->pad, iy = y + n->pad, iw = w - 2 * n->pad, ih = h - 2 * n->pad;
  int avail = n->dir ? iw : ih;
  int used = 0, vis = 0, totflex = 0;
  for (int i = 0; i < n->nkids; i++) {
    Node* k = n->kids[i]; if (!k->visible) continue;
    int cw, ch; swiss_measure(k, &cw, &ch);
    used += (n->dir ? cw : ch) + (n->dir ? k->ml + k->mr : k->mt + k->mb);  // + main-axis margins
    vis++; totflex += k->flex;
  }
  if (vis > 1) used += n->gap * (vis - 1);
  int extra = avail - used; if (extra < 0) extra = 0;
  int cursor = n->dir ? ix : iy;
  if (!totflex) { if (n->justify == 1) cursor += extra / 2; else if (n->justify == 2) cursor += extra; }
  for (int i = 0; i < n->nkids; i++) {
    Node* c = n->kids[i]; if (!c->visible) continue;
    int cw, ch; swiss_measure(c, &cw, &ch);
    int cm = n->dir ? cw : ch, cc = n->dir ? ch : cw;
    if (c->flex && totflex) cm += extra * c->flex / totflex;
    int leadM = n->dir ? c->ml : c->mt, trailM = n->dir ? c->mr : c->mb;   // main-axis margins
    int leadC = n->dir ? c->mt : c->ml, trailC = n->dir ? c->mb : c->mr;   // cross-axis margins
    int crossSpace = (n->dir ? ih : iw) - leadC - trailC;                   // cross room after this child's margins
    int hasCross = n->dir ? (c->h >= 0) : (c->w >= 0);  // explicit cross size set?
    int isLeaf = (c->hwnd != NULL);
    // fill the cross axis only if asked (fillcross / width:100% / flex) or a
    // container under a stretch parent (block-like); leaves are content-sized
    // by default (web inline-block), aligned to the start.
    int doStretch = !hasCross && (c->fillcross || (!isLeaf && (c->align == 3 || n->align == 3)));
    int co; // cross-axis offset within crossSpace
    if (c->selfalign) {                                  // self-align overrides parent (margin auto / alignSelf)
      co = c->selfalign == 1 ? (crossSpace - cc) / 2 : crossSpace - cc;
    } else if (doStretch) {
      cc = crossSpace; co = 0;
    } else if (n->align == 1) co = (crossSpace - cc) / 2;
    else if (n->align == 2) co = crossSpace - cc;
    else co = 0;
    if (co < 0) co = 0;
    cursor += leadM;                                     // leading main margin before placing
    if (n->dir) swiss_arrange(c, cursor, iy + leadC + co, cm, cc);
    else        swiss_arrange(c, ix + leadC + co, cursor, cc, cm);
    cursor += cm + trailM + n->gap;                      // trailing main margin after
  }
}

static void swiss_relayout(void) {
  if (!g_root || !g_main) return;
  RECT rc; GetClientRect(g_main, &rc);
  int W = rc.right - rc.left, H = rc.bottom - rc.top;
  // honor the root's own width/height (e.g. maxWidth) + self-align (margin auto)
  int rw = (g_root->w >= 0 && g_root->w < W) ? g_root->w : W;
  int rh = (g_root->h >= 0 && g_root->h < H) ? g_root->h : H;
  int rx = 0;
  if (rw < W) { if (g_root->selfalign == 1) rx = (W - rw) / 2; else if (g_root->selfalign == 2) rx = W - rw; }
  swiss_arrange(g_root, rx, 0, rw, rh);
  // repaint backgrounds (WM_PAINT double-buffers; erase suppressed) so vacated
  // areas clear without the full-white-flash flicker of an erasing invalidate
  InvalidateRect(g_main, NULL, FALSE);
}

// ── font cache (size 0 = default UI size) ──
static struct { int px, bold; HFONT f; } g_fonts[64]; static int g_nfonts;
static HFONT swiss_font(int px, int bold) {
  for (int i = 0; i < g_nfonts; i++) if (g_fonts[i].px == px && g_fonts[i].bold == bold) return g_fonts[i].f;
  int h = px ? -MulDiv(px, 96, 72) : -15;
  HFONT f = CreateFontA(h, 0, 0, 0, bold ? FW_BOLD : FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET,
    OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, "Segoe UI");
  if (g_nfonts < 64) { g_fonts[g_nfonts].px = px; g_fonts[g_nfonts].bold = bold; g_fonts[g_nfonts].f = f; g_nfonts++; }
  return f;
}

// ── per-control text color (applied via WM_CTLCOLORSTATIC) ──
static struct { HWND w; COLORREF c; } g_colors[128]; static int g_ncolors;
static void swiss_set_color(HWND w, COLORREF c) { if (g_ncolors < 128) { g_colors[g_ncolors].w = w; g_colors[g_ncolors].c = c; g_ncolors++; } }
static int swiss_get_color(HWND w, COLORREF* out) { for (int i = 0; i < g_ncolors; i++) if (g_colors[i].w == w) { *out = g_colors[i].c; return 1; } return 0; }

// ── per-control background color (e.g. a colored Text/badge) ──
static struct { HWND w; COLORREF c; HBRUSH b; } g_bgs[64]; static int g_nbgs;
static void swiss_set_bg(HWND w, COLORREF c) { if (g_nbgs < 64) { g_bgs[g_nbgs].w = w; g_bgs[g_nbgs].c = c; g_bgs[g_nbgs].b = CreateSolidBrush(c); g_nbgs++; } }
static int swiss_get_bg(HWND w, COLORREF* c, HBRUSH* b) { for (int i = 0; i < g_nbgs; i++) if (g_bgs[i].w == w) { *c = g_bgs[i].c; *b = g_bgs[i].b; return 1; } return 0; }

static HBRUSH g_white;   // window/control background (web-like white)

// paint View backgroundColor rects (containers have no HWND) — parents first,
// so a child's bg draws over its parent's; controls then paint over the top.
static void swiss_paint_bg(Node* n, HDC hdc) {
  if (n->hasbg) { RECT r = { n->rx, n->ry, n->rx + n->rw, n->ry + n->rh }; HBRUSH b = CreateSolidBrush(n->bg); FillRect(hdc, &r, b); DeleteObject(b); }
  for (int i = 0; i < n->nkids; i++) if (n->kids[i]->visible) swiss_paint_bg(n->kids[i], hdc);
}

// ── owner-drawn buttons (native Win32 buttons ignore backgroundColor/color) ──
static struct { HWND w; COLORREF bg, fg; int radius, hasbg, hasfg; } g_btns[64]; static int g_nbtns;
static void swiss_btn_style(HWND w, COLORREF bg, int hasbg, COLORREF fg, int hasfg, int radius) {
  if (g_nbtns < 64) { g_btns[g_nbtns].w = w; g_btns[g_nbtns].bg = bg; g_btns[g_nbtns].hasbg = hasbg;
    g_btns[g_nbtns].fg = fg; g_btns[g_nbtns].hasfg = hasfg; g_btns[g_nbtns].radius = radius; g_nbtns++; }
}
static COLORREF swiss_darken(COLORREF c, int pct) { return RGB(GetRValue(c)*pct/100, GetGValue(c)*pct/100, GetBValue(c)*pct/100); }
static int swiss_btn_draw(LPDRAWITEMSTRUCT d) {
  for (int i = 0; i < g_nbtns; i++) if (g_btns[i].w == d->hwndItem) {
    COLORREF bg = g_btns[i].hasbg ? g_btns[i].bg : GetSysColor(COLOR_BTNFACE);
    if (d->itemState & ODS_SELECTED) bg = swiss_darken(bg, 85);          // pressed
    else if (d->itemState & ODS_HOTLIGHT) bg = swiss_darken(bg, 92);     // hover
    HBRUSH br = CreateSolidBrush(bg);
    FillRect(d->hDC, &d->rcItem, br); DeleteObject(br);                  // window region rounds the corners
    SetBkMode(d->hDC, TRANSPARENT);
    SetTextColor(d->hDC, g_btns[i].hasfg ? g_btns[i].fg : GetSysColor(COLOR_BTNTEXT));
    HFONT f = (HFONT)SendMessageA(d->hwndItem, WM_GETFONT, 0, 0);
    HGDIOBJ of = f ? SelectObject(d->hDC, f) : NULL;
    char buf[256]; GetWindowTextA(d->hwndItem, buf, sizeof buf);
    DrawTextA(d->hDC, buf, -1, &d->rcItem, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    if (of) SelectObject(d->hDC, of);
    return 1;
  }
  return 0;
}

typedef struct {
${cells.map((c) => `  ${c.ctype} ${c.name};`).join('\n') || '  int _u;'}
${refs.map((r) => `  ${r.ctype} ${r.name}__current;`).join('\n')}
${stateFields.join('\n')}
} SwissState;

static SwissState S;

// ── trackbar (WM_HSCROLL) callbacks ──
static struct { HWND w; void (*cb)(SwissState*, HWND); } g_tracks[32]; static int g_ntracks;
static void swiss_track(HWND w, void (*cb)(SwissState*, HWND)) { if (g_ntracks < 32) { g_tracks[g_ntracks].w = w; g_tracks[g_ntracks].cb = cb; g_ntracks++; } }

// ── timers (setInterval / setTimeout) ──
static struct { UINT_PTR id; void (*cb)(SwissState*); int repeat; } g_timers[32]; static int g_ntimers; static UINT_PTR g_timerseq = 1;
static long long swiss_timer_add(long long ms, void (*cb)(SwissState*), int repeat) {
  UINT_PTR id = g_timerseq++; if (g_ntimers < 32) { g_timers[g_ntimers].id = id; g_timers[g_ntimers].cb = cb; g_timers[g_ntimers].repeat = repeat; g_ntimers++; }
  SetTimer(g_main, id, (UINT)ms, NULL); return (long long)id;
}
static void swiss_timer_clear(long long id) { KillTimer(g_main, (UINT_PTR)id); }

// ── string helpers (libc; no GLib) ──
static char* swiss_aprintf(const char* fmt, ...) {
  va_list ap; va_start(ap, fmt); int n = vsnprintf(NULL, 0, fmt, ap); va_end(ap);
  char* b = (char*)malloc(n + 1); va_start(ap, fmt); vsnprintf(b, n + 1, fmt, ap); va_end(ap); return b;
}
static char* swiss_strdup(const char* s) { char* r = (char*)malloc(strlen(s) + 1); strcpy(r, s); return r; }
static char* swiss_concat(const char* a, const char* b) { char* r = (char*)malloc(strlen(a) + strlen(b) + 1); strcpy(r, a); strcat(r, b); return r; }
static char* swiss_upper(const char* s) { char* r = swiss_strdup(s); for (char* p = r; *p; p++) *p = (char)toupper((unsigned char)*p); return r; }
static char* swiss_lower(const char* s) { char* r = swiss_strdup(s); for (char* p = r; *p; p++) *p = (char)tolower((unsigned char)*p); return r; }
static char* swiss_trim(const char* s) { while (*s == ' ' || *s == '\\t' || *s == '\\n') s++; char* r = swiss_strdup(s); int n = (int)strlen(r); while (n > 0 && (r[n-1] == ' ' || r[n-1] == '\\t' || r[n-1] == '\\n')) r[--n] = 0; return r; }
static long long swiss_indexof(const char* s, const char* sub) { const char* p = strstr(s, sub); return p ? (long long)(p - s) : -1; }
static int swiss_startswith(const char* s, const char* p) { return strncmp(s, p, strlen(p)) == 0; }
static int swiss_endswith(const char* s, const char* p) { size_t ls = strlen(s), lp = strlen(p); return lp <= ls && strcmp(s + ls - lp, p) == 0; }
static char* swiss_substr(const char* s, long long a, long long b) {
  long long n = (long long)strlen(s); if (a < 0) a = 0; if (b < 0 || b > n) b = n; if (b < a) b = a;
  char* r = (char*)malloc((size_t)(b - a) + 1); memcpy(r, s + a, (size_t)(b - a)); r[b - a] = 0; return r;
}
static char* swiss_replace(const char* s, const char* from, const char* to) {
  size_t lf = strlen(from), lt = strlen(to); if (!lf) return swiss_strdup(s);
  size_t cap = strlen(s) + 1, n = 0; char* r = (char*)malloc(cap); const char* p = s;
  while (*p) {
    if (!strncmp(p, from, lf)) { while (n + lt + 1 > cap) { cap *= 2; r = (char*)realloc(r, cap); } memcpy(r + n, to, lt); n += lt; p += lf; }
    else { if (n + 2 > cap) { cap *= 2; r = (char*)realloc(r, cap); } r[n++] = *p++; }
  }
  r[n] = 0; return r;
}
static char* swiss_gettext(HWND w) { int n = GetWindowTextLengthA(w); char* b = (char*)malloc(n + 1); GetWindowTextA(w, b, n + 1); return b; }
static void swiss_set_image(HWND w, const char* path) {
  HBITMAP bmp = (HBITMAP)LoadImageA(NULL, path, IMAGE_BITMAP, 0, 0, LR_LOADFROMFILE);
  if (bmp) SendMessageA(w, STM_SETIMAGE, IMAGE_BITMAP, (LPARAM)bmp);
}
static void swiss_alert(const char* msg) { MessageBoxA(g_main, msg, "", MB_OK | MB_ICONINFORMATION); }
static long long swiss_confirm(const char* msg) { return MessageBoxA(g_main, msg, "", MB_YESNO | MB_ICONQUESTION) == IDYES ? 1 : 0; }
static char* swiss_pick_folder(void) {
  BROWSEINFOA bi; memset(&bi, 0, sizeof bi); bi.hwndOwner = g_main; bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
  LPITEMIDLIST pidl = SHBrowseForFolderA(&bi); char buf[MAX_PATH] = "";
  if (pidl) { SHGetPathFromIDListA(pidl, buf); CoTaskMemFree(pidl); }
  return swiss_strdup(buf);
}
static char* swiss_pick_file(void) {
  char buf[MAX_PATH] = ""; OPENFILENAMEA ofn; memset(&ofn, 0, sizeof ofn);
  ofn.lStructSize = sizeof ofn; ofn.hwndOwner = g_main; ofn.lpstrFile = buf; ofn.nMaxFile = MAX_PATH;
  ofn.Flags = OFN_FILEMUSTEXIST | OFN_HIDEREADONLY; if (!GetOpenFileNameA(&ofn)) buf[0] = 0;
  return swiss_strdup(buf);
}
static void swiss_set_theme(long long light) { (void)light; /* no-op on win32 v0.1 */ }

${cells.map((c) => `static void swiss_update_${c.name}(SwissState* s);`).join('\n')}

${out.fns.join('\n\n')}

${out.updates.join('\n\n')}

static Node* swiss_build_ui(SwissState* s) {
${out.build.join('\n')}
  return ${rootVar};
}

static void swiss_init(SwissState* s) {
${initCellLines.join('\n') || '  (void)s;'}
}

static void swiss_effect(SwissState* s) {
${[...out.postShow.map((x) => '  ' + x), ...initLines].join('\n') || '  (void)s;'}
}

static LRESULT CALLBACK swiss_wndproc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_COMMAND: {
${cmdCases || '      break;'}
      break;
    }
    case WM_DRAWITEM: {
      if (swiss_btn_draw((LPDRAWITEMSTRUCT)lp)) return TRUE;
      break;
    }
    case WM_HSCROLL: {
      for (int i = 0; i < g_ntracks; i++) if (g_tracks[i].w == (HWND)lp) { g_tracks[i].cb(&S, (HWND)lp); break; }
      return 0;
    }
    case WM_TIMER: {
      for (int i = 0; i < g_ntimers; i++) if (g_timers[i].id == (UINT_PTR)wp) { if (!g_timers[i].repeat) KillTimer(hwnd, (UINT_PTR)wp); g_timers[i].cb(&S); break; }
      return 0;
    }
    case WM_ERASEBKGND: return 1;   // suppress default erase (WM_PAINT handles bg) — no flicker
    case WM_PAINT: {
      PAINTSTRUCT ps; HDC hdc = BeginPaint(hwnd, &ps);
      RECT rc; GetClientRect(hwnd, &rc);
      // double-buffer: paint white + View bg rects to a memory DC, then blit once
      HDC mem = CreateCompatibleDC(hdc);
      HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
      HGDIOBJ ob = SelectObject(mem, bmp);
      FillRect(mem, &rc, g_white);
      if (g_root) swiss_paint_bg(g_root, mem);   // View backgroundColor rects
      BitBlt(hdc, 0, 0, rc.right, rc.bottom, mem, 0, 0, SRCCOPY);
      SelectObject(mem, ob); DeleteObject(bmp); DeleteDC(mem);
      EndPaint(hwnd, &ps); return 0;
    }
    case WM_CTLCOLORSTATIC: case WM_CTLCOLORBTN: {
      COLORREF col, bgc; HBRUSH bgb; HDC dc = (HDC)wp;
      if (swiss_get_color((HWND)lp, &col)) SetTextColor(dc, col);
      // opaque fill with the control's bg (own/inherited panel color, else white)
      // so static text is correct without transparency — lets WS_CLIPCHILDREN
      // suppress repaint flicker
      if (swiss_get_bg((HWND)lp, &bgc, &bgb)) { SetBkColor(dc, bgc); SetBkMode(dc, OPAQUE); return (LRESULT)bgb; }
      SetBkColor(dc, RGB(255, 255, 255)); SetBkMode(dc, OPAQUE); return (LRESULT)g_white;
    }
    case WM_SIZE: swiss_relayout(); return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
  }
  return DefWindowProcA(hwnd, msg, wp, lp);
}

int WINAPI WinMain(HINSTANCE hi, HINSTANCE hp, LPSTR cmd, int show) {
  (void)hp; (void)cmd;
  g_hinst = hi;
  { INITCOMMONCONTROLSEX _ic = { sizeof(INITCOMMONCONTROLSEX), ICC_STANDARD_CLASSES | ICC_BAR_CLASSES | ICC_PROGRESS_CLASS }; InitCommonControlsEx(&_ic); }
${cells.filter((c) => c.cinit != null).map((c) => `  S.${c.name} = ${c.cinit};`).join('\n')}
${refs.map((r) => `  S.${r.name}__current = ${r.cinit};`).join('\n')}
  swiss_init(&S);
  WNDCLASSA wc; memset(&wc, 0, sizeof wc);
  wc.lpfnWndProc = swiss_wndproc; wc.hInstance = hi; wc.lpszClassName = "SwissWindow";
  g_white = CreateSolidBrush(RGB(255, 255, 255));
  wc.hCursor = LoadCursor(NULL, IDC_ARROW); wc.hbrBackground = g_white;
  RegisterClassA(&wc);
  g_main = CreateWindowExA(0, "SwissWindow", ${cstr(opts.title || 'Swiss')},
    WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN, CW_USEDEFAULT, CW_USEDEFAULT, 960, 640, NULL, NULL, hi, NULL);
  g_root = swiss_build_ui(&S);
  swiss_effect(&S);
  swiss_relayout();
  ShowWindow(g_main, show); UpdateWindow(g_main);
  MSG m;
  while (GetMessage(&m, NULL, 0, 0) > 0) {
    if (IsDialogMessage(g_main, &m)) continue;   // tab navigation between controls
    TranslateMessage(&m); DispatchMessage(&m);
  }
  return 0;
}
`;
}

// wide-string literal for EM_SETCUEBANNER (which is Unicode-only)
function cwstr(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

function main() {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith('--'));
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'frontend.c';
  const title = args.includes('--title') ? args[args.indexOf('--title') + 1] : 'Swiss';
  let sigs = {};
  if (args.includes('--sig') && existsSync(args[args.indexOf('--sig') + 1])) sigs = JSON.parse(readFileSync(args[args.indexOf('--sig') + 1], 'utf8'));
  if (!input) { console.error('usage: swiss-win32c <App.jsx> --out frontend.c [--title T] [--sig sig.json]'); process.exit(1); }
  const ast = parse(readFileSync(input, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
  writeFileSync(out, emit(ast, { title, sigs }));
  console.error(`swiss-win32c: ${input} → ${out}`);
}
main();
