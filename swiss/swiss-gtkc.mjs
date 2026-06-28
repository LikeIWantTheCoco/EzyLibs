// swiss-gtkc — Swiss GTK translator (BUILD TIME ONLY; never shipped in the app).
//
// React/JSX  ──@babel/parser──▶ AST ──lower──▶ GTK3 C  (no JS engine in the app).
// React semantics are lowered to native imperative code (Svelte-style): useState
// → struct cells, setState → update only the widgets that read the cell, .map-
// style lists → GtkListBox rebuilt on the count cell, ezy.call('f',…) → a direct
// C call into the Ezy backend linked in-process.
//
// Supported subset (v0.2):
//   function component (default export), useState (int/string/bool), useEffect,
//   component-level `const f = (args) => {…}` helpers, View/Text/Button/Input/
//   Switch/Tabs/Tab/List, {expr} text interpolation, onPress/onChange handlers
//   with setState + ezy.call + if/else + locals + int()/str() + swiss.pickFolder()
//   + swiss.setTheme().
//
// Usage:  node swiss-gtkc.mjs App.jsx --out frontend.c [--title T] [--sig sig.json]
import { parse } from '@babel/parser';
import { readFileSync, writeFileSync, existsSync } from 'fs';

function err(msg, node) {
  const loc = node && node.loc ? ` (line ${node.loc.start.line})` : '';
  throw new Error(`swiss-gtkc: ${msg}${loc}`);
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

  // state cells: useState(init) → {name,setter,ctype,cinit,t}
  const cells = [];
  // component-level helper methods: const f = (a,b) => {…}
  const methods = [];
  const refs = []; // useRef cells (mutable .current)
  const derived = {}; // top-level `const x = expr` derived values (inlined, reactive)
  for (const stmt of comp.body.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) {
      const init = d.init;
      if (init && init.type === 'CallExpression' && init.callee.name === 'useState') {
        const [valId, setId] = d.id.elements;
        const a = init.arguments[0];
        let t = 'int', ctype = 'long long', cinit = '0', initNode = null, initObj = null;
        if (a) {
          if (a.type === 'StringLiteral') { t = 'string'; ctype = 'const char*'; cinit = cstr(a.value); }
          else if (a.type === 'BooleanLiteral') { t = 'bool'; cinit = a.value ? '1' : '0'; }
          else if (a.type === 'NumericLiteral') { if (Number.isInteger(a.value)) cinit = String(a.value); else { t = 'float'; ctype = 'double'; cinit = String(a.value); } }
          else if (a.type === 'ArrayExpression') { t = 'array'; ctype = null; cinit = null; } // array-of-records state
          else if (a.type === 'ObjectExpression') { t = 'object'; ctype = null; cinit = null; initObj = a; } // object record state
          else { // non-literal init (e.g. ezy.call) → assigned in swiss_init
            initNode = a;
            if (a.type === 'CallExpression' && a.callee.type === 'MemberExpression' && a.callee.object.name === 'ezy') {
              const r = sigs[a.arguments[0].value] ? sigs[a.arguments[0].value].ret : 'int';
              t = r === 'string' ? 'string' : r === 'float' ? 'float' : 'int'; ctype = cType(t);
            }
          }
        }
        cells.push({ name: valId.name, setter: setId.name, ctype, cinit, t, initNode, initObj });
      } else if (init && init.type === 'CallExpression' && init.callee.name === 'useMemo') {
        // derived value: const x = useMemo(() => expr, [deps]) → recomputed cell
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
          else if (a.type === 'NullLiteral') { rt = 'widget'; rc = 'GtkWidget*'; ci = 'NULL'; }
          else if (a.type === 'NumericLiteral') { ci = String(a.value); }
        }
        refs.push({ name: d.id.name, t: rt, ctype: rc, cinit: ci });
      } else if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
        methods.push({ name: d.id.name, node: init });
      } else if (init && d.id.type === 'Identifier') {
        derived[d.id.name] = init; // derived value: inlined where used, reactive via its cells
      }
    }
  }
  const cellByName = (n) => cells.find((c) => c.name === n);
  const cellBySetter = (n) => cells.find((c) => c.setter === n);
  const methodByName = (n) => methods.find((m) => m.name === n);
  const refByName = (n) => refs.find((r) => r.name === n);

  // custom (presentational) components defined at module level — inlined on use
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

  // array-of-records state: infer element shape from object literals in setX(...)
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
    walk(comp, (n) => {
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === c.setter)
        walk(n, (o) => { if (o.type === 'ObjectExpression') for (const p of o.properties) { const k = p.key.name || p.key.value; if (!(k in fields)) fields[k] = tInfer(p.value); } });
    });
    c.fields = Object.keys(fields).map((k) => ({ name: k, t: fields[k], ctype: cType(fields[k]) }));
    c.struct = `Item_${c.name}`; c.arrtype = `Arr_${c.name}`; c.ctype = c.arrtype;
  }
  const arrayCells = cells.filter((c) => c.t === 'array');
  // object record state: infer shape from init {…} + setX({…}) literals
  for (const c of cells.filter((x) => x.t === 'object')) {
    const fields = {};
    const collect = (obj) => { for (const p of obj.properties) if ((p.type === 'ObjectProperty' || p.type === 'Property') && p.key) { const k = p.key.name || p.key.value; if (!(k in fields)) fields[k] = tInfer(p.value); } };
    if (c.initObj) collect(c.initObj);
    walk(comp, (n) => { if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === c.setter) walk(n, (o) => { if (o.type === 'ObjectExpression') collect(o); }); });
    c.fields = Object.keys(fields).map((k) => ({ name: k, t: fields[k], ctype: cType(fields[k]) }));
    c.struct = `Obj_${c.name}`; c.ctype = c.struct;
  }
  const objectCells = cells.filter((c) => c.t === 'object');

  // dependency snippets per cell (run by swiss_update_<cell>)
  const deps = {}; cells.forEach((c) => (deps[c.name] = []));
  // useMemo: infer type + register recompute on each dep cell change
  for (const c of cells.filter((x) => x.isMemo)) {
    const v = cexpr(c.initNode, {});
    c.t = v.t === 'void' ? 'int' : v.t; c.ctype = cType(c.t);
    for (const dn of c.memoDeps) if (deps[dn]) deps[dn].push(`s->${c.name} = ${v.c}; swiss_update_${c.name}(s);`);
  }
  const stateFields = [];     // extra GtkWidget* / data fields in SwissState
  const out = { updates: [], fns: [], build: [], css: [], externs: new Set(), lists: [], postShow: [] };
  let uid = 0; const vid = (p) => `${p}${uid++}`;
  const cssClasses = {}; let cssN = 0;

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
        if (derived[node.name]) return cexpr(derived[node.name], scope); // inline derived value
        err(`unknown identifier '${node.name}'`, node);
        break;
      }
      case 'ParenthesizedExpression': return cexpr(node.expression, scope);
      case 'OptionalMemberExpression':
      case 'MemberExpression': {
        // event value: e.target.value inside an Input onChange arrow
        if (node.property.name === 'value' && node.object.type === 'MemberExpression' && node.object.property.name === 'target' && scope.__evtext)
          return { c: scope.__evtext, t: 'string' };
        // useRef .current
        if (node.property.name === 'current' && node.object.type === 'Identifier' && refByName(node.object.name)) {
          const r = refByName(node.object.name); return { c: `s->${r.name}__current`, t: r.t === 'widget' ? 'int' : r.t };
        }
        // record field: it.field where scope[it].rec is set by .map/.filter
        if (node.object.type === 'Identifier' && scope[node.object.name] && scope[node.object.name].rec) {
          const r = scope[node.object.name]; const f = (r.shape || []).find((x) => x.name === node.property.name);
          return { c: `${r.rec}.${node.property.name}`, t: f ? f.t : 'int' };
        }
        // array.length
        if (node.object.type === 'Identifier' && cellByName(node.object.name) && cellByName(node.object.name).t === 'array' && node.property.name === 'length')
          return { c: `s->${node.object.name}.len`, t: 'int' };
        // arr.filter(pred).length → filtered count (GCC statement expression)
        if (node.property.name === 'length' && node.object.type === 'CallExpression' && node.object.callee.type === 'MemberExpression' &&
            node.object.callee.property.name === 'filter' && node.object.callee.object.type === 'Identifier' &&
            cellByName(node.object.callee.object.name) && cellByName(node.object.callee.object.name).t === 'array') {
          const cell = cellByName(node.object.callee.object.name); const arrow = node.object.arguments[0];
          const fs = {}; if (arrow.params[0]) fs[arrow.params[0].name] = { rec: `s->${cell.name}.data[_i]`, shape: cell.fields };
          return { c: `({ long long _c = 0; for (long long _i = 0; _i < s->${cell.name}.len; _i++) if (${cexpr(stripParens(arrow.body), fs).c}) _c++; _c; })`, t: 'int' };
        }
        // object-cell field: obj.field
        if (node.object.type === 'Identifier' && cellByName(node.object.name) && cellByName(node.object.name).t === 'object') {
          const oc = cellByName(node.object.name); const f = (oc.fields || []).find((x) => x.name === node.property.name);
          return { c: `s->${oc.name}.${node.property.name}`, t: f ? f.t : 'int' };
        }
        // props.x inside an inlined component
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
        // `+` with any string operand → concat (coercing the other side to text)
        if (op === '+' && (l.t === 'string' || r.t === 'string')) {
          const S = (x) => x.t === 'string' ? x.c : x.t === 'float' ? `g_strdup_printf("%g", (double)(${x.c}))` : `g_strdup_printf("%lld", (long long)(${x.c}))`;
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
        return { c: `g_strdup_printf(${cstr(fmt)}${args.length ? ', ' + args.join(', ') : ''})`, t: 'string' };
      }
      case 'OptionalCallExpression':
      case 'CallExpression': {
        const c = node.callee;
        // builtins int()/str()/parseInt/parseFloat/Number
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
          return { c: `g_strdup_printf("%lld", (long long)(${a.c}))`, t: 'string' };
        }
        // browser globals: alert/confirm (bare) → dialog; console.* → no-op
        if (c.type === 'Identifier' && c.name === 'alert') {
          const a = node.arguments[0] ? cexpr(node.arguments[0], scope) : { c: '""' };
          return { c: `swiss_alert(${a.t === 'string' ? a.c : `g_strdup_printf("%lld", (long long)(${a.c}))`})`, t: 'void' };
        }
        if (c.type === 'Identifier' && c.name === 'confirm') {
          const a = node.arguments[0] ? cexpr(node.arguments[0], scope).c : '""';
          return { c: `swiss_confirm(${a})`, t: 'bool' };
        }
        if (c.type === 'MemberExpression' && c.object.name === 'console') return { c: '((void)0)', t: 'void' };
        // Math.*
        if (c.type === 'MemberExpression' && c.object.name === 'Math') {
          const A = node.arguments.map((x) => cexpr(x, scope).c);
          const m = c.property.name;
          const mm = { floor: 'floor', ceil: 'ceil', round: 'round', abs: 'fabs', sqrt: 'sqrt', pow: 'pow', min: 'fmin', max: 'fmax' }[m];
          if (mm) return { c: `((long long)${mm}(${A.map((x) => `(double)(${x})`).join(', ')}))`, t: 'int' };
          if (m === 'random') return { c: `(rand() / (double)RAND_MAX)`, t: 'float' };
        }
        // ezy.call('fn', args…)
        if (c.type === 'MemberExpression' && c.object.name === 'ezy' && c.property.name === 'call') {
          const fn = node.arguments[0].value;
          out.externs.add(fn);
          const args = node.arguments.slice(1).map((a) => cexpr(a, scope).c);
          const ret = sigs[fn] ? sigs[fn].ret : 'int';
          return { c: `${fn}(${args.join(', ')})`, t: ret === 'string' ? 'string' : ret === 'void' ? 'void' : 'int' };
        }
        // swiss.* host builtins
        if (c.type === 'MemberExpression' && c.object.name === 'swiss') {
          if (c.property.name === 'pickFolder') return { c: 'swiss_pick_folder()', t: 'string' };
          if (c.property.name === 'pickFile') return { c: 'swiss_pick_file()', t: 'string' };
          if (c.property.name === 'setTheme') return { c: `swiss_set_theme(${cexpr(node.arguments[0], scope).c})`, t: 'void' };
          if (c.property.name === 'alert') return { c: `swiss_alert(${cexpr(node.arguments[0], scope).c})`, t: 'void' };
          if (c.property.name === 'confirm') return { c: `swiss_confirm(${cexpr(node.arguments[0], scope).c})`, t: 'bool' };
        }
        // timers: setInterval/setTimeout(fn, ms) → g_timeout_add; clearInterval(id)
        if (c.type === 'Identifier' && (c.name === 'setInterval' || c.name === 'setTimeout')) {
          const tl = []; genStmts(node.arguments[0].body, { ...scope }, tl);
          const id = `timer_${hN++}`;
          out.fns.push(`static gboolean ${id}(gpointer ud) {\n  SwissState* s = (SwissState*)ud; (void)s;\n${tl.join('\n')}\n  return ${c.name === 'setInterval' ? 'G_SOURCE_CONTINUE' : 'G_SOURCE_REMOVE'};\n}`);
          return { c: `g_timeout_add(${cexpr(node.arguments[1], scope).c}, ${id}, &S)`, t: 'int' };
        }
        if (c.type === 'Identifier' && (c.name === 'clearInterval' || c.name === 'clearTimeout'))
          return { c: `g_source_remove(${cexpr(node.arguments[0], scope).c})`, t: 'void' };
        // string methods
        if (c.type === 'MemberExpression') {
          const recv = cexpr(c.object, scope), m = c.property.name;
          const a0 = node.arguments[0] ? cexpr(node.arguments[0], scope).c : null;
          const a1 = node.arguments[1] ? cexpr(node.arguments[1], scope).c : null;
          if (m === 'trim') return { c: `g_strstrip(g_strdup(${recv.c}))`, t: 'string' };
          if (m === 'toUpperCase') return { c: `g_ascii_strup(${recv.c}, -1)`, t: 'string' };
          if (m === 'toLowerCase') return { c: `g_ascii_strdown(${recv.c}, -1)`, t: 'string' };
          if (m === 'includes') return { c: `(strstr(${recv.c}, ${a0}) != NULL)`, t: 'bool' };
          if (m === 'startsWith') return { c: `g_str_has_prefix(${recv.c}, ${a0})`, t: 'bool' };
          if (m === 'endsWith') return { c: `g_str_has_suffix(${recv.c}, ${a0})`, t: 'bool' };
          if (m === 'indexOf') return { c: `swiss_indexof(${recv.c}, ${a0})`, t: 'int' };
          if (m === 'substring' || m === 'slice') return { c: `swiss_substr(${recv.c}, ${a0}, ${a1 || '-1'})`, t: 'string' };
          if (m === 'replace' || m === 'replaceAll') return { c: `swiss_replace(${recv.c}, ${a0}, ${a1})`, t: 'string' };
          if (m === 'repeat') return { c: `g_strnfill(0, ' ')`, t: 'string' }; // (rare; placeholder)
        }
        err('unsupported call expression', node); break;
      }
      default: err(`unsupported expression '${node.type}'`, node);
    }
  }

  // ── statement list → C lines ──
  function genStmts(body, scope, lines) {
    const stmts = body.type === 'BlockStatement' ? body.body : [{ type: 'ExpressionStatement', expression: body }];
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
    if (st.type === 'ReturnStatement') return; // void methods / effect cleanup
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
        const upd = st.update ? `${st.update.argument ? cexpr(st.update.argument, sc).c : ''}${st.update.operator || ''}` : '';
        lines.push(`  for (${initS}; ${test}; ${st.update && st.update.type === 'UpdateExpression' ? cexpr(st.update.argument, sc).c + st.update.operator : (st.update ? cexpr(st.update, sc).c : '')}) {`);
        scope = sc;
      }
      genStmts(st.body, scope, lines);
      lines.push('  }');
      return;
    }
    if (st.type === 'ExpressionStatement') {
      const e = st.expression;
      // assignment: local = v / local += v / ref.current = v
      if (e.type === 'AssignmentExpression') {
        const v = cexpr(e.right, scope);
        if (e.left.type === 'MemberExpression' && e.left.property.name === 'current' && refByName(e.left.object.name)) {
          lines.push(`  s->${e.left.object.name}__current ${e.operator} ${v.c};`); return;
        }
        if (e.left.type === 'Identifier' && scope[e.left.name]) { lines.push(`  ${e.left.name} ${e.operator} ${v.c};`); return; }
        err('unsupported assignment target', e);
      }
      if (e.type === 'UpdateExpression' && e.argument.type === 'Identifier' && scope[e.argument.name]) { lines.push(`  ${e.argument.name}${e.operator};`); return; }
      // ignore e.preventDefault() / e.stopPropagation()
      if (e.type === 'CallExpression' && e.callee.type === 'MemberExpression' &&
          (e.callee.property.name === 'preventDefault' || e.callee.property.name === 'stopPropagation')) return;
      // setX(expr)
      if (e.type === 'CallExpression' && e.callee.type === 'Identifier' && cellBySetter(e.callee.name)) {
        const cell = cellBySetter(e.callee.name);
        if (cell.t === 'array') { genArraySet(cell, e.arguments[0], scope, lines); lines.push(`  swiss_update_${cell.name}(s);`); return; }
        if (cell.t === 'object') {
          const o = e.arguments[0];
          if (o.type !== 'ObjectExpression') err('setObject expects an object literal', o);
          for (const p of o.properties) {
            if (p.type === 'SpreadElement') continue; // {...obj} keeps the rest
            const fn = p.key.name || p.key.value;
            const f = cell.fields.find((x) => x.name === fn);
            const v = cexpr(p.value, scope);
            lines.push(`  s->${cell.name}.${fn} = ${f && f.t === 'string' ? `g_strdup(${v.c})` : v.c};`);
          }
          lines.push(`  swiss_update_${cell.name}(s);`); return;
        }
        const arg = e.arguments[0];
        // functional updater: setX(prev => expr)
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
      // call to a component helper method
      if (e.type === 'CallExpression' && e.callee.type === 'Identifier' && methodByName(e.callee.name)) {
        const args = e.arguments.map((a) => cexpr(a, scope).c);
        lines.push(`  method_${e.callee.name}(s${args.length ? ', ' + args.join(', ') : ''});`);
        return;
      }
      // bare expression (ezy.call / swiss.*)
      const v = cexpr(e, scope);
      lines.push(`  ${v.c};`);
      return;
    }
    err(`unsupported statement '${st.type}'`, st);
  }

  // build a struct literal for an array element from a JSX object literal
  function objLit(cell, obj, scope) {
    const inits = cell.fields.map((f) => {
      const p = obj.properties.find((pr) => (pr.key.name || pr.key.value) === f.name);
      if (!p) return `.${f.name} = ${f.t === 'string' ? '""' : '0'}`;
      const v = cexpr(p.value, scope);
      return `.${f.name} = ${f.t === 'string' ? `g_strdup(${v.c})` : v.c}`;
    });
    return `(${cell.struct}){ ${inits.join(', ')} }`;
  }
  // setX(...) where X is an array cell: support [...x, obj] / [objs] / [] / x.filter(pred)
  function genArraySet(cell, arg, scope, lines) {
    arg = stripParens(arg);
    if (arg.type === 'ArrayExpression') {
      const hasSpread = arg.elements.some((e) => e && e.type === 'SpreadElement');
      if (!hasSpread) lines.push(`  s->${cell.name}.len = 0;`); // replace whole array
      for (const el of arg.elements) {
        if (!el || el.type === 'SpreadElement') continue; // spread = keep existing
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
      params.forEach((p) => (scope[p] = { c: p, t: 'int' })); // index/id/bool params
      const lines = [];
      genStmts(m.node.body, scope, lines);
      const sig = params.map((p) => `long long ${p}`).join(', ');
      out.fns.push(`static void method_${m.name}(SwissState* s${sig ? ', ' + sig : ''}) {\n${lines.join('\n')}\n}`);
    }
  }

  // ── handler arrow → a C callback name; supports onPress (clicked) etc ──
  let hN = 0;
  // how to read the event value for each handler kind (the value passed to onChange)
  const VAL = {
    toggle: 'gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(w))',
    range: '(long long)gtk_range_get_value(GTK_RANGE(w))',
    combo: 'gtk_combo_box_get_active(GTK_COMBO_BOX(w))',
  };
  function emitHandler(attrNode, scope, kind) {
    const fn = attrNode.expression;
    const id = `cb_${hN++}`;
    const lines = [];
    // value name the handler sees: switch via param, others via _v
    const valName = kind === 'switch' ? '_sw_on' : VAL[kind] ? '_v' : null;
    if (fn.type === 'Identifier' && cellBySetter(fn.name)) {
      // onChange={setX}: write the event value straight into the cell
      const cell = cellBySetter(fn.name);
      lines.push(`  s->${cell.name} = ${valName || '0'}; swiss_update_${cell.name}(s);`);
    } else if (fn.type === 'Identifier' && methodByName(fn.name)) {
      const arity = methodByName(fn.name).node.params.length;
      const arg = valName || (arity > 0 ? '0' : '');   // pass dummy for an (e) event param
      lines.push(`  method_${fn.name}(s${arg ? ', ' + arg : ''});`);
    } else if (fn.type === 'ArrowFunctionExpression') {
      if (valName && fn.params[0]) lines.push(`  long long ${fn.params[0].name} = ${valName};`);
      genStmts(fn.body, { ...scope }, lines);
    } else {
      err('handler must be an arrow function or a helper name', fn);
    }
    // a row-button callback recovers its list index from widget data (first line)
    if (scope.__index) lines.unshift(`  long long ${scope.__indexName} = (long long)(intptr_t)g_object_get_data(G_OBJECT(w), "swiss_i");`);
    if (kind === 'switch') {
      out.fns.push(`static gboolean ${id}(GtkWidget* w, gboolean _sw_on, gpointer ud) {\n  SwissState* s = (SwissState*)ud; (void)w;\n${lines.join('\n')}\n  return FALSE;\n}`);
    } else {
      const pre = VAL[kind] ? `  long long _v = ${VAL[kind]};\n` : '';
      out.fns.push(`static void ${id}(GtkWidget* w, gpointer ud) {\n  SwissState* s = (SwissState*)ud; (void)w;\n${pre}${lines.join('\n')}\n}`);
    }
    return id;
  }

  // ── styles → css / box props ──
  // build (or reuse) a CSS class for a merged style object, keyed by `key`
  function classForMerged(key, st) {
    const css = [];
    for (const k in st) {
      const v = st[k];
      if (k === 'padding') css.push(`padding:${v}px`);   // inner padding (not outer margin)
      // height → min-height (can shrink below the theme default). GTK adds
      // padding on top, so subtract it to make the TOTAL height ≈ the JSX value
      // (matching the Win32 target, which treats height as the full size).
      else if (k === 'height') css.push(`min-height:${Math.max(0, v - 2 * (st.padding || 0) - 2)}px`);
      else if (k === 'fontSize') css.push(`font-size:${v}px`);
      else if (k === 'fontWeight') css.push(`font-weight:${v}`);
      else if (k === 'color') css.push(`color:${v}`);
      else if (k === 'backgroundColor') css.push(`background-color:${v};background-image:none`);
      else if (k === 'borderWidth') css.push(`border-width:${v}px;border-style:solid`);
      else if (k === 'borderColor') css.push(`border-color:${v}`);
      else if (k === 'borderRadius') css.push(`border-radius:${v}px`);
      else if (k === 'textAlign') css.push(`text-align:${v}`);
      else if (k === 'fontFamily') css.push(`font-family:${v}`);
      else if (k === 'opacity') css.push(`opacity:${v}`);
    }
    if (!css.length) return null;
    if (!cssClasses[key]) { const cl = `swiss-${cssN++}`; cssClasses[key] = cl; out.css.push(`.${cl}{${css.join(';')}}`); }
    return cssClasses[key];
  }
  // parse an inline style object {{ padding: '20px', backgroundColor: '#007bff', … }}
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
      else if (k === 'margin') { if (/auto/.test(s)) o.alignItems = 'center'; else o.margin = num(s); }
      else if (k === 'marginTop') o.marginTop = num(s);
      else if (k === 'marginBottom') o.marginBottom = num(s);
      else if (k === 'marginLeft') o.marginLeft = num(s);
      else if (k === 'marginRight') o.marginRight = num(s);
      else if (k === 'width') { if (s === '100%') o.fillCross = true; else o.width = num(s); }
      else if (k === 'maxWidth' || k === 'minWidth') o.width = num(s);
      else if (k === 'height' || k === 'maxHeight' || k === 'minHeight') o.height = num(s);
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
      else if (k === 'border') { if (s !== 'none') { const m = s.match(/(\d+)px\s+\w+\s+(\S+)/); if (m) { o.borderWidth = parseInt(m[1]); o.borderColor = m[2]; } } }
    }
    return o;
  }
  let inlineN = 0;
  // resolve a style= attr: styles.x ref, [styles.a, styles.b] array, or inline {{…}}
  function resolveStyle(node) {
    if (!node || node.type !== 'JSXExpressionContainer') return { obj: null, cls: null };
    const e = node.expression;
    if (e.type === 'ObjectExpression') { const obj = parseInline(e); return { obj, cls: classForMerged('inline' + inlineN++, obj) }; }
    const names = [];
    if (e.type === 'MemberExpression' && e.object.name === 'styles') names.push(e.property.name);
    else if (e.type === 'ArrayExpression')
      for (const el of e.elements) if (el && el.type === 'MemberExpression' && el.object.name === 'styles') names.push(el.property.name);
    if (!names.length) return { obj: null, cls: null };
    const obj = Object.assign({}, ...names.map((n) => styles[n] || {}));
    return { obj, cls: classForMerged(names.join('+'), obj) };
  }
  // reactive style: style={cond ? styles.a : styles.b} or [base, cond && styles.x]
  function planDynStyle(node, scope) {
    if (!node || node.type !== 'JSXExpressionContainer') return null;
    const e = node.expression;
    const conds = []; const cells = new Set();
    const styleCls = (n) => (n && n.type === 'MemberExpression' && n.object.name === 'styles') ? classForMerged(n.property.name, styles[n.property.name] || {}) : null;
    const tern = (t) => { const a = styleCls(t.consequent), b = styleCls(t.alternate); const cc = cexpr(t.test, scope).c; cellsIn(t.test).forEach((c) => cells.add(c)); if (a) conds.push({ cls: a, cond: cc }); if (b) conds.push({ cls: b, cond: `!(${cc})` }); };
    if (e.type === 'ConditionalExpression') tern(e);
    else if (e.type === 'ArrayExpression') for (const el of e.elements) {
      if (!el) continue;
      if (el.type === 'LogicalExpression' && el.operator === '&&') { const cl = styleCls(el.right); if (cl) { conds.push({ cls: cl, cond: cexpr(el.left, scope).c }); cellsIn(el.left).forEach((c) => cells.add(c)); } }
      else if (el.type === 'ConditionalExpression') tern(el);
    }
    return conds.length ? { conds, cells: [...cells] } : null;
  }
  // optional widget events (work on windowed widgets: Button/Input; harmless else)
  function wireEvents(v, a, scope) {
    const handler = (attr, cbSig, body) => {
      if (!a[attr]) return null;
      const fn = a[attr].expression; const lines = [];
      if (fn.type === 'Identifier' && methodByName(fn.name)) lines.push(`  method_${fn.name}(s${methodByName(fn.name).node.params.length ? ', 0' : ''});`);
      else if (fn.type === 'ArrowFunctionExpression') genStmts(fn.body, { ...scope }, lines);
      const id = `cb_${hN++}`;
      out.fns.push(`static gboolean ${id}(${cbSig}) {\n  SwissState* s = (SwissState*)ud; (void)w; (void)e;\n${body ? body(lines) : lines.join('\n')}\n  return FALSE;\n}`);
      return id;
    };
    const masks = [];
    const conn = (attr, signal, mask) => { const id = handler(attr, 'GtkWidget* w, GdkEvent* e, gpointer ud'); if (id) { masks.push(mask); out.build.push(`  g_signal_connect(GTK_WIDGET(${v}), "${signal}", G_CALLBACK(${id}), s);`); } };
    conn('onFocus', 'focus-in-event', 'GDK_FOCUS_CHANGE_MASK');
    conn('onBlur', 'focus-out-event', 'GDK_FOCUS_CHANGE_MASK');
    conn('onMouseEnter', 'enter-notify-event', 'GDK_ENTER_NOTIFY_MASK');
    conn('onMouseLeave', 'leave-notify-event', 'GDK_LEAVE_NOTIFY_MASK');
    conn('onKeyDown', 'key-press-event', 'GDK_KEY_PRESS_MASK');
    if (a.onDoubleClick) {
      const id = handler('onDoubleClick', 'GtkWidget* w, GdkEventButton* e, gpointer ud', (lines) => `  if (e->type == GDK_2BUTTON_PRESS) {\n${lines.join('\n')}\n  }`);
      if (id) { masks.push('GDK_BUTTON_PRESS_MASK'); out.build.push(`  g_signal_connect(GTK_WIDGET(${v}), "button-press-event", G_CALLBACK(${id}), s);`); }
    }
    if (masks.length) out.build.push(`  gtk_widget_add_events(GTK_WIDGET(${v}), ${[...new Set(masks)].join(' | ')});`);
  }
  function attrs(el) { const o = {}; for (const a of el.openingElement.attributes) if (a.type === 'JSXAttribute') o[a.name.name] = a.value; return o; }
  const elName = (el) => el.openingElement.name.name;
  const strAttr = (a) => !a ? '' : a.type === 'StringLiteral' ? a.value : a.type === 'JSXExpressionContainer' && a.expression.type === 'StringLiteral' ? a.expression.value : '';

  // padding → margins, width/height → size request, align → h/valign (column-ish)
  const ALIGN = { center: 'GTK_ALIGN_CENTER', start: 'GTK_ALIGN_START', 'flex-start': 'GTK_ALIGN_START', end: 'GTK_ALIGN_END', 'flex-end': 'GTK_ALIGN_END', stretch: 'GTK_ALIGN_FILL' };
  function applyStyle(v, st) {
    if (!st) return;
    // padding is inner spacing (emitted as CSS in classForMerged), not outer margin
    if (st.margin != null) for (const s of ['top', 'bottom', 'start', 'end']) out.build.push(`  gtk_widget_set_margin_${s}(${v}, ${Number(st.margin)});`);
    if (st.marginTop != null) out.build.push(`  gtk_widget_set_margin_top(${v}, ${Number(st.marginTop)});`);
    if (st.marginBottom != null) out.build.push(`  gtk_widget_set_margin_bottom(${v}, ${Number(st.marginBottom)});`);
    if (st.marginLeft != null) out.build.push(`  gtk_widget_set_margin_start(${v}, ${Number(st.marginLeft)});`);
    if (st.marginRight != null) out.build.push(`  gtk_widget_set_margin_end(${v}, ${Number(st.marginRight)});`);
    // width via size_request; height via CSS min-height (size_request is a
    // minimum GTK won't shrink below its natural height, so a smaller explicit
    // height would be ignored — min-height can actually reduce it).
    if (st.width != null) out.build.push(`  gtk_widget_set_size_request(${v}, ${Number(st.width)}, -1);`);
    if (st.alignItems && ALIGN[st.alignItems]) out.build.push(`  gtk_widget_set_halign(${v}, ${ALIGN[st.alignItems]});`);
    if (st.justifyContent && ALIGN[st.justifyContent]) out.build.push(`  gtk_widget_set_valign(${v}, ${ALIGN[st.justifyContent]});`);
  }
  // GtkLabel centers its text by default; honor CSS textAlign (default: left).
  // halign START → content-sized & left (web-like), unless it should fill.
  // (an explicit px width is an exact size via size_request, NOT a fill.)
  function labelAlign(target, st) {
    const ta = st && st.textAlign;
    const fill = st && (st.fillCross || st.flex);
    const ha = ta === 'center' ? 'GTK_ALIGN_CENTER' : ta === 'right' ? 'GTK_ALIGN_END' : fill ? 'GTK_ALIGN_FILL' : 'GTK_ALIGN_START';
    const xa = ta === 'center' ? '0.5' : ta === 'right' ? '1.0' : '0.0';
    out.build.push(`  gtk_widget_set_halign(${target}, ${ha});`);
    out.build.push(`  gtk_label_set_xalign(GTK_LABEL(${target}), ${xa});`);
  }
  // leaf controls (button/entry/…) are content-sized by default (web inline-
  // block); fill the cross-axis only on width:100% / flex. An explicit px width
  // is an exact size (size_request) at the start, not a fill.
  function crossFill(target, st) {
    const fill = st && (st.fillCross || st.flex);
    out.build.push(`  gtk_widget_set_halign(${target}, ${fill ? 'GTK_ALIGN_FILL' : 'GTK_ALIGN_START'});`);
  }

  // text children → printf snippet (parts), collects cells read
  function textSnippet(el, scope, targetExpr) {
    const parts = []; const reads = new Set(); let dynamic = false;
    for (const ch of el.children) {
      if (ch.type === 'JSXText') { const t = ch.value.replace(/\s+/g, ' '); if (t.trim() !== '') parts.push({ lit: t }); }
      else if (ch.type === 'JSXExpressionContainer' && ch.expression.type !== 'JSXEmptyExpression') {
        const v = cexpr(ch.expression, scope); parts.push({ expr: v.c, t: v.t }); dynamic = true;
        cellsIn(ch.expression).forEach((c) => reads.add(c)); // dep tracking (follows derived)
      }
    }
    let fmt = ''; const args = [];
    for (const p of parts) { if (p.lit != null) fmt += p.lit.replace(/%/g, '%%'); else { fmt += p.t === 'string' ? '%s' : p.t === 'float' ? '%g' : '%lld'; args.push(p.t === 'string' ? p.expr : p.t === 'float' ? `(double)(${p.expr})` : `(long long)(${p.expr})`); } }
    const snippet = `{ char _b[512]; snprintf(_b, sizeof _b, ${cstr(fmt)}${args.length ? ', ' + args.join(', ') : ''}); gtk_label_set_text(GTK_LABEL(${targetExpr}), _b); }`;
    return { snippet, reads, dynamic, staticText: parts.map((p) => p.lit || '').join('') };
  }

  // ── recursive widget builder. scope carries in-scope locals (e.g. list index i) ──
  function build(el, parent, scope) {
    if (el.type === 'JSXFragment') {
      const v = vid('frag');
      out.build.push(`  GtkWidget* ${v} = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);`);
      buildChildren(el.children, v, scope);
      if (parent) out.build.push(`  gtk_box_pack_start(GTK_BOX(${parent}), ${v}, FALSE, FALSE, 0);`);
      return v;
    }
    const tag = elName(el);
    const a = attrs(el);
    const comp = componentByName(tag);
    if (comp) return inlineComponent(comp, el, parent, scope);
    // raw HTML/DOM tags map to Swiss widgets
    const HTMLMAP = {
      div: 'View', section: 'View', main: 'View', header: 'View', footer: 'View', nav: 'View', article: 'View', ul: 'View', ol: 'View', li: 'View', form: 'View',
      h1: 'Text', h2: 'Text', h3: 'Text', h4: 'Text', h5: 'Text', h6: 'Text', p: 'Text', span: 'Text', label: 'Text', a: 'Text', strong: 'Text', small: 'Text',
      input: 'Input', textarea: 'TextArea', button: 'Button', img: 'Image', hr: 'Separator', select: 'Select',
    };
    const name = HTMLMAP[tag] || tag;
    let { obj: st, cls } = resolveStyle(a.style);
    const HSIZE = { h1: 28, h2: 23, h3: 19, h4: 16 };
    if (HSIZE[tag]) { st = Object.assign({ fontSize: HSIZE[tag], fontWeight: 'bold' }, st || {}); cls = classForMerged('h_' + tag + '_' + (cls || 'x'), st); }
    const expand = st && (st.flex || st.flexGrow) ? 'TRUE' : 'FALSE';
    const pack = (v, force) => { if (parent) out.build.push(`  gtk_box_pack_start(GTK_BOX(${parent}), ${v}, ${force || expand}, ${force || expand}, 0);`); };
    const dyn = planDynStyle(a.style, scope);   // reactive style: cond ? a : b / [base, cond && x]
    const addClass = (v) => {
      if (cls) out.build.push(`  gtk_style_context_add_class(gtk_widget_get_style_context(${v}), "${cls}");`);
      if (dyn) {
        const w = String(v).startsWith('s->') || scope.__inrow ? v : stash(v);
        for (const cnd of dyn.conds) {
          const snip = `{ GtkStyleContext* _sc = gtk_widget_get_style_context(GTK_WIDGET(${w})); if (${cnd.cond}) gtk_style_context_add_class(_sc, "${cnd.cls}"); else gtk_style_context_remove_class(_sc, "${cnd.cls}"); }`;
          out.build.push('  ' + snip);
          if (!scope.__inrow) dyn.cells.forEach((cn) => deps[cn] && deps[cn].push(snip));   // rows rebuild; others react
        }
      }
      wireEvents(v, a, scope);
    };

    if (name === 'View' || name === 'Tab') {
      const v = vid('v');
      const dir = st && st.flexDirection === 'row' ? 'GTK_ORIENTATION_HORIZONTAL' : 'GTK_ORIENTATION_VERTICAL';
      out.build.push(`  GtkWidget* ${v} = gtk_box_new(${dir}, ${Number((st && st.gap) || 0)});`);
      applyStyle(v, st); addClass(v);
      // <form onSubmit={h}>: children inputs/submit-buttons trigger h
      const childScope = tag === 'form' && a.onSubmit ? { ...scope, __form: a.onSubmit } : scope;
      buildChildren(el.children, v, childScope);
      pack(v); return v;
    }
    if (name === 'ScrollView') {
      const sc = vid('sc');
      out.build.push(`  GtkWidget* ${sc} = gtk_scrolled_window_new(NULL, NULL);`);
      out.build.push(`  gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(${sc}), GTK_POLICY_AUTOMATIC, GTK_POLICY_AUTOMATIC);`);
      applyStyle(sc, st); addClass(sc);
      // a scrolled window holds one child; wrap children in a vertical box
      const inner = vid('v');
      out.build.push(`  GtkWidget* ${inner} = gtk_box_new(GTK_ORIENTATION_VERTICAL, ${Number((st && st.gap) || 0)});`);
      buildChildren(el.children, inner, scope);
      out.build.push(`  gtk_container_add(GTK_CONTAINER(${sc}), ${inner});`);
      pack(sc, 'TRUE'); return sc;  // scroll areas fill by default
    }
    if (name === 'Tabs') {
      const nb = vid('nb');
      out.build.push(`  GtkWidget* ${nb} = gtk_notebook_new();`);
      for (const ch of el.children) {
        if (ch.type !== 'JSXElement' || elName(ch) !== 'Tab') continue;
        const title = strAttr(attrs(ch).title);
        const page = build(ch, null, scope); // Tab builds its own box, not packed
        out.build.push(`  gtk_notebook_append_page(GTK_NOTEBOOK(${nb}), ${page}, gtk_label_new(${cstr(title)}));`);
      }
      pack(nb); return nb;
    }
    if (name === 'Text') {
      const info = textSnippet(el, scope, '');
      if (info.dynamic) {
        if (scope.__inrow) {  // inside a list/map row → built fresh on each rebuild (no shared state field / dep)
          const f = vid('t'); out.build.push(`  GtkWidget* ${f} = gtk_label_new("");`);
          out.build.push(`  ${textSnippet(el, scope, f).snippet}`);
          applyStyle(f, st); labelAlign(f, st); addClass(f); pack(f); return f;
        }
        const f = vid('lbl'); stateFields.push(`  GtkWidget* ${f};`);
        out.build.push(`  s->${f} = gtk_label_new("");`);
        const real = textSnippet(el, scope, `s->${f}`);   // snippet bound to the real target
        out.build.push(`  ${real.snippet}`);
        info.reads.forEach((cn) => deps[cn].push(real.snippet));
        applyStyle(`s->${f}`, st); labelAlign(`s->${f}`, st); addClass(`s->${f}`); pack(`s->${f}`); return `s->${f}`;
      }
      const l = vid('t');
      out.build.push(`  GtkWidget* ${l} = gtk_label_new(${cstr(info.staticText)});`);
      applyStyle(l, st); labelAlign(l, st); addClass(l); pack(l); return l;
    }
    if (name === 'Button') {
      const b = vid('b');
      let label = '', dynTitle = null;
      if (a.title && a.title.type === 'StringLiteral') label = a.title.value;
      else if (a.title && a.title.type === 'JSXExpressionContainer') { if (a.title.expression.type === 'StringLiteral') label = a.title.expression.value; else dynTitle = a.title.expression; }
      else if (!a.title) label = el.children.filter((c) => c.type === 'JSXText').map((c) => c.value.trim()).filter(Boolean).join(' ');
      out.build.push(`  GtkWidget* ${b} = gtk_button_new_with_label(${cstr(label)});`);
      if (dynTitle) {  // reactive button label
        const tv = cexpr(dynTitle, scope);
        const tw = scope.__inrow ? b : stash(b);
        const snip = `gtk_button_set_label(GTK_BUTTON(${tw}), ${tv.t === 'string' ? tv.c : `g_strdup_printf("%lld", (long long)(${tv.c}))`});`;
        out.build.push('  ' + snip);
        if (!scope.__inrow) cellsIn(dynTitle).forEach((cn) => deps[cn] && deps[cn].push(snip));
      }
      addClass(b);
      let press = a.onPress || a.onClick;   // onClick alias (web parity)
      if (!press && strAttr(a.type) === 'submit' && scope.__form) press = scope.__form; // form submit button
      if (press) {
        const cb = emitHandler(press, scope, 'click');
        if (scope.__index) out.build.push(`  g_object_set_data(G_OBJECT(${b}), "swiss_i", (gpointer)(intptr_t)${scope.__index.c});`);
        out.build.push(`  g_signal_connect(${b}, "clicked", G_CALLBACK(${cb}), s);`);
      }
      if (a.disabled && a.disabled.type === 'JSXExpressionContainer') {  // reactive disabled
        const bw = stash(b);
        const snip = `gtk_widget_set_sensitive(GTK_WIDGET(${bw}), !(${cexpr(a.disabled.expression, scope).c}));`;
        out.build.push(`  ${snip}`); cellsIn(a.disabled.expression).forEach((cn) => deps[cn].push(snip));
      }
      applyStyle(b, st); crossFill(b, st); pack(b); return b;
    }
    if (name === 'Input') {
      const f = vid('ent'); stateFields.push(`  GtkWidget* ${f};`);
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      out.build.push(`  s->${f} = gtk_entry_new();`);
      const ph = strAttr(a.placeholder);
      if (ph) out.build.push(`  gtk_entry_set_placeholder_text(GTK_ENTRY(s->${f}), ${cstr(ph)});`);
      if (cell) {
        out.build.push(`  gtk_entry_set_text(GTK_ENTRY(s->${f}), ${cell.t === 'string' ? `s->${cell.name}` : '""'});`);
        // cell change → update entry (guarded against loop)
        deps[cell.name].push(`if (strcmp(gtk_entry_get_text(GTK_ENTRY(s->${f})), s->${cell.name}) != 0) gtk_entry_set_text(GTK_ENTRY(s->${f}), s->${cell.name});`);
        // onChange: setter identifier  OR  (e) => setX(e.target.value)
        if (a.onChange) {
          const h = a.onChange.expression;
          const id = `cb_${hN++}`;
          const lines = [];
          if (h.type === 'Identifier' && cellBySetter(h.name)) {
            const tc = cellBySetter(h.name);
            lines.push(`  s->${tc.name} = g_strdup(gtk_entry_get_text(GTK_ENTRY(w))); swiss_update_${tc.name}(s);`);
          } else if (h.type === 'ArrowFunctionExpression') {
            genStmts(h.body, { ...scope, __evtext: `g_strdup(gtk_entry_get_text(GTK_ENTRY(w)))` }, lines);
          } else err('Input onChange must be a setter or (e)=>setX(e.target.value)', a.onChange);
          out.fns.push(`static void ${id}(GtkWidget* w, gpointer ud) {\n  SwissState* s = (SwissState*)ud; (void)w;\n${lines.join('\n')}\n}`);
          out.build.push(`  g_signal_connect(s->${f}, "changed", G_CALLBACK(${id}), s);`);
        }
      }
      const sub = a.onSubmit || scope.__form;   // explicit onSubmit, or enclosing <form>
      if (sub) out.build.push(`  g_signal_connect(s->${f}, "activate", G_CALLBACK(${emitHandler(sub, scope, 'click')}), s);`);
      applyStyle(`s->${f}`, st); crossFill(`s->${f}`, st); addClass(`s->${f}`); pack(`s->${f}`); return `s->${f}`;
    }
    if (name === 'Switch') {
      const sw = vid('sw'); stateFields.push(`  GtkWidget* ${sw};`);
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      out.build.push(`  s->${sw} = gtk_switch_new();`);
      if (cell) out.build.push(`  gtk_switch_set_active(GTK_SWITCH(s->${sw}), ${`s->${cell.name}`});`);
      if (a.onChange) { const cb = emitHandler(a.onChange, scope, 'switch'); out.build.push(`  g_signal_connect(s->${sw}, "state-set", G_CALLBACK(${cb}), s);`); }
      applyStyle(`s->${sw}`, st); addClass(`s->${sw}`); pack(`s->${sw}`); return `s->${sw}`;
    }
    if (name === 'List') {
      // count={cell}  item={(i)=> JSX}
      const countExpr = a.count.expression;
      const countCell = countExpr.type === 'Identifier' ? cellByName(countExpr.name) : null;
      const itemFn = a.item.expression; // arrow (i) => JSX
      const idxName = itemFn.params[0] ? itemFn.params[0].name : 'i';
      const box = vid('list'); stateFields.push(`  GtkWidget* ${box};`);
      out.build.push(`  s->${box} = gtk_box_new(GTK_ORIENTATION_VERTICAL, 6);`);
      applyStyle(`s->${box}`, st); pack(`s->${box}`);
      // build a row-builder function from the item JSX (separate build pass)
      const rowFn = `swiss_row_${out.lists.length}`;
      const rebuildFn = `swiss_list_rebuild_${out.lists.length}`;
      out.lists.push({ box, rowFn, rebuildFn, itemFn, idxName, countCell });
      // count cell change → rebuild
      if (countCell) deps[countCell.name].push(`${rebuildFn}(s);`);
      return `s->${box}`;
    }
    if (name === 'Checkbox') {
      const w = vid('chk'); stateFields.push(`  GtkWidget* ${w};`);
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      out.build.push(`  s->${w} = gtk_check_button_new_with_label(${cstr(strAttr(a.label))});`);
      if (cell) {
        out.build.push(`  gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(s->${w}), s->${cell.name});`);
        deps[cell.name].push(`gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(s->${w}), s->${cell.name});`);
      }
      if (a.onChange) out.build.push(`  g_signal_connect(s->${w}, "toggled", G_CALLBACK(${emitHandler(a.onChange, scope, 'toggle')}), s);`);
      applyStyle(`s->${w}`, st); addClass(`s->${w}`); pack(`s->${w}`); return `s->${w}`;
    }
    if (name === 'Slider') {
      const w = vid('sl'); stateFields.push(`  GtkWidget* ${w};`);
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      const min = Number(strAttr(a.min) || (a.min && a.min.expression && a.min.expression.value) || 0);
      const max = Number(strAttr(a.max) || (a.max && a.max.expression && a.max.expression.value) || 100);
      out.build.push(`  s->${w} = gtk_scale_new_with_range(GTK_ORIENTATION_HORIZONTAL, ${min}, ${max}, 1);`);
      if (cell) {
        out.build.push(`  gtk_range_set_value(GTK_RANGE(s->${w}), s->${cell.name});`);
        deps[cell.name].push(`if ((long long)gtk_range_get_value(GTK_RANGE(s->${w})) != s->${cell.name}) gtk_range_set_value(GTK_RANGE(s->${w}), s->${cell.name});`);
      }
      if (a.onChange) out.build.push(`  g_signal_connect(s->${w}, "value-changed", G_CALLBACK(${emitHandler(a.onChange, scope, 'range')}), s);`);
      applyStyle(`s->${w}`, st); addClass(`s->${w}`); pack(`s->${w}`); return `s->${w}`;
    }
    if (name === 'ProgressBar') {
      const w = vid('pb'); stateFields.push(`  GtkWidget* ${w};`);
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      const max = Number(strAttr(a.max) || (a.max && a.max.expression && a.max.expression.value) || 100);
      out.build.push(`  s->${w} = gtk_progress_bar_new();`);
      if (cell) {
        const setf = `gtk_progress_bar_set_fraction(GTK_PROGRESS_BAR(s->${w}), (double)s->${cell.name} / ${max}.0);`;
        out.build.push(`  ${setf}`); deps[cell.name].push(setf);
      }
      applyStyle(`s->${w}`, st); addClass(`s->${w}`); pack(`s->${w}`); return `s->${w}`;
    }
    if (name === 'Image') {
      const w = vid('img');
      out.build.push(`  GtkWidget* ${w} = gtk_image_new_from_file(${cstr(strAttr(a.src))});`);
      applyStyle(w, st); addClass(w); pack(w); return w;
    }
    if (name === 'Separator') {
      const w = vid('sep');
      const horiz = !(st && st.flexDirection === 'row');
      out.build.push(`  GtkWidget* ${w} = gtk_separator_new(${horiz ? 'GTK_ORIENTATION_HORIZONTAL' : 'GTK_ORIENTATION_VERTICAL'});`);
      applyStyle(w, st); pack(w); return w;
    }
    if (name === 'Select') {
      const w = vid('cmb'); stateFields.push(`  GtkWidget* ${w};`);
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      out.build.push(`  s->${w} = gtk_combo_box_text_new();`);
      const opts = a.options && a.options.expression && a.options.expression.type === 'ArrayExpression' ? a.options.expression.elements : [];
      for (const o of opts) out.build.push(`  gtk_combo_box_text_append_text(GTK_COMBO_BOX_TEXT(s->${w}), ${cstr(o.value)});`);
      if (cell) {
        out.build.push(`  gtk_combo_box_set_active(GTK_COMBO_BOX(s->${w}), s->${cell.name});`);
        deps[cell.name].push(`if (gtk_combo_box_get_active(GTK_COMBO_BOX(s->${w})) != s->${cell.name}) gtk_combo_box_set_active(GTK_COMBO_BOX(s->${w}), s->${cell.name});`);
      }
      if (a.onChange) out.build.push(`  g_signal_connect(s->${w}, "changed", G_CALLBACK(${emitHandler(a.onChange, scope, 'combo')}), s);`);
      applyStyle(`s->${w}`, st); addClass(`s->${w}`); pack(`s->${w}`); return `s->${w}`;
    }
    if (name === 'TextArea') {
      const w = vid('ta'); stateFields.push(`  GtkWidget* ${w};`);
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      out.build.push(`  s->${w} = gtk_text_view_new();`);
      out.build.push(`  gtk_text_view_set_wrap_mode(GTK_TEXT_VIEW(s->${w}), GTK_WRAP_WORD);`);
      if (cell) {
        out.build.push(`  { GtkTextBuffer* _bf = gtk_text_view_get_buffer(GTK_TEXT_VIEW(s->${w})); gtk_text_buffer_set_text(_bf, s->${cell.name}, -1); }`);
        if (a.onChange && a.onChange.expression.type === 'Identifier' && cellBySetter(a.onChange.expression.name)) {
          const tc = cellBySetter(a.onChange.expression.name);
          const id = `cb_${hN++}`;
          out.fns.push(`static void ${id}(GtkTextBuffer* _bf, gpointer ud) {\n  SwissState* s = (SwissState*)ud;\n  GtkTextIter _a, _b; gtk_text_buffer_get_bounds(_bf, &_a, &_b);\n  s->${tc.name} = gtk_text_buffer_get_text(_bf, &_a, &_b, FALSE); swiss_update_${tc.name}(s);\n}`);
          out.build.push(`  g_signal_connect(gtk_text_view_get_buffer(GTK_TEXT_VIEW(s->${w})), "changed", G_CALLBACK(${id}), s);`);
        }
      }
      applyStyle(`s->${w}`, st); addClass(`s->${w}`); pack(`s->${w}`); return `s->${w}`;
    }
    if (name === 'Spinner') {
      const w = vid('sp');
      out.build.push(`  GtkWidget* ${w} = gtk_spinner_new();`);
      out.build.push(`  gtk_spinner_start(GTK_SPINNER(${w}));`);
      applyStyle(w, st); pack(w); return w;
    }
    if (name === 'Calendar') {
      const w = vid('cal');
      out.build.push(`  GtkWidget* ${w} = gtk_calendar_new();`);
      applyStyle(w, st); addClass(w); pack(w); return w;
    }
    if (name === 'Expander') {
      const w = vid('exp');
      out.build.push(`  GtkWidget* ${w} = gtk_expander_new(${cstr(strAttr(a.title))});`);
      const inner = vid('v');
      out.build.push(`  GtkWidget* ${inner} = gtk_box_new(GTK_ORIENTATION_VERTICAL, ${Number((st && st.gap) || 4)});`);
      buildChildren(el.children, inner, scope);
      out.build.push(`  gtk_container_add(GTK_CONTAINER(${w}), ${inner});`);
      applyStyle(w, st); addClass(w); pack(w); return w;
    }
    err(`unsupported component <${name}>`, el);
  }

  // children loop: real elements + conditional expression children
  // all state cells an expression depends on (follows derived consts)
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
        // {children} / {props.children} inside an inlined component → caller's kids
        if (scope.__children && ((ex.type === 'Identifier' && ex.name === 'children') ||
            (ex.type === 'MemberExpression' && ex.object.name === 'props' && ex.property.name === 'children'))) {
          buildChildren(scope.__children.nodes, parentVar, scope.__children.scope); continue;
        }
        if (ex.type === 'CallExpression' && ex.callee.type === 'MemberExpression' && ex.callee.property.name === 'map') {
          const o = ex.callee.object;
          // arr.map(...)
          if (o.type === 'Identifier' && cellByName(o.name) && cellByName(o.name).t === 'array') { buildMap(ex, parentVar, scope, o.name, null); continue; }
          // arr.filter(pred).map(...)
          if (o.type === 'CallExpression' && o.callee.type === 'MemberExpression' && o.callee.property.name === 'filter' &&
              o.callee.object.type === 'Identifier' && cellByName(o.callee.object.name) && cellByName(o.callee.object.name).t === 'array') {
            buildMap(ex, parentVar, scope, o.callee.object.name, o.arguments[0]); continue;
          }
        }
        buildCond(ch.expression, parentVar, scope);
      }
    }
  }
  // {arr.map((it,i)=><JSX>)} or {arr.filter(p).map(...)} → box rebuilt from the array
  function buildMap(ex, parent, scope, arrName, filterArrow) {
    const cell = cellByName(arrName);
    const itName = ex.arguments[0].params[0] ? ex.arguments[0].params[0].name : 'it';
    const idxParam = ex.arguments[0].params[1] ? ex.arguments[0].params[1].name : null;
    const itemJSX = stripParens(ex.arguments[0].body);
    const box = vid('map'); stateFields.push(`  GtkWidget* ${box};`);
    out.build.push(`  s->${box} = gtk_box_new(GTK_ORIENTATION_VERTICAL, 6);`);
    if (parent) out.build.push(`  gtk_box_pack_start(GTK_BOX(${parent}), s->${box}, FALSE, FALSE, 0);`);
    out.lists.push({ kind: 'map', box, rowFn: `swiss_map_${out.lists.length}`, rebuildFn: `swiss_maprebuild_${out.lists.length}`, itemJSX, itName, idxParam, cell, filterArrow });
    const L = out.lists[out.lists.length - 1];
    // rebuild when the array OR any cell the rows/filter read changes
    const reads = cellsIn(itemJSX); reads.add(cell.name);
    if (filterArrow) cellsIn(filterArrow.body).forEach((c) => reads.add(c));
    reads.forEach((cn) => { if (deps[cn] && !deps[cn].includes(`${L.rebuildFn}(s);`)) deps[cn].push(`${L.rebuildFn}(s);`); });
  }
  // inline a presentational component: bind its props (from JSX attrs) and build its JSX
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
    scope.__children = { nodes: el.children, scope: callerScope };  // for {children}
    const body = comp.node.body;
    const jsx = body.type === 'BlockStatement' ? (body.body.find((s) => s.type === 'ReturnStatement') || {}).argument : body;
    return build(stripParens(jsx), parent, scope);
  }
  // {cond && <X/>}  and  {cond ? <A/> : <B/>}  → build + reactive gtk_widget_set_visible
  // store a built widget in SwissState so visibility snippets (which run in
  // swiss_effect / cell-update fns, not build_ui) can reach it.
  const stash = (w) => { const f = vid('cond'); stateFields.push(`  GtkWidget* ${f};`); out.build.push(`  s->${f} = ${w};`); return `s->${f}`; };
  function buildCond(expr, parentVar, scope) {
    expr = stripParens(expr);
    // inside a list/map row: wrap the element build in a runtime C `if` (the whole
    // row is rebuilt, so no persistent widget/visibility tracking is needed)
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
      const w = stash(build(el, parentVar, scope));
      const snip = `gtk_widget_set_visible(GTK_WIDGET(${w}), (${cexpr(expr.left, scope).c}));`;
      out.postShow.push(snip);
      cellsIn(expr.left).forEach((cn) => deps[cn].push(snip));
      return;
    }
    if (expr.type === 'ConditionalExpression') {
      const ae = jsxOf(expr.consequent), be = jsxOf(expr.alternate);
      if (ae && be) {
        const wa = stash(build(ae, parentVar, scope)), wb = stash(build(be, parentVar, scope));
        const snip = `{ gboolean _c = (${cexpr(expr.test, scope).c}); gtk_widget_set_visible(GTK_WIDGET(${wa}), _c); gtk_widget_set_visible(GTK_WIDGET(${wb}), !_c); }`;
        out.postShow.push(snip);
        cellsIn(expr.test).forEach((cn) => deps[cn].push(snip));
        return;
      }
    }
    err('only {cond && <El/>} or {cond ? <A/> : <B/>} JSX expression children are supported', expr);
  }

  // ── build list row builders (deferred so build() output ordering is clean) ──
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
      const rootVar = build(stripParens(jsx), null, rowScope);
      const rowBody = out.build; out.build = saved;
      out.fns.push(`static GtkWidget* ${L.rowFn}(SwissState* s, long long ${idxVar}) {\n${rowBody.join('\n')}\n  return ${rootVar};\n}`);
      out.fns.push(
        `static void ${L.rebuildFn}(SwissState* s) {\n` +
        `  GList* ch = gtk_container_get_children(GTK_CONTAINER(s->${L.box}));\n` +
        `  for (GList* it = ch; it; it = it->next) gtk_widget_destroy(GTK_WIDGET(it->data));\n` +
        `  g_list_free(ch);\n` +
        `  for (long long ${idxVar} = 0; ${idxVar} < ${countC}; ${idxVar}++) {\n` +
        skip +
        `    gtk_box_pack_start(GTK_BOX(s->${L.box}), ${L.rowFn}(s, ${idxVar}), FALSE, FALSE, 0);\n` +
        `  }\n  gtk_widget_show_all(s->${L.box});\n}`
      );
    }
  }
  const idxC = (n) => n; // row index is a plain C local in the row builder
  const stripParens = (n) => (n.type === 'ParenthesizedExpression' ? n.expression : n);

  // per-row button callbacks need the index: rewrite handlers that read the row
  // index to fetch it from widget data. (Handled generically: in a row scope the
  // index identifier maps to a C local read from g_object data inside the cb.)

  // ── go ──
  emitMethods();
  const rootJSX = (() => { let j = null; for (const s of comp.body.body) if (s.type === 'ReturnStatement') j = stripParens(s.argument); if (!j) err('component must return JSX'); return j; })();
  const rootVar = build(rootJSX, null, {});
  emitLists();

  // useEffect(fn, deps) → fn at startup; if deps non-empty, also re-run on change
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

  // non-literal useState inits (e.g. useState(ezy.call(...))) → set in swiss_init
  const initCellLines = cells.filter((c) => c.initNode).map((c) => `  s->${c.name} = ${cexpr(c.initNode, {}).c};`);
  // object-state inits: per-field from the {…} literal
  for (const c of objectCells)
    if (c.initObj) for (const p of c.initObj.properties) {
      if (p.type === 'SpreadElement' || !p.key) continue;
      const fn = p.key.name || p.key.value; const f = c.fields.find((x) => x.name === fn);
      initCellLines.push(`  s->${c.name}.${fn} = ${f && f.t === 'string' ? `g_strdup(${cexpr(p.value, {}).c})` : cexpr(p.value, {}).c};`);
    }

  // cell update functions
  for (const c of cells)
    out.updates.push(`static void swiss_update_${c.name}(SwissState* s) {\n${deps[c.name].map((d) => '  ' + d).join('\n') || '  (void)s;'}\n}`);

  const externDecls = [...out.externs].map((f) => {
    const s = sigs[f]; if (!s) return `extern long long ${f}();`;
    return `extern ${cType(s.ret)} ${f}(${s.args.length ? s.args.map(cType).join(', ') : 'void'});`;
  }).join('\n');

  return `// Generated by swiss-gtkc — do not edit.
#include <gtk/gtk.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>

${externDecls || '// (no ezy backend calls)'}

${objectCells.map((c) => `typedef struct { ${c.fields.map((f) => `${f.ctype} ${f.name};`).join(' ') || 'int _u;'} } ${c.struct};`).join('\n')}
${arrayCells.map((c) =>
  `typedef struct { ${c.fields.map((f) => `${f.ctype} ${f.name};`).join(' ') || 'int _u;'} } ${c.struct};\n` +
  `typedef struct { ${c.struct}* data; long long len, cap; } ${c.arrtype};\n` +
  `static void arrpush_${c.name}(${c.arrtype}* a, ${c.struct} v) { if (a->len >= a->cap) { a->cap = a->cap ? a->cap * 2 : 8; a->data = realloc(a->data, a->cap * sizeof(${c.struct})); } a->data[a->len++] = v; }`
).join('\n')}

typedef struct {
${cells.map((c) => `  ${c.ctype} ${c.name};`).join('\n') || '  int _u;'}
${refs.map((r) => `  ${r.ctype} ${r.name}__current;`).join('\n')}
${stateFields.join('\n')}
} SwissState;

static SwissState S;

static char* swiss_concat(const char* a, const char* b) { return g_strconcat(a, b, NULL); }
static long long swiss_indexof(const char* s, const char* sub) { const char* p = strstr(s, sub); return p ? (long long)(p - s) : -1; }
static char* swiss_substr(const char* s, long long a, long long b) {
  long long n = (long long)strlen(s); if (a < 0) a = 0; if (b < 0 || b > n) b = n; if (b < a) b = a;
  return g_strndup(s + a, (gsize)(b - a));
}
static char* swiss_replace(const char* s, const char* from, const char* to) {
  char** parts = g_strsplit(s, from, -1); char* r = g_strjoinv(to, parts); g_strfreev(parts); return r;
}
static char* swiss_pick_folder(void) {
  GtkWidget* d = gtk_file_chooser_dialog_new("Elegir carpeta", NULL,
    GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER, "Cancelar", GTK_RESPONSE_CANCEL,
    "Elegir", GTK_RESPONSE_ACCEPT, NULL);
  char* res = g_strdup("");
  if (gtk_dialog_run(GTK_DIALOG(d)) == GTK_RESPONSE_ACCEPT) {
    char* p = gtk_file_chooser_get_filename(GTK_FILE_CHOOSER(d));
    if (p) { g_free(res); res = g_strdup(p); g_free(p); }
  }
  gtk_widget_destroy(d);
  return res;
}
static char* swiss_pick_file(void) {
  GtkWidget* d = gtk_file_chooser_dialog_new("Elegir archivo", NULL,
    GTK_FILE_CHOOSER_ACTION_OPEN, "Cancelar", GTK_RESPONSE_CANCEL, "Abrir", GTK_RESPONSE_ACCEPT, NULL);
  char* res = g_strdup("");
  if (gtk_dialog_run(GTK_DIALOG(d)) == GTK_RESPONSE_ACCEPT) {
    char* p = gtk_file_chooser_get_filename(GTK_FILE_CHOOSER(d));
    if (p) { g_free(res); res = g_strdup(p); g_free(p); }
  }
  gtk_widget_destroy(d);
  return res;
}
static void swiss_alert(const char* msg) {
  GtkWidget* d = gtk_message_dialog_new(NULL, GTK_DIALOG_MODAL, GTK_MESSAGE_INFO, GTK_BUTTONS_OK, "%s", msg);
  gtk_dialog_run(GTK_DIALOG(d)); gtk_widget_destroy(d);
}
static long long swiss_confirm(const char* msg) {
  GtkWidget* d = gtk_message_dialog_new(NULL, GTK_DIALOG_MODAL, GTK_MESSAGE_QUESTION, GTK_BUTTONS_YES_NO, "%s", msg);
  int r = gtk_dialog_run(GTK_DIALOG(d)); gtk_widget_destroy(d);
  return r == GTK_RESPONSE_YES ? 1 : 0;
}
static void swiss_set_theme(long long light) {
  g_object_set(gtk_settings_get_default(), "gtk-application-prefer-dark-theme", (gboolean)!light, NULL);
}

${cells.map((c) => `static void swiss_update_${c.name}(SwissState* s);`).join('\n')}

${out.fns.join('\n\n')}

${out.updates.join('\n\n')}

static void swiss_apply_css(void) {
  GtkCssProvider* p = gtk_css_provider_new();
  gtk_css_provider_load_from_data(p, ${cstr(out.css.join(''))}, -1, NULL);
  gtk_style_context_add_provider_for_screen(gdk_screen_get_default(), GTK_STYLE_PROVIDER(p), GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
  g_object_unref(p);
}

static GtkWidget* swiss_build_ui(SwissState* s) {
${out.build.join('\n')}
  return ${rootVar};
}

static void swiss_init(SwissState* s) {
${initCellLines.join('\n') || '  (void)s;'}
}

static void swiss_effect(SwissState* s) {
${[...out.postShow.map((x) => '  ' + x), ...initLines].join('\n') || '  (void)s;'}
}

int main(int argc, char** argv) {
  gtk_init(&argc, &argv);
  swiss_set_theme(0);
  swiss_apply_css();
${cells.filter((c) => c.cinit != null).map((c) => `  S.${c.name} = ${c.cinit};`).join('\n')}
${refs.map((r) => `  S.${r.name}__current = ${r.cinit};`).join('\n')}
  swiss_init(&S);
  GtkWidget* win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_title(GTK_WINDOW(win), ${cstr(opts.title || 'Swiss')});
  gtk_window_maximize(GTK_WINDOW(win));
  gtk_window_set_default_size(GTK_WINDOW(win), 900, 600);
  g_signal_connect(win, "destroy", G_CALLBACK(gtk_main_quit), NULL);
  gtk_container_add(GTK_CONTAINER(win), swiss_build_ui(&S));
  gtk_widget_show_all(win);
  swiss_effect(&S);
  gtk_main();
  return 0;
}
`;
}

function main() {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith('--'));
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'frontend.c';
  const title = args.includes('--title') ? args[args.indexOf('--title') + 1] : 'Swiss';
  let sigs = {};
  if (args.includes('--sig') && existsSync(args[args.indexOf('--sig') + 1])) sigs = JSON.parse(readFileSync(args[args.indexOf('--sig') + 1], 'utf8'));
  if (!input) { console.error('usage: swiss-gtkc <App.jsx> --out frontend.c [--title T] [--sig sig.json]'); process.exit(1); }
  const ast = parse(readFileSync(input, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
  writeFileSync(out, emit(ast, { title, sigs }));
  console.error(`swiss-gtkc: ${input} → ${out}`);
}
main();
