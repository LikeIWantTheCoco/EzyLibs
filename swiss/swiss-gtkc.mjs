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
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { parse, walk, cstr, cType, stripParens, createFrontend } from './swiss-jsx-core.mjs';

// ───────────────────────── emit ─────────────────────────
function emit(ast, opts) {
  const F = createFrontend(ast, { sigs: opts.sigs || {}, tag: 'swiss-gtkc', widgetType: 'GtkWidget*' });
  const {
    err, sigs, styles, comp, cells, methods, refs, derived, components,
    cellByName, cellBySetter, methodByName, refByName, componentByName,
    arrayCells, objectCells, deps, out, stateFields, vid,
    cexpr, genStmt, genStmts, genArraySet, objLit, emitMethods, handlerBody,
    cellsIn, jsxOf, rootJSX,
  } = F;
  out.css = [];
  const cssClasses = {}; let cssN = 0;

  // ── handler arrow → a C callback name; supports onPress (clicked) etc ──
  let hN = 0;
  // how to read the event value for each handler kind (the value passed to onChange)
  const VAL = {
    toggle: 'gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(w))',
    range: '(long long)gtk_range_get_value(GTK_RANGE(w))',
    combo: 'gtk_combo_box_get_active(GTK_COMBO_BOX(w))',
  };
  function emitHandler(attrNode, scope, kind) {
    const id = `cb_${hN++}`;
    // value name the handler sees: switch via param, others via _v
    const valName = kind === 'switch' ? '_sw_on' : VAL[kind] ? '_v' : null;
    const lines = handlerBody(attrNode.expression, scope, valName);   // shared handler body
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
      // padding is inner spacing (not outer margin). When an explicit height is
      // set it is authoritative (Win32 total-height model), so drop the vertical
      // padding — otherwise it inflates the control and a small height looks like
      // the default; keep horizontal padding for text inset.
      if (k === 'padding') css.push(st.height != null ? `padding:0px ${v}px` : `padding:${v}px`);
      // height → min-height: GTK won't shrink below its natural height with
      // size_request, but min-height can (down to the font's line height).
      else if (k === 'height') css.push(`min-height:${v}px`);
      else if (k === 'fontSize') css.push(`font-size:${v}px`);
      else if (k === 'fontWeight') css.push(`font-weight:${v}`);
      else if (k === 'color') css.push(`color:${v}`);
      else if (k === 'backgroundColor') css.push(`background-color:${v};background-image:none`);
      else if (k === 'borderWidth') css.push(`border-width:${v}px;border-style:solid`);
      else if (k === 'borderColor') css.push(`border-color:${v}`);
      else if (k === 'borderRadius') css.push(`border-radius:${v}px`);
      else if (k === 'boxShadow') css.push(`box-shadow:0 2px 8px rgba(0,0,0,0.18)`);
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
      else if (k === 'margin') { if (/auto/.test(s)) o.alignSelf = 'center'; else o.margin = num(s); }
      else if (k === 'alignSelf') o.alignSelf = s;
      else if (k === 'marginTop') o.marginTop = num(s);
      else if (k === 'marginBottom') o.marginBottom = num(s);
      else if (k === 'marginLeft') o.marginLeft = num(s);
      else if (k === 'marginRight') o.marginRight = num(s);
      else if (k === 'width') { if (s === '100%') o.fillCross = true; else o.width = num(s); }
      else if (k === 'maxWidth' || k === 'minWidth') o.width = num(s);
      else if (k === 'height' || k === 'maxHeight' || k === 'minHeight') o.height = num(s);
      else if (k === 'flex' || k === 'flexGrow') o.flex = num(s);
      else if (k === 'fontSize') o.fontSize = num(s);
      else if (k === 'fontWeight') o.fontWeight = s;
      else if (k === 'color') o.color = s;
      else if (k === 'backgroundColor' || k === 'background') o.backgroundColor = s;
      else if (k === 'borderRadius') o.borderRadius = num(s);
      else if (k === 'boxShadow') o.boxShadow = s;
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
    // alignSelf / margin:auto → the box's OWN cross-align (e.g. a centered
    // maxWidth block). alignItems is the children's cross-align, handled by the
    // box's natural packing — it must NOT self-align (and shrink) the container.
    if (st.alignSelf && ALIGN[st.alignSelf]) out.build.push(`  gtk_widget_set_halign(${v}, ${ALIGN[st.alignSelf]});`);
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

  // children loop (cellsIn / jsxOf come from the core)
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
  // ── go ── (stripParens / cellsIn / rootJSX come from the core)
  emitMethods();
  const rootVar = build(rootJSX(), null, {});
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
  // seed initial array-state elements (useState([{…}, …]))
  for (const c of arrayCells)
    if (c.initArr) for (const el of c.initArr.elements)
      if (el && el.type === 'ObjectExpression') initCellLines.push(`  arrpush_${c.name}(&s->${c.name}, ${objLit(c, el, {})});`);
  // render seeded list/map rows once at startup (before any state change)
  for (const L of out.lists) initLines.push(`  ${L.rebuildFn}(s);`);

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
#include <stdarg.h>
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

// ── swiss_* helper API (the shared core emits these; here over GLib) ──
static char* swiss_aprintf(const char* fmt, ...) { va_list ap; va_start(ap, fmt); char* r = g_strdup_vprintf(fmt, ap); va_end(ap); return r; }
static char* swiss_strdup(const char* s) { return g_strdup(s); }
static char* swiss_upper(const char* s) { return g_ascii_strup(s, -1); }
static char* swiss_lower(const char* s) { return g_ascii_strdown(s, -1); }
static char* swiss_trim(const char* s) { return g_strstrip(g_strdup(s)); }
static int swiss_startswith(const char* s, const char* p) { return g_str_has_prefix(s, p); }
static int swiss_endswith(const char* s, const char* p) { return g_str_has_suffix(s, p); }
static char* swiss_concat(const char* a, const char* b) { return g_strconcat(a, b, NULL); }
static long long swiss_indexof(const char* s, const char* sub) { const char* p = strstr(s, sub); return p ? (long long)(p - s) : -1; }
// timers: a void(SwissState*) callback driven by g_timeout
static struct { guint id; void (*cb)(SwissState*); int repeat; } g_timers[32]; static int g_ntimers;
static gboolean swiss_timer_tramp(gpointer ud) { int i = (int)(intptr_t)ud; g_timers[i].cb(&S); return g_timers[i].repeat ? G_SOURCE_CONTINUE : G_SOURCE_REMOVE; }
static long long swiss_timer_add(long long ms, void (*cb)(SwissState*), int repeat) {
  int i = g_ntimers < 32 ? g_ntimers++ : 0; g_timers[i].cb = cb; g_timers[i].repeat = repeat;
  g_timers[i].id = g_timeout_add((guint)ms, swiss_timer_tramp, (gpointer)(intptr_t)i); return (long long)g_timers[i].id;
}
static void swiss_timer_clear(long long id) { g_source_remove((guint)id); }
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
// theme: a swappable CSS provider forcing a light (default) or dark base, so
// the app looks the same regardless of the system GTK theme.
static GtkCssProvider* g_theme_prov;
static void swiss_set_theme(long long dark) {
  g_object_set(gtk_settings_get_default(), "gtk-application-prefer-dark-theme", (gboolean)dark, NULL);
  if (!g_theme_prov) {
    g_theme_prov = gtk_css_provider_new();
    gtk_style_context_add_provider_for_screen(gdk_screen_get_default(), GTK_STYLE_PROVIDER(g_theme_prov), GTK_STYLE_PROVIDER_PRIORITY_APPLICATION - 1);
  }
  // shape: flat, rounded, padded controls + a web-like accent focus ring — same
  // in both themes
  const char* shape =
    "entry, button, combobox { border-radius:4px; min-height:0; transition:120ms; }"
    " entry { padding:4px 8px; border:1px solid #cccccc; }"
    " entry:focus { border-color:#0066cc; }"
    " entry placeholder, entry text placeholder { color:#94a3b8; }"   // JSX/web-like gray placeholder (override the system theme's accent)
    " button:focus, entry:focus, combobox:focus { outline-color:#0066cc; outline-style:solid; outline-width:2px; }";
  char* css = g_strconcat(shape, dark
    ? " window { background-color:#1e1e1e; color:#e6e6e6; } entry, textview, text { background-color:#2a2a2a; color:#e6e6e6; } entry { border-color:#444; }"
    : " window { background-color:#ffffff; color:#1a1a1a; } entry, textview, text { background-color:#ffffff; color:#1a1a1a; }", NULL);
  gtk_css_provider_load_from_data(g_theme_prov, css, -1, NULL);
  g_free(css);
}

${cells.map((c) => `static void swiss_update_${c.name}(SwissState* s);`).join('\n')}

${out.fns.join('\n\n')}

${out.updates.join('\n\n')}

static void swiss_apply_css(void) {
  GtkCssProvider* p = gtk_css_provider_new();
  gtk_css_provider_load_from_data(p, ${cstr('* { font-family: "Segoe UI", system-ui, "Cantarell", "Roboto", "DejaVu Sans", Arial, sans-serif; font-size: 15px; } ' + out.css.join(''))}, -1, NULL);
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
