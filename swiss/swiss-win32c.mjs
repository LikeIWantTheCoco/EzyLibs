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
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { parse, walk, cstr, cType, stripParens, createFrontend, THEME, TOKENS, isToken } from './swiss-jsx-core.mjs';

// theme token → its index (used for runtime resolution); -1 if not a token.
const tokIdx = (v) => (isToken(v) ? TOKENS.indexOf(v) : -1);
// C table of [light,dark] COLORREFs per token, in TOKENS order.
const rgbC = (h) => { h = String(h).replace('#', ''); return `RGB(0x${h.slice(0, 2)}, 0x${h.slice(2, 4)}, 0x${h.slice(4, 6)})`; };
const tokTableC = () => TOKENS.map((t) => `  { ${rgbC(THEME[t][0])}, ${rgbC(THEME[t][1])} },   // ${t}`).join('\n');

// ───────────────────────── emit ─────────────────────────
function emit(ast, opts) {
  const F = createFrontend(ast, { sigs: opts.sigs || {}, tag: 'swiss-win32c', widgetType: 'HWND' });
  const {
    err, sigs, styles, comp, cells, methods, refs, derived, components,
    cellByName, cellBySetter, methodByName, refByName, componentByName,
    arrayCells, objectCells, deps, out, stateFields, vid,
    cexpr, genStmt, genStmts, genArraySet, objLit, emitMethods, handlerBody,
    cellsIn, jsxOf, rootJSX,
  } = F;
  out.cmds = []; out.fonts = new Set(); out.colors = false;   // win32-specific accumulators
  let cmdN = 100;

  // ── handlers → C callbacks, dispatched from WndProc by command id ──
  let hN = 0;
  // how each control kind reads its event value (the value passed to onChange)
  const VAL = {
    toggle: 'swiss_check_get(w)',
    range: '(long long)SendMessageA(w, TBM_GETPOS, 0, 0)',
    combo: '(long long)SendMessageA(w, CB_GETCURSEL, 0, 0)',
  };
  // build a callback body (shared core) and register it under a fresh command id
  function emitHandler(attrNode, scope, kind) {
    const id = `cb_${hN++}`;
    const valName = VAL[kind] ? '_v' : null;
    const lines = handlerBody(attrNode.expression, scope, valName);
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
      else if (k === 'fontStyle') o.fontStyle = s;
      else if (k === 'textDecoration') o.textDecoration = s;
      else if (k === 'textTransform') o.textTransform = s;
      else if (k === 'letterSpacing') o.letterSpacing = num(s);
      else if (k === 'lineHeight') o.lineHeight = Number(s);
      else if (k === 'color') o.color = s;
      else if (k === 'backgroundColor' || k === 'background') o.backgroundColor = s;
      else if (k === 'borderRadius') o.borderRadius = num(s);
      else if (k === 'border') { if (s !== 'none') { const m = s.match(/(\d+)px\s+\w+\s+(\S+)/); if (m) { o.borderWidth = parseInt(m[1]); o.borderColor = m[2]; } } }
      else if (k === 'borderColor') o.borderColor = s;
      else if (k === 'borderWidth') o.borderWidth = num(s);
      else if (k === 'opacity') o.opacity = parseFloat(s);
      else if (k === 'overflow' || k === 'overflowY') o.overflow = s;
      else if (k === 'boxShadow') o.boxShadow = s;
      else if (k === 'textAlign') o.textAlign = s;
      else if (k === 'flexDirection') o.flexDirection = s;
      else if (k === 'gap') o.gap = num(s);
      else if (k === 'alignItems') o.alignItems = s;
      else if (k === 'justifyContent') o.justifyContent = s;
      else if (k === 'position') o.position = s;
      else if (k === 'top') o.top = num(s);
      else if (k === 'left') o.left = num(s);
      else if (k === 'right') o.right = num(s);
      else if (k === 'bottom') o.bottom = num(s);
      else if (k === 'zIndex') o.zIndex = num(s);
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
    const shadow = st && st.boxShadow && st.boxShadow !== 'none' ? 1 : 0;
    // border: honor the `border: '1px solid #ccc'` shorthand (from StyleSheet refs,
    // which arrive raw) as well as explicit borderWidth/borderColor.
    let _bc = st && st.borderColor, _bw = st && st.borderWidth;
    if (st && st.border && st.border !== 'none' && _bc == null) {
      const mm = String(st.border).match(/(\d+)px\s+\w+\s+(\S+)/);
      if (mm) { _bw = _bw != null ? _bw : parseInt(mm[1]); _bc = mm[2]; }
    }
    const borderw = _bw != null ? Number(_bw) : (_bc != null ? 1 : 0);
    const bordercol = _bc != null ? colorref(_bc) : null;
    const opacity = st && st.opacity != null && st.opacity < 1 ? Math.max(0, st.opacity) : 1;
    const overflow = st && (st.overflow === 'auto' || st.overflow === 'scroll') ? 1 : 0;
    // position:absolute/fixed → out of flex flow, placed at top/left/right/bottom
    // (root-relative), stacked by zIndex. UNSET sides use the sentinel -1000000.
    const NS = -1000000;
    const abspos = st && (st.position === 'absolute' || st.position === 'fixed') ? 1 : 0;
    const atop = st && st.top != null ? Number(st.top) : NS;
    const aleft = st && st.left != null ? Number(st.left) : NS;
    const aright = st && st.right != null ? Number(st.right) : NS;
    const abottom = st && st.bottom != null ? Number(st.bottom) : NS;
    const zindex = st && st.zIndex ? Number(st.zIndex) : 0;
    return { dir, pad, gap, w, h, flex, align, justify, selfalign, mt, mb, ml, mr, fillcross, radius, shadow, borderw, bordercol, opacity, overflow, abspos, atop, aleft, aright, abottom, zindex };
  }
  // apply font + text color to a freshly created control hwnd expr
  function applyControl(hw, st, kind, scope) {
    // every control gets the common Segoe UI font (default size/weight unless
    // styled) so all controls match the web/gtk default font, not the dated
    // system GUI font.
    const sz = st && st.fontSize ? Number(st.fontSize) : 0;
    const bold = st && (st.fontWeight === 'bold' || Number(st.fontWeight) >= 600) ? 1 : 0;
    const ital = st && st.fontStyle === 'italic' ? 1 : 0;
    const und = st && st.textDecoration && /underline/.test(st.textDecoration) ? 1 : 0;
    const strk = st && st.textDecoration && /line-through/.test(st.textDecoration) ? 1 : 0;
    out.build.push(`  SendMessageA(${hw}, WM_SETFONT, (WPARAM)swiss_font5(${sz}, ${bold}, ${ital}, ${und}, ${strk}), TRUE);`);
    // text color — static, a theme token (resolved live), or a `cond ? a : b`
    const colTok = st ? tokIdx(st.color) : -1;
    let col = colTok >= 0 ? `swiss_tok(${colTok})` : (st && colorref(st.color));
    const cnd = st && st.__cond;
    if (cnd && (cnd.a.color || cnd.b.color)) {
      const cc = (x) => tokIdx(x) >= 0 ? `swiss_tok(${tokIdx(x)})` : (colorref(x) || 'RGB(0,0,0)');
      col = `(${cexpr(cnd.test, scope || {}).c} ? ${cc(cnd.a.color)} : ${cc(cnd.b.color)})`;
    }
    // a token/conditional color must re-resolve on theme flip → store & resolve in
    // the WM_CTLCOLORSTATIC handler, so register the token index when it is one.
    if (colTok >= 0 && !cnd) out.build.push(`  swiss_set_color_tok(${hw}, ${colTok + 1});`);
    else if (col) out.build.push(`  swiss_set_color(${hw}, ${col});`);
    // a Text paints opaque on its own backgroundColor, else the inherited panel
    // bg (so text on a colored View shows correctly without transparency). Token
    // panels register the token so the text bg re-themes on setTheme.
    if (kind === 'text') {
      const ownTok = st ? tokIdx(st.backgroundColor) : -1;
      const bgTokF = ownTok >= 0 ? ownTok : (scope && scope.__bgtok != null ? scope.__bgtok : -1);
      const bg = (st && !isToken(st.backgroundColor) && colorref(st.backgroundColor)) || (scope && scope.__bg);
      if (bgTokF >= 0) out.build.push(`  swiss_set_bg_tok(${hw}, ${bgTokF + 1});`);
      else if (bg) out.build.push(`  swiss_set_bg(${hw}, ${bg});`);
    }
    // reactive style={cond ? A : B}: when the test reads state cells (and the
    // control is stored in state so deps can reach it), re-apply the differing
    // color props on change and repaint just this control (no relayout → no flicker)
    if (cnd && hw.startsWith('s->') && !(scope && scope.__inrow)) {
      const rcells = cellsIn(cnd.test);
      const cc = (x) => tokIdx(x) >= 0 ? `swiss_tok(${tokIdx(x)})` : (colorref(x) || 'RGB(0,0,0)');
      const test = cexpr(cnd.test, scope || {}).c;
      const snips = [];
      if (cnd.a.color || cnd.b.color) snips.push(`swiss_restyle_color(${hw}, (${test}) ? ${cc(cnd.a.color)} : ${cc(cnd.b.color)});`);
      if (kind === 'text' && (cnd.a.backgroundColor || cnd.b.backgroundColor)) {
        const bcc = (x) => x ? cc(x) : ((scope && scope.__bg) || 'g_bgcol');
        snips.push(`swiss_restyle_bg(${hw}, (${test}) ? ${bcc(cnd.a.backgroundColor)} : ${bcc(cnd.b.backgroundColor)});`);
      }
      if (snips.length) rcells.forEach((cn) => deps[cn] && deps[cn].push(snips.join(' ')));
    }
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
      if (na.radius) out.build.push(`  ${nv}->radius = SC(${na.radius});`);
      if (na.shadow) out.build.push(`  ${nv}->shadow = 1;`);
      if (na.bordercol != null) out.build.push(`  ${nv}->hasborder = 1; ${nv}->bordercol = ${na.bordercol}; ${nv}->borderw = SC(${na.borderw || 1});`);
      if (na.opacity < 1) out.build.push(`  ${nv}->alpha = ${Math.round(na.opacity * 255)};`);
      if (na.overflow) out.build.push(`  ${nv}->overflow = 1;`);
      if (na.abspos) out.build.push(`  ${nv}->abspos = 1; ${nv}->atop = ${na.atop === -1000000 ? '-1000000' : `SC(${na.atop})`}; ${nv}->aleft = ${na.aleft === -1000000 ? '-1000000' : `SC(${na.aleft})`}; ${nv}->aright = ${na.aright === -1000000 ? '-1000000' : `SC(${na.aright})`}; ${nv}->abottom = ${na.abottom === -1000000 ? '-1000000' : `SC(${na.abottom})`}; ${nv}->zindex = ${na.zindex};`);
      if (na.mt || na.mb || na.ml || na.mr) out.build.push(`  ${nv}->mt = SC(${na.mt}); ${nv}->mb = SC(${na.mb}); ${nv}->ml = SC(${na.ml}); ${nv}->mr = SC(${na.mr});`);
      // reactive LAYOUT + APPEARANCE: style={cond?A:B} differing in size/spacing
      // (→ relayout) and/or radius/opacity/border (→ repaint just this node's rect).
      if (st && st.__cond && !scope.__inrow && cellsIn(st.__cond.test).size) {
        const A = st.__cond.a, B = st.__cond.b;
        const num = (o, k) => (o && o[k] != null) ? Number(o[k]) : null;
        const val = (o, key, sc, unset) => { const n = num(o, key); if (n == null) return String(unset); return sc ? `SC(${n})` : String(n); };
        const test = cexpr(st.__cond.test, scope).c;
        const layout = [['width', 'w', 1, -1], ['height', 'h', 1, -1], ['padding', 'pad', 1, 0], ['gap', 'gap', 1, 0],
          ['marginTop', 'mt', 1, 0], ['marginBottom', 'mb', 1, 0], ['marginLeft', 'ml', 1, 0], ['marginRight', 'mr', 1, 0], ['flex', 'flex', 0, 0]];
        const sets = []; let relayout = false;
        for (const [key, fld, sc, unset] of layout) if (num(A, key) !== num(B, key)) { sets.push([fld, `(${test}) ? ${val(A, key, sc, unset)} : ${val(B, key, sc, unset)}`]); relayout = true; }
        if (num(A, 'borderRadius') !== num(B, 'borderRadius')) sets.push(['radius', `(${test}) ? ${val(A, 'borderRadius', 1, 0)} : ${val(B, 'borderRadius', 1, 0)}`]);
        if (num(A, 'opacity') !== num(B, 'opacity')) { const al = (o) => { const n = num(o, 'opacity'); return (n == null || n >= 1) ? '255' : String(Math.round(n * 255)); }; sets.push(['alpha', `(${test}) ? ${al(A)} : ${al(B)}`]); }
        // border (explicit or `1px solid X` shorthand)
        const bcol = (o) => { if (o.borderColor) return o.borderColor; if (o.border && o.border !== 'none') { const m = String(o.border).match(/\d+px\s+\w+\s+(\S+)/); if (m) return m[1]; } return null; };
        const bwid = (o) => { if (o.borderWidth != null) return Number(o.borderWidth); if (o.border && o.border !== 'none') { const m = String(o.border).match(/(\d+)px/); if (m) return parseInt(m[1]); } return null; };
        if (bwid(A) !== bwid(B)) { const w = (o) => bwid(o) == null ? '0' : `SC(${bwid(o)})`; sets.push(['borderw', `(${test}) ? ${w(A)} : ${w(B)}`]); }
        if (bcol(A) || bcol(B)) { const bc = (x) => x ? (tokIdx(x) >= 0 ? `swiss_tok(${tokIdx(x)})` : colorref(x)) : '0'; sets.push(['bordercol', `(${test}) ? ${bc(bcol(A))} : ${bc(bcol(B))}`, 'hasborder']); }
        if (sets.length) {
          const rf = vid('rl'); stateFields.push(`  Node* ${rf};`);
          out.build.push(`  s->${rf} = ${nv};`);
          const assigns = sets.map(([fld, expr, extra]) => `s->${rf}->${fld} = ${expr};${extra ? ` s->${rf}->${extra} = 1;` : ''}`).join(' ');
          const paint = relayout ? 'swiss_relayout();' : `{ RECT _r = { s->${rf}->rx, s->${rf}->ry, s->${rf}->rx + s->${rf}->rw, s->${rf}->ry + s->${rf}->rh }; InvalidateRect(g_main, &_r, FALSE); }`;
          cellsIn(st.__cond.test).forEach((cn) => deps[cn] && deps[cn].push(assigns + ' ' + paint));
        }
      }
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
      const bgTok = st ? tokIdx(st.backgroundColor) : -1;
      const bg = bgTok >= 0 ? `swiss_tok(${bgTok})` : (st && colorref(st.backgroundColor));
      if (bgTok >= 0) out.build.push(`  ${v}->bgtok = ${bgTok + 1}; ${v}->hasbg = 1;`);
      else if (bg) out.build.push(`  ${v}->bg = ${bg}; ${v}->hasbg = 1;`);
      // propagate the effective panel background to descendants so their text
      // controls paint opaque on the right color (no transparency → no flicker)
      // token bg → children inherit that token; a FIXED (hex) bg overrides with a
      // literal so descendants don't wrongly inherit an ancestor's token behind.
      let childScope = { ...scope, __bg: bg || scope.__bg,
        __bgtok: bgTok >= 0 ? bgTok : (bg ? -1 : (scope && scope.__bgtok)) };
      if (tag === 'form' && a.onSubmit) childScope.__form = a.onSubmit;
      buildChildren(el.children, v, childScope);
      // reactive View background: style={cond?A:B} highlight (selected card/row) —
      // update the node bg on state change and repaint just its rect (no flicker).
      if (st && st.__cond && cellsIn(st.__cond.test).size && !scope.__inrow) {
        const cnd = st.__cond;
        if (cnd.a.backgroundColor || cnd.b.backgroundColor) {
          const nf = vid('vn'); stateFields.push(`  Node* ${nf};`);
          out.build.push(`  s->${nf} = ${v};`);
          const cc = (x) => tokIdx(x) >= 0 ? `swiss_tok(${tokIdx(x)})` : (colorref(x) || 'g_bgcol');
          const snip = `swiss_restyle_node(s->${nf}, (${cexpr(cnd.test, scope).c}) ? ${cc(cnd.a.backgroundColor)} : ${cc(cnd.b.backgroundColor)});`;
          cellsIn(cnd.test).forEach((cn) => deps[cn] && deps[cn].push(snip));
        }
      }
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
      // owner-draw a Text when it needs a pill background, letterSpacing or
      // lineHeight — a native STATIC can't do any of those.
      const pillBg = st && colorref(st.backgroundColor);
      const spacing = st && st.letterSpacing ? Number(st.letterSpacing) : 0;
      const lineh = st && st.lineHeight ? Math.round(Number(st.lineHeight) * 100) : 0;
      const ownerDraw = pillBg || spacing || lineh;
      const pillAlign = st && st.textAlign === 'center' ? 1 : st && st.textAlign === 'right' ? 2 : 0;
      const pillFg = (st && colorref(st.color)) || (pillBg ? 'RGB(255,255,255)' : 'g_fgcol');
      const sstyle = ownerDraw ? 'SS_OWNERDRAW | SS_NOTIFY' : ssAlign;
      const regPill = (hw) => { if (ownerDraw) out.build.push(`  swiss_pill_style(${hw}, ${pillBg || '0'}, ${pillBg ? 1 : 0}, ${pillFg}, ${(scope && scope.__bg) || 'g_bgcol'}, SC(${na.radius || 6}), ${pillAlign}, SC(${spacing}), ${lineh});`); };
      if (info.dynamic) {
        if (scope.__inrow) {
          const hw = ctl('"STATIC"', sstyle, 'NULL', 'text');
          out.build.push(`  ${textSnippet(el, scope, hw).snippet}`);
          applyControl(hw, st, 'text', scope); regPill(hw); const n = vid('n');
          out.build.push(`  Node* ${n} = ${mkNode(hw)};`); selfStep(n); pack(n); return n;
        }
        const f = vid('lbl'); stateFields.push(`  HWND ${f};`);
        out.build.push(`  s->${f} = CreateWindowExA(0, "STATIC", NULL, WS_CHILD | WS_VISIBLE | ${sstyle}, 0, 0, 0, 0, g_main, NULL, g_hinst, NULL);`);
        const real = textSnippet(el, scope, `s->${f}`);
        out.build.push(`  ${real.snippet}`);
        info.reads.forEach((cn) => deps[cn].push(real.snippet));
        applyControl(`s->${f}`, st, 'text', scope); regPill(`s->${f}`);
        const n = vid('n'); out.build.push(`  Node* ${n} = ${mkNode(`s->${f}`)};`); selfStep(n); pack(n); return n;
      }
      const stx = st && st.textTransform === 'uppercase' ? info.staticText.toUpperCase() : st && st.textTransform === 'lowercase' ? info.staticText.toLowerCase() : info.staticText;
      // static text but a reactive style={cond?A:B} → store the control in state so
      // the restyle deps (which run in swiss_update_*) can reach it.
      const reactiveStyle = st && st.__cond && cellsIn(st.__cond.test).size && !scope.__inrow;
      if (reactiveStyle) {
        const f = vid('lbl'); stateFields.push(`  HWND ${f};`);
        out.build.push(`  s->${f} = CreateWindowExA(0, "STATIC", ${cstr(stx)}, WS_CHILD | WS_VISIBLE | ${sstyle}, 0, 0, 0, 0, g_main, NULL, g_hinst, NULL);`);
        applyControl(`s->${f}`, st, 'text', scope); regPill(`s->${f}`);
        const n = vid('n'); out.build.push(`  Node* ${n} = ${mkNode(`s->${f}`)};`); selfStep(n); pack(n); return n;
      }
      const hw = ctl('"STATIC"', sstyle, cstr(stx), 'text');
      applyControl(hw, st, 'text', scope); regPill(hw);
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
      // a reactive style={cond?A:B} button is stored in state so its restyle dep
      // (which runs in swiss_update_*) can reach it.
      const btnReactive = st && st.__cond && cellsIn(st.__cond.test).size && !scope.__inrow;
      let hw, hwDecl;
      if (btnReactive) { const f = vid('btn'); stateFields.push(`  HWND ${f};`); hw = `s->${f}`; hwDecl = ''; }
      else { hw = vid('w'); hwDecl = 'HWND '; }
      // every button is owner-drawn (GDI+ AA rounded) for a consistent flat,
      // modern look — colored from backgroundColor/color, or a light surface +
      // border when plain. (No BS_DEFPUSHBUTTON: owner-draw can't be the default.)
      const bgTk = tokIdx(st && st.backgroundColor), fgTk = tokIdx(st && st.color);
      const bgCol = bgTk >= 0 ? '0' : colorref(st && st.backgroundColor), fgCol = fgTk >= 0 ? '0' : colorref(st && st.color);
      const behTk = (scope && scope.__bgtok != null) ? scope.__bgtok : -1;
      const behind = behTk >= 0 ? '0' : ((scope && scope.__bg) || 'g_bgcol');
      out.build.push(`  ${hwDecl}${hw} = CreateWindowExA(0, "BUTTON", ${cstr(label)}, WS_CHILD | WS_VISIBLE | BS_OWNERDRAW | WS_TABSTOP, 0, 0, 0, 0, g_main, (HMENU)(INT_PTR)${id}, g_hinst, NULL);`);
      out.build.push(`  swiss_btn_style(${hw}, ${bgCol || '0'}, ${(bgCol || bgTk >= 0) ? 1 : 0}, ${fgCol || '0'}, ${(fgCol || fgTk >= 0) ? 1 : 0}, SC(${na.radius || 6}), ${behind}, ${bgTk + 1}, ${fgTk + 1}, ${behTk + 1});`);
      // reactive button background: animate on the cell change (via swiss_restyle_btn)
      if (btnReactive) { const cnd = st.__cond;
        if (cnd.a.backgroundColor || cnd.b.backgroundColor) {
          const cc = (x) => tokIdx(x) >= 0 ? `swiss_tok(${tokIdx(x)})` : (colorref(x) || 'RGB(0,0,0)');
          const snip = `swiss_restyle_btn(${hw}, (${cexpr(cnd.test, scope).c}) ? ${cc(cnd.a.backgroundColor)} : ${cc(cnd.b.backgroundColor)});`;
          cellsIn(cnd.test).forEach((cn) => deps[cn] && deps[cn].push(snip));
        }
      }
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
      // borderless EDIT — a soft rounded border is GDI+-drawn around it (frame)
      out.build.push(`  s->${f} = CreateWindowExA(0, "EDIT", NULL, WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL, 0, 0, 0, 0, g_main, (HMENU)(INT_PTR)${id}, g_hinst, NULL);`);
      out.build.push(`  SendMessageA(s->${f}, EM_SETMARGINS, EC_LEFTMARGIN | EC_RIGHTMARGIN, MAKELONG(SC(${st && st.padding != null ? Number(st.padding) : 6}), SC(${st && st.padding != null ? Number(st.padding) : 6})));`);
      const ph = strAttr(a.placeholder);
      if (ph) out.build.push(`  SendMessageW(s->${f}, EM_SETCUEBANNER, TRUE, (LPARAM)L${cwstr(ph)});`);
      if (cell) {
        out.build.push(`  SetWindowTextA(s->${f}, ${cell.t === 'string' ? `s->${cell.name}` : '""'});`);
        deps[cell.name].push(`{ char* _t = swiss_gettext(s->${f}); if (strcmp(_t, s->${cell.name}) != 0) SetWindowTextA(s->${f}, s->${cell.name}); free(_t); }`);
      }
      applyControl(`s->${f}`, st, 'edit', scope);
      const nh = leafH(24);   // width auto (-1) → fills a stretch parent; height from padding+font
      const n = vid('n'); out.build.push(`  Node* ${n} = swiss_leaf(s->${f}, ${na.w}, ${nh}, ${na.flex});`);
      out.build.push(`  ${n}->frame = 1; ${n}->framecol = ${colorref(st && st.borderColor) || 'RGB(204, 204, 204)'}; ${n}->radius = SC(${na.radius || 4});`);
      selfStep(n); pack(n); return n;
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
      out.build.push(`  s->${f} = CreateWindowExA(0, "EDIT", NULL, WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | ES_MULTILINE | ES_AUTOVSCROLL | WS_VSCROLL, 0, 0, 0, 0, g_main, (HMENU)(INT_PTR)${id}, g_hinst, NULL);`);
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
      // owner-drawn checkbox (rounded box + GDI+ check) instead of the native one
      out.build.push(`  s->${f} = CreateWindowExA(0, "BUTTON", ${cstr(strAttr(a.label))}, WS_CHILD | WS_VISIBLE | BS_OWNERDRAW | WS_TABSTOP, 0, 0, 0, 0, g_main, (HMENU)(INT_PTR)${id}, g_hinst, NULL);`);
      out.build.push(`  swiss_check_style(s->${f}, ${(scope && scope.__bg) || 'g_bgcol'}, ${(st && colorref(st.color)) || 'g_fgcol'});`);
      if (cell) {
        out.build.push(`  swiss_check_set(s->${f}, s->${cell.name});`);
        deps[cell.name].push(`swiss_check_set(s->${f}, s->${cell.name});`);
      }
      applyControl(`s->${f}`, st, 'text', scope);
      const n = vid('n'); out.build.push(`  Node* ${n} = swiss_leaf(s->${f}, ${na.w}, ${na.h < 0 ? 22 : na.h}, ${na.flex});`); selfStep(n); pack(n); return n;
    }
    if (name === 'Select') {
      const f = vid('cmb'); stateFields.push(`  HWND ${f};`);
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      const id = a.onChange ? command(emitHandler(a.onChange, scope, 'combo'), 'CBN_SELCHANGE') : 0;
      out.build.push(`  s->${f} = CreateWindowExA(0, "COMBOBOX", NULL, WS_CHILD | WS_VISIBLE | WS_TABSTOP | CBS_DROPDOWNLIST | CBS_OWNERDRAWFIXED | CBS_HASSTRINGS | WS_VSCROLL, 0, 0, 0, 0, g_main, (HMENU)(INT_PTR)${id}, g_hinst, NULL);`);
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
      out.build.push(`  s->${f} = CreateWindowExA(0, TRACKBAR_CLASS, NULL, WS_CHILD | WS_VISIBLE | WS_TABSTOP | TBS_HORZ | TBS_NOTICKS, 0, 0, 0, 0, g_main, NULL, g_hinst, NULL);`);
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
      out.build.push(`  s->${f} = CreateWindowExA(0, PROGRESS_CLASS, NULL, WS_CHILD | WS_VISIBLE | PBS_SMOOTH, 0, 0, 0, 0, g_main, NULL, g_hinst, NULL);`);
      // flat accent fill: drop the v6 theme so the custom bar/bg colors apply
      out.build.push(`  SetWindowTheme(s->${f}, L"", L""); SendMessageA(s->${f}, PBM_SETBARCOLOR, 0, RGB(0, 102, 204)); SendMessageA(s->${f}, PBM_SETBKCOLOR, 0, RGB(225, 228, 232));`);
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
      out.lists.push({ box, rowFn, rebuildFn, itemFn, idxName, countCell, bg: st && colorref(st.backgroundColor) || scope.__bg, bgtok: (st && tokIdx(st.backgroundColor) >= 0) ? tokIdx(st.backgroundColor) : scope.__bgtok });
      if (countCell) deps[countCell.name].push(`${rebuildFn}(s);`);
      pack(`s->${box}`); return `s->${box}`;
    }
    err(`unsupported component <${name}>`, el);
  }
  const planDynVisible = true;

  // ── children loop (cellsIn / jsxOf come from the core) ──
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
    out.lists.push({ kind: 'map', box, rowFn: `swiss_map_${out.lists.length}`, rebuildFn: `swiss_maprebuild_${out.lists.length}`, itemJSX, itName, idxParam, cell, filterArrow, bg: scope.__bg, bgtok: scope.__bgtok });
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
      if (L.bgtok != null && L.bgtok >= 0) rowScope.__bgtok = L.bgtok;   // …and its theme token so row text re-themes
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
  const rootVar = build(rootJSX(), null, {});
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
#include <uxtheme.h>
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

// ── GDI+ flat API (subset, declared by hand for C) — antialiased fills so
// controls get smooth rounded corners / soft borders instead of the hard,
// aliased look of GDI + region clipping ──
typedef int GpStatus; typedef void GpGraphics; typedef void GpPath; typedef void GpBrush; typedef void GpPen; typedef DWORD ARGB;
typedef struct { UINT32 v; void* cb; BOOL bg; BOOL ext; } GdiplusStartupInput;
GpStatus WINAPI GdiplusStartup(ULONG_PTR*, const GdiplusStartupInput*, void*);
void WINAPI GdiplusShutdown(ULONG_PTR);
GpStatus WINAPI GdipCreateFromHDC(HDC, GpGraphics**);
GpStatus WINAPI GdipDeleteGraphics(GpGraphics*);
GpStatus WINAPI GdipSetSmoothingMode(GpGraphics*, int);
GpStatus WINAPI GdipCreatePath(int, GpPath**);
GpStatus WINAPI GdipDeletePath(GpPath*);
GpStatus WINAPI GdipAddPathArc(GpPath*, float, float, float, float, float, float);
GpStatus WINAPI GdipAddPathRectangle(GpPath*, float, float, float, float);
GpStatus WINAPI GdipClosePathFigure(GpPath*);
GpStatus WINAPI GdipCreateSolidFill(ARGB, GpBrush**);
GpStatus WINAPI GdipDeleteBrush(GpBrush*);
GpStatus WINAPI GdipFillPath(GpGraphics*, GpBrush*, GpPath*);
GpStatus WINAPI GdipCreatePen1(ARGB, float, int, GpPen**);
GpStatus WINAPI GdipDeletePen(GpPen*);
GpStatus WINAPI GdipDrawPath(GpGraphics*, GpPen*, GpPath*);
GpStatus WINAPI GdipDrawLine(GpGraphics*, GpPen*, float, float, float, float);
#define C2A(c) (0xFF000000u | (GetRValue(c) << 16) | (GetGValue(c) << 8) | GetBValue(c))
// rounded-rect path (or plain rect if r<=0)
static void swiss_round_path(GpPath* p, float x, float y, float w, float h, float r) {
  if (r <= 0) { GdipAddPathRectangle(p, x, y, w, h); return; }
  float d = r * 2;
  GdipAddPathArc(p, x, y, d, d, 180, 90);
  GdipAddPathArc(p, x + w - d, y, d, d, 270, 90);
  GdipAddPathArc(p, x + w - d, y + h - d, d, d, 0, 90);
  GdipAddPathArc(p, x, y + h - d, d, d, 90, 90);
  GdipClosePathFigure(p);
}
// antialiased rounded fill (+ optional border) on an HDC rect
static void swiss_fill_round(HDC hdc, RECT rc, int r, ARGB fill, ARGB border, float bw) {
  GpGraphics* g = NULL; if (GdipCreateFromHDC(hdc, &g) != 0 || !g) return;
  GdipSetSmoothingMode(g, 4 /* AntiAlias */);
  GpPath* p = NULL; GdipCreatePath(0, &p);
  swiss_round_path(p, (float)rc.left + 0.5f, (float)rc.top + 0.5f, (float)(rc.right - rc.left) - 1, (float)(rc.bottom - rc.top) - 1, (float)r);
  GpBrush* b = NULL; GdipCreateSolidFill(fill, &b); GdipFillPath(g, b, p); GdipDeleteBrush(b);
  if (bw > 0) { GpPen* pen = NULL; GdipCreatePen1(border, bw, 2 /* UnitPixel */, &pen); if (pen) { GdipDrawPath(g, pen, p); GdipDeletePen(pen); } }
  GdipDeletePath(p); GdipDeleteGraphics(g);
}
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
  int frame; COLORREF framecol;   // draw a soft rounded border around this control (inputs)
  int shadow;                // boxShadow → a soft drop shadow behind the panel
  int borderw; COLORREF bordercol; int hasborder;   // CSS border on a View (width/color)
  int alpha;                 // opacity → 0..255 alpha for the painted background (255 = opaque)
  int overflow, scrolly, contenth;   // overflow:auto/scroll → vertical scroll offset + content height
  COLORREF bg; int hasbg, visible;
  int bgtok;                 // theme token+1 for the background (0 = use bg literal) — resolved at paint
  int abspos, atop, aleft, aright, abottom, zindex;   // position:absolute (root-relative) + z-order
} Node;

static HINSTANCE g_hinst;
static HWND g_main;
static Node* g_root;
static double g_scale = 1.0;            // HiDPI factor (dpi/96) — crisp + correct size
#define SC(x) ((int)((x) * g_scale))    // scale a logical px value to physical
static int swiss_is_btn(HWND);          // (defined below; used by the layout)
static int swiss_is_pill(HWND);
static void swiss_pill_metrics(HWND, int*, int*);   // (spacing, lineh) for measuring owner-draw text
static COLORREF swiss_tok(int);                     // theme token → current-theme color (defined below)

static Node* swiss_node_new(void) { Node* n = (Node*)calloc(1, sizeof(Node)); n->w = n->h = -1; n->visible = 1; return n; }
static Node* swiss_view(int dir, int pad, int gap, int flex, int w, int h, int justify, int align) {
  Node* n = swiss_node_new(); n->dir = dir; n->pad = SC(pad); n->gap = SC(gap); n->flex = flex;
  n->w = w < 0 ? w : SC(w); n->h = h < 0 ? h : SC(h); n->justify = justify; n->align = align; return n;
}
static Node* swiss_leaf(HWND hwnd, int w, int h, int flex) {
  Node* n = swiss_node_new(); n->hwnd = hwnd; n->w = w < 0 ? w : SC(w); n->h = h < 0 ? h : SC(h); n->flex = flex; return n;
}
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
    if (isstat) {   // owner-draw text: letterSpacing widens, lineHeight heightens
      int sp = 0, lh = 0; swiss_pill_metrics(n->hwnd, &sp, &lh);
      if (sp) tw += len * sp;
      if (lh > 0) {
        int lines = 1; for (int j = 0; j < len; j++) if (buf[j] == '\\n') lines++;
        if (n->w > 0 && sz.cx > n->w) { int wl = (sz.cx + n->w - 1) / n->w; if (wl > lines) lines = wl; }  // wrapped lines
        th = th * lh / 100 * lines;
      }
    }
  }
  *mw = (n->w >= 0) ? n->w : (isbtn ? tw + 28 : isstat ? tw + 2 : 160);
  *mh = (n->h >= 0) ? n->h : (isbtn ? th + 12 : th);
}

static void swiss_measure(Node* n, int* mw, int* mh) {
  if (n->hwnd) { swiss_measure_leaf(n, mw, mh); return; }
  int main = 0, cross = 0, vis = 0;
  for (int i = 0; i < n->nkids; i++) {
    Node* k = n->kids[i]; if (!k->visible || k->abspos) continue;
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

// overflow:auto — while laying out an overflow subtree this holds the viewport
// rect (client coords); leaves inside are window-region-clipped to it so scrolled
// content stays within the box.
static RECT g_clip; static int g_clipping;
static void swiss_arrange(Node* n, int x, int y, int w, int h) {
  int moved = (n->rx != x || n->ry != y || n->rw != w || n->rh != h);  // skip no-op moves (less flicker)
  n->rx = x; n->ry = y; n->rw = w; n->rh = h;   // remember rect for bg painting
  if (n->hwnd) {
    if (moved) {
      if (n->frame) {
        // EM_SETRECT is ignored by single-line edits, so to vertically centre the
        // text/placeholder (like GTK) size the EDIT to a text-height strip and
        // centre that strip inside the framed box; its single line then sits mid-box.
        int in = SC(3);
        HDC dc = GetDC(n->hwnd); HFONT fo = (HFONT)SendMessageA(n->hwnd, WM_GETFONT, 0, 0);
        HGDIOBJ oo = fo ? SelectObject(dc, fo) : NULL; TEXTMETRICA tm; GetTextMetricsA(dc, &tm);
        if (oo) SelectObject(dc, oo); ReleaseDC(n->hwnd, dc);
        int ih = tm.tmHeight + SC(4); int maxh = h - 2 * in; if (ih > maxh) ih = maxh;
        MoveWindow(n->hwnd, x + in, y + (h - ih) / 2, w - 2 * in, ih, TRUE);
      } else {
        MoveWindow(n->hwnd, x, y, w, h, TRUE);
        // borderRadius → clip the control to a rounded rect. Owner-drawn buttons
        // and pills skip this — corners come from the GDI+ drawing.
        if (n->radius > 0 && !swiss_is_btn(n->hwnd) && !swiss_is_pill(n->hwnd))
          SetWindowRgn(n->hwnd, CreateRoundRectRgn(0, 0, w + 1, h + 1, n->radius * 2, n->radius * 2), TRUE);
        // inside an overflow subtree: clip this leaf to the scroll viewport
        else if (g_clipping) {
          RECT lr = { x, y, x + w, y + h }, is;
          if (IntersectRect(&is, &lr, &g_clip))
            SetWindowRgn(n->hwnd, CreateRectRgn(is.left - x, is.top - y, is.right - x, is.bottom - y), TRUE);
          else SetWindowRgn(n->hwnd, CreateRectRgn(0, 0, 0, 0), TRUE);
        } else if (!n->radius) SetWindowRgn(n->hwnd, NULL, TRUE);   // clear any stale clip when scrolled back into view
      }
    }
    return;
  }
  int ix = x + n->pad, iy = y + n->pad, iw = w - 2 * n->pad, ih = h - 2 * n->pad;
  int avail = n->dir ? iw : ih;
  int used = 0, vis = 0, totflex = 0;
  for (int i = 0; i < n->nkids; i++) {
    Node* k = n->kids[i]; if (!k->visible || k->abspos) continue;
    int cw, ch; swiss_measure(k, &cw, &ch);
    used += (n->dir ? cw : ch) + (n->dir ? k->ml + k->mr : k->mt + k->mb);  // + main-axis margins
    vis++; totflex += k->flex;
  }
  if (vis > 1) used += n->gap * (vis - 1);
  int extra = avail - used; if (extra < 0) extra = 0;
  // overflow:auto (vertical): clamp the scroll offset to the content, shift the
  // content up by it, and clip children to the viewport during this subtree.
  int scroff = 0;
  RECT clipSave = g_clip; int clippingSave = g_clipping;
  if (n->overflow && !n->dir) {
    n->contenth = used;
    int maxs = used - avail; if (maxs < 0) maxs = 0;
    if (n->scrolly > maxs) n->scrolly = maxs; if (n->scrolly < 0) n->scrolly = 0;
    scroff = n->scrolly;
    if (used > avail) iw -= SC(8);   // reserve a scrollbar gutter so children clear the thumb
    RECT vp = { x, y, x + w, y + h };
    if (g_clipping) IntersectRect(&g_clip, &clipSave, &vp); else g_clip = vp;
    g_clipping = 1;
  }
  int cursor = n->dir ? ix : (iy - scroff);
  if (!totflex) { if (n->justify == 1) cursor += extra / 2; else if (n->justify == 2) cursor += extra; }
  for (int i = 0; i < n->nkids; i++) {
    Node* c = n->kids[i]; if (!c->visible || c->abspos) continue;
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
  if (n->overflow && !n->dir) { g_clip = clipSave; g_clipping = clippingSave; }
}

// innermost overflow node whose laid-out rect contains a client point (wheel)
static Node* swiss_scroll_hit(Node* n, int px, int py) {
  for (int i = n->nkids - 1; i >= 0; i--) if (n->kids[i]->visible) {
    Node* r = swiss_scroll_hit(n->kids[i], px, py); if (r) return r;
  }
  if (n->overflow && px >= n->rx && px < n->rx + n->rw && py >= n->ry && py < n->ry + n->rh) return n;
  return NULL;
}
// ── position:absolute (root-relative) + z-order ──
static Node* g_absnodes[64]; static int g_nabs;
static void swiss_collect_abs(Node* n) {
  for (int i = 0; i < n->nkids; i++) { Node* c = n->kids[i]; if (!c->visible) continue;
    if (c->abspos && g_nabs < 64) g_absnodes[g_nabs++] = c; swiss_collect_abs(c); }
}
static void swiss_arrange_abs(Node* n, int W, int H) {
  for (int i = 0; i < n->nkids; i++) {
    Node* c = n->kids[i]; if (!c->visible) continue;
    if (c->abspos) {
      int mw, mh; swiss_measure(c, &mw, &mh);
      int NS = -1000000, w = mw, h = mh, x = 0, y = 0;
      if (c->aleft != NS && c->aright != NS) { x = c->aleft; w = W - c->aleft - c->aright; }
      else if (c->aleft != NS) x = c->aleft;
      else if (c->aright != NS) x = W - c->aright - w;
      if (c->atop != NS && c->abottom != NS) { y = c->atop; h = H - c->atop - c->abottom; }
      else if (c->atop != NS) y = c->atop;
      else if (c->abottom != NS) y = H - c->abottom - h;
      if (c->w >= 0) w = c->w; if (c->h >= 0) h = c->h;
      swiss_arrange(c, x, y, w, h);
    }
    swiss_arrange_abs(c, W, H);
  }
}
static void swiss_raise_subtree(Node* n) {
  if (n->hwnd) SetWindowPos(n->hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  for (int i = 0; i < n->nkids; i++) swiss_raise_subtree(n->kids[i]);
}
static void swiss_zorder_abs(void) {   // raise absolute subtrees, lowest zIndex first (highest ends on top)
  for (int i = 1; i < g_nabs; i++) { Node* k = g_absnodes[i]; int j = i - 1;
    while (j >= 0 && g_absnodes[j]->zindex > k->zindex) { g_absnodes[j + 1] = g_absnodes[j]; j--; } g_absnodes[j + 1] = k; }
  for (int i = 0; i < g_nabs; i++) swiss_raise_subtree(g_absnodes[i]);
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
  swiss_arrange_abs(g_root, W, H);   // position:absolute nodes (root-relative), out of flow
  g_nabs = 0; swiss_collect_abs(g_root); swiss_zorder_abs();   // stack absolute subtrees by zIndex
  // repaint backgrounds (WM_PAINT double-buffers; erase suppressed) so vacated
  // areas clear without the full-white-flash flicker of an erasing invalidate
  InvalidateRect(g_main, NULL, FALSE);
}

// ── font cache (size 0 = default UI size) ──
// face chosen at startup: DejaVu Sans if present (Linux/wine → matches the GTK
// target) else Segoe UI (native Windows, what GTK would also use there)
static const char* g_fontface = ${JSON.stringify(opts.font || 'Segoe UI')};
static int CALLBACK swiss_fontprobe(const LOGFONTA* lf, const TEXTMETRICA* tm, DWORD ty, LPARAM lp) { (void)lf; (void)tm; (void)ty; *(int*)lp = 1; return 0; }
${opts.font ? `static void swiss_pick_font(void) {
  // a fixed font was requested in swiss.json ("font"): keep g_fontface as-is and
  // register any bundled .ttf shipped next to the exe under fonts/ so the family
  // is available even if it isn't installed on this machine.
  char p[MAX_PATH]; DWORD n = GetModuleFileNameA(NULL, p, MAX_PATH);
  if (n > 0 && n < MAX_PATH) { char* s = strrchr(p, '\\\\'); if (s) { s[1] = 0;
    char f[MAX_PATH];
    snprintf(f, sizeof f, "%sfonts\\\\DejaVuSans.ttf", p);      AddFontResourceExA(f, FR_PRIVATE, 0);
    snprintf(f, sizeof f, "%sfonts\\\\DejaVuSans-Bold.ttf", p); AddFontResourceExA(f, FR_PRIVATE, 0);
  } }
}` : `static void swiss_pick_font(void) {
  // real Windows → Segoe UI (modern native). wine/Linux → DejaVu Sans if present
  // (matches the GTK target there). Detect wine via ntdll's wine_get_version.
  HMODULE nt = GetModuleHandleA("ntdll.dll");
  int is_wine = nt && GetProcAddress(nt, "wine_get_version") != NULL;
  HDC dc = GetDC(NULL); int found = 0;
  if (is_wine) {   // Linux/wine: match the GTK target's DejaVu
    EnumFontFamiliesA(dc, "DejaVu Sans", swiss_fontprobe, (LPARAM)&found);
    if (found) g_fontface = "DejaVu Sans";
  } else {         // Windows: prefer the modern Win11 UI font, else classic Segoe UI
    EnumFontFamiliesA(dc, "Segoe UI Variable Text", swiss_fontprobe, (LPARAM)&found);
    if (found) g_fontface = "Segoe UI Variable Text";
  }
  ReleaseDC(NULL, dc);
}`}
static struct { int px, bold, ital, und, strk; HFONT f; } g_fonts[128]; static int g_nfonts;
static HFONT swiss_font5(int px, int bold, int ital, int und, int strk) {
  for (int i = 0; i < g_nfonts; i++)
    if (g_fonts[i].px == px && g_fonts[i].bold == bold && g_fonts[i].ital == ital && g_fonts[i].und == und && g_fonts[i].strk == strk) return g_fonts[i].f;
  int h = px ? -MulDiv(SC(px), 96, 72) : -SC(15);   // scale font for HiDPI
  HFONT f = CreateFontA(h, 0, 0, 0, bold ? FW_BOLD : FW_NORMAL, ital, und, strk, DEFAULT_CHARSET,
    OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, g_fontface);
  if (g_nfonts < 128) { g_fonts[g_nfonts].px = px; g_fonts[g_nfonts].bold = bold; g_fonts[g_nfonts].ital = ital; g_fonts[g_nfonts].und = und; g_fonts[g_nfonts].strk = strk; g_fonts[g_nfonts].f = f; g_nfonts++; }
  return f;
}
static HFONT swiss_font(int px, int bold) { return swiss_font5(px, bold, 0, 0, 0); }

// ── per-control text color (applied via WM_CTLCOLORSTATIC) ──
static struct { HWND w; COLORREF c; int tok; } g_colors[128]; static int g_ncolors;   // tok = token+1 (0 = literal c)
static void swiss_set_color(HWND w, COLORREF c) { if (g_ncolors < 128) { g_colors[g_ncolors].w = w; g_colors[g_ncolors].c = c; g_colors[g_ncolors].tok = 0; g_ncolors++; } }
static void swiss_set_color_tok(HWND w, int tok) { if (g_ncolors < 128) { g_colors[g_ncolors].w = w; g_colors[g_ncolors].tok = tok; g_ncolors++; } }
static int swiss_get_color(HWND w, COLORREF* out) { for (int i = 0; i < g_ncolors; i++) if (g_colors[i].w == w) { *out = g_colors[i].tok ? swiss_tok(g_colors[i].tok - 1) : g_colors[i].c; return 1; } return 0; }

// ── per-control background color (e.g. a colored Text/badge) ──
static struct { HWND w; COLORREF c; HBRUSH b; int tok; } g_bgs[64]; static int g_nbgs;   // tok = token+1 (0 = literal)
static void swiss_set_bg(HWND w, COLORREF c) { if (g_nbgs < 64) { g_bgs[g_nbgs].w = w; g_bgs[g_nbgs].c = c; g_bgs[g_nbgs].b = CreateSolidBrush(c); g_bgs[g_nbgs].tok = 0; g_nbgs++; } }
static void swiss_set_bg_tok(HWND w, int tok) { if (g_nbgs < 64) { COLORREF c = swiss_tok(tok - 1); g_bgs[g_nbgs].w = w; g_bgs[g_nbgs].c = c; g_bgs[g_nbgs].b = CreateSolidBrush(c); g_bgs[g_nbgs].tok = tok; g_nbgs++; } }
static int swiss_get_bg(HWND w, COLORREF* c, HBRUSH* b) {
  for (int i = 0; i < g_nbgs; i++) if (g_bgs[i].w == w) {
    if (g_bgs[i].tok) { COLORREF cur = swiss_tok(g_bgs[i].tok - 1); if (cur != g_bgs[i].c) { if (g_bgs[i].b) DeleteObject(g_bgs[i].b); g_bgs[i].b = CreateSolidBrush(cur); g_bgs[i].c = cur; } }   // re-theme
    *c = g_bgs[i].c; *b = g_bgs[i].b; return 1;
  }
  return 0;
}
// ── reactive restyle (+ smooth transition): a style={cond?A:B} whose test reads
// state re-applies its color props when the cell changes, animating old→new over
// ~160ms via a timer and repainting ONLY that control (no relayout, no flicker).
#define SWISS_ANIM_MS 160
static COLORREF swiss_lerp(COLORREF a, COLORREF b, int pct) {
  return RGB(GetRValue(a) + (GetRValue(b) - GetRValue(a)) * pct / 100,
             GetGValue(a) + (GetGValue(b) - GetGValue(a)) * pct / 100,
             GetBValue(a) + (GetBValue(b) - GetBValue(a)) * pct / 100);
}
static void swiss_apply_c(HWND w, int kind, COLORREF c);   // fwd (g_btns defined later)
static struct { HWND w; COLORREF from, to; DWORD start; int kind, active; } g_anim[64]; static int g_nanim;
static COLORREF swiss_cur_c(HWND w, int kind);   // fwd
static void swiss_anim(HWND w, int kind, COLORREF to) {
  COLORREF from = swiss_cur_c(w, kind);
  if (from == to) return;
  int i; for (i = 0; i < g_nanim; i++) if (g_anim[i].w == w && g_anim[i].kind == kind) break;
  if (i == g_nanim) { if (g_nanim >= 64) { swiss_apply_c(w, kind, to); InvalidateRect(w, NULL, FALSE); return; } g_nanim++; }
  g_anim[i].w = w; g_anim[i].from = from; g_anim[i].to = to; g_anim[i].start = GetTickCount(); g_anim[i].kind = kind; g_anim[i].active = 1;
  SetTimer(g_main, 0x5A11, 15, NULL);
}
static void swiss_anim_tick(void) {
  DWORD now = GetTickCount(); int any = 0;
  for (int i = 0; i < g_nanim; i++) if (g_anim[i].active) {
    int pct = (int)((now - g_anim[i].start) * 100 / SWISS_ANIM_MS);
    if (pct >= 100) { pct = 100; g_anim[i].active = 0; } else any = 1;
    swiss_apply_c(g_anim[i].w, g_anim[i].kind, swiss_lerp(g_anim[i].from, g_anim[i].to, pct));
    if (g_anim[i].kind != 3) InvalidateRect(g_anim[i].w, NULL, FALSE);   // kind 3 (node) invalidates its rect in apply_c
  }
  if (!any) { KillTimer(g_main, 0x5A11); g_nanim = 0; }
}
static void swiss_restyle_color(HWND w, COLORREF c) { swiss_anim(w, 0, c); }
static void swiss_restyle_bg(HWND w, COLORREF c) { swiss_anim(w, 1, c); }

static HBRUSH g_white;   // themeable window/control background brush
static COLORREF g_bgcol = RGB(255, 255, 255), g_fgcol = RGB(26, 26, 26);   // light default
static int g_darktheme;
// semantic theme tokens: [light, dark]; swiss_tok() resolves for the current theme
// so token colors flip live when swiss_set_theme() redraws.
static const COLORREF g_swiss_tok[][2] = {
${tokTableC()}
};
static COLORREF swiss_tok(int i) { return g_swiss_tok[i][g_darktheme]; }

// paint View backgroundColor rects (containers have no HWND) — parents first,
// so a child's bg draws over its parent's; controls then paint over the top.
// soft drop shadow: layered translucent rounded rects offset down (fake blur)
static void swiss_shadow(HDC hdc, RECT r, int radius) {
  int sp = SC(2);
  for (int i = SC(6); i >= 1; i--) {
    RECT s = { r.left - i + sp, r.top - i + sp + SC(2), r.right + i + sp, r.bottom + i + sp + SC(2) };
    swiss_fill_round(hdc, s, radius + i, 0x14000000u, 0, 0);   // ~8% black per layer
  }
}
static void swiss_paint_bg(Node* n, HDC hdc) {
  if (n->hasbg || n->hasborder) {
    RECT r = { n->rx, n->ry, n->rx + n->rw, n->ry + n->rh };
    if (n->shadow) swiss_shadow(hdc, r, n->radius);            // drop shadow behind the panel
    int a = n->alpha ? n->alpha : 255;                          // opacity (0 = unset = opaque)
    COLORREF nbg = n->bgtok ? swiss_tok(n->bgtok - 1) : n->bg;  // theme token resolves per current theme
    if (n->hasbg && n->radius == 0 && a == 255 && !n->hasborder) {
      HBRUSH b = CreateSolidBrush(nbg); FillRect(hdc, &r, b); DeleteObject(b);   // fast opaque path
    } else {
      ARGB fill = n->hasbg ? (((ARGB)a << 24) | (C2A(nbg) & 0xFFFFFFu)) : 0;      // alpha 0 = no fill (border only)
      ARGB bord = n->hasborder ? (((ARGB)a << 24) | (C2A(n->bordercol) & 0xFFFFFFu)) : 0;
      swiss_fill_round(hdc, r, n->radius, fill, bord, n->hasborder ? (float)n->borderw : 0.0f);
    }
  }
  // overflow scrollbar thumb (rounded gray, in the reserved right gutter)
  if (n->overflow && n->contenth > n->rh && n->rh > 0) {
    int sbw = SC(6), sbx = n->rx + n->rw - sbw - SC(2);
    int th = (int)((long long)n->rh * n->rh / n->contenth); if (th < SC(24)) th = SC(24); if (th > n->rh) th = n->rh;
    int maxs = n->contenth - n->rh;
    int ty = n->ry + (maxs > 0 ? (n->rh - th) * n->scrolly / maxs : 0);
    RECT tr = { sbx, ty, sbx + sbw, ty + th };
    swiss_fill_round(hdc, tr, sbw / 2, C2A(RGB(193, 197, 203)), 0, 0);
  }
  for (int i = 0; i < n->nkids; i++) if (n->kids[i]->visible && !n->kids[i]->abspos) swiss_paint_bg(n->kids[i], hdc);
}
// soft rounded border around inputs (drawn behind the inset EDIT), accent when focused
static HWND g_focus;
static void swiss_paint_frames(Node* n, HDC hdc) {
  if (n->frame && n->hwnd) {
    RECT r = { n->rx, n->ry, n->rx + n->rw, n->ry + n->rh };
    // accent border only for keyboard focus (like web :focus-visible): skip it
    // when Windows has hidden focus cues (mouse-driven UI).
    int hidefocus = (int)(SendMessageW(g_main, WM_QUERYUISTATE, 0, 0) & UISF_HIDEFOCUS);
    int foc = (n->hwnd == g_focus) && !hidefocus;
    swiss_fill_round(hdc, r, n->radius, C2A(swiss_tok(${TOKENS.indexOf('card')})), foc ? C2A(RGB(0, 102, 204)) : C2A(swiss_tok(${TOKENS.indexOf('border')})), foc ? 2.0f : 1.0f);
  }
  for (int i = 0; i < n->nkids; i++) if (n->kids[i]->visible && !n->kids[i]->abspos) swiss_paint_frames(n->kids[i], hdc);
}

// ── owner-drawn buttons: GDI+ antialiased rounded fill on the panel bg behind ──
static struct { HWND w; COLORREF bg, fg, behind; int radius, hasbg, hasfg, bgtok, fgtok, behindtok; } g_btns[64]; static int g_nbtns;
static void swiss_btn_style(HWND w, COLORREF bg, int hasbg, COLORREF fg, int hasfg, int radius, COLORREF behind, int bgtok, int fgtok, int behindtok) {
  if (g_nbtns < 64) { g_btns[g_nbtns].w = w; g_btns[g_nbtns].bg = bg; g_btns[g_nbtns].hasbg = hasbg;
    g_btns[g_nbtns].fg = fg; g_btns[g_nbtns].hasfg = hasfg; g_btns[g_nbtns].radius = radius; g_btns[g_nbtns].behind = behind;
    g_btns[g_nbtns].bgtok = bgtok; g_btns[g_nbtns].fgtok = fgtok; g_btns[g_nbtns].behindtok = behindtok; g_nbtns++; }
}
// current/apply color for the animation system (kind 0=text 1=view/static-bg 2=button-bg)
static COLORREF swiss_cur_c(HWND w, int kind) {
  if (kind == 0) { for (int i = 0; i < g_ncolors; i++) if (g_colors[i].w == w) return g_colors[i].c; }
  else if (kind == 1) { for (int i = 0; i < g_nbgs; i++) if (g_bgs[i].w == w) return g_bgs[i].c; }
  else if (kind == 3) { return ((Node*)w)->bg; }   // View node background
  else { for (int i = 0; i < g_nbtns; i++) if (g_btns[i].w == w) return g_btns[i].bg; }
  return 0;
}
static void swiss_apply_c(HWND w, int kind, COLORREF c) {
  if (kind == 0) { for (int i = 0; i < g_ncolors; i++) if (g_colors[i].w == w) { g_colors[i].c = c; g_colors[i].tok = 0; } }
  else if (kind == 1) { for (int i = 0; i < g_nbgs; i++) if (g_bgs[i].w == w) { if (g_bgs[i].b) DeleteObject(g_bgs[i].b); g_bgs[i].b = CreateSolidBrush(c); g_bgs[i].c = c; g_bgs[i].tok = 0; } }
  else if (kind == 3) { Node* nd = (Node*)w; nd->bg = c; nd->bgtok = 0; nd->hasbg = 1; RECT r = { nd->rx, nd->ry, nd->rx + nd->rw, nd->ry + nd->rh }; InvalidateRect(g_main, &r, FALSE); }
  else { for (int i = 0; i < g_nbtns; i++) if (g_btns[i].w == w) { g_btns[i].bg = c; g_btns[i].hasbg = 1; g_btns[i].bgtok = 0; } }
}
static void swiss_restyle_btn(HWND w, COLORREF bg) { swiss_anim(w, 2, bg); }
static void swiss_restyle_node(Node* n, COLORREF bg) { swiss_anim((HWND)n, 3, bg); }
static COLORREF swiss_darken(COLORREF c, int pct) { return RGB(GetRValue(c)*pct/100, GetGValue(c)*pct/100, GetBValue(c)*pct/100); }
static int swiss_btn_draw(LPDRAWITEMSTRUCT d) {
  for (int i = 0; i < g_nbtns; i++) if (g_btns[i].w == d->hwndItem) {
    int plain = !g_btns[i].hasbg;
    // resolve theme tokens for the current theme (flips on setTheme redraw)
    COLORREF tbg = g_btns[i].bgtok ? swiss_tok(g_btns[i].bgtok - 1) : g_btns[i].bg;
    COLORREF tbehind = g_btns[i].behindtok ? swiss_tok(g_btns[i].behindtok - 1) : g_btns[i].behind;
    COLORREF bg = plain ? (g_darktheme ? RGB(58, 64, 72) : RGB(245, 246, 248)) : tbg;   // light/dark surface for plain buttons
    if (d->itemState & ODS_SELECTED) bg = swiss_darken(bg, 86);        // pressed
    else if (d->itemState & ODS_HOTLIGHT) bg = swiss_darken(bg, 93);   // subtle hover feedback (webview-like)
    // flat like JSX/web: the button color is static (no hover/press shading — the
    // JSX styles declare no :hover, so the fill stays constant like the DOM)
    // paint the panel color behind first (no window region — GDI+ AA rounds it)
    HBRUSH bb = CreateSolidBrush(tbehind); FillRect(d->hDC, &d->rcItem, bb); DeleteObject(bb);
    int r = g_btns[i].radius;
    // show the focus ring only for keyboard focus (like web :focus-visible) —
    // Windows sets ODS_NOFOCUSRECT once the UI is driven by the mouse.
    int focus = ((d->itemState & ODS_FOCUS) && !(d->itemState & ODS_NOFOCUSRECT)) ? 1 : 0;
    // flat JSX/web look: solid fill, no gradient/rim. Colored buttons have no
    // border; plain (no-bg) buttons get a light gray border; focus adds a ring.
    ARGB border = focus ? C2A(RGB(0, 102, 204)) : plain ? C2A(RGB(205, 208, 212)) : 0;
    swiss_fill_round(d->hDC, d->rcItem, r, C2A(bg), border, (focus || plain) ? (focus ? 2.0f : 1.0f) : 0.0f);
    SetBkMode(d->hDC, TRANSPARENT);
    SetTextColor(d->hDC, g_btns[i].hasfg ? (g_btns[i].fgtok ? swiss_tok(g_btns[i].fgtok - 1) : g_btns[i].fg) : (plain ? g_fgcol : GetSysColor(COLOR_BTNTEXT)));
    HFONT f = (HFONT)SendMessageA(d->hwndItem, WM_GETFONT, 0, 0);
    HGDIOBJ of = f ? SelectObject(d->hDC, f) : NULL;
    char buf[256]; GetWindowTextA(d->hwndItem, buf, sizeof buf);
    DrawTextA(d->hDC, buf, -1, &d->rcItem, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    if (of) SelectObject(d->hDC, of);
    return 1;
  }
  return 0;
}
static int swiss_is_btn(HWND w) { for (int i = 0; i < g_nbtns; i++) if (g_btns[i].w == w) return 1; return 0; }

// ── custom (owner-drawn) checkbox: rounded box + GDI+ checkmark ──
static struct { HWND w; int checked; COLORREF behind, fg; } g_checks[64]; static int g_nchecks;
static void swiss_check_style(HWND w, COLORREF behind, COLORREF fg) { if (g_nchecks < 64) { g_checks[g_nchecks].w = w; g_checks[g_nchecks].behind = behind; g_checks[g_nchecks].fg = fg; g_checks[g_nchecks].checked = 0; g_nchecks++; } }
static int swiss_check_idx(HWND w) { for (int i = 0; i < g_nchecks; i++) if (g_checks[i].w == w) return i; return -1; }
static void swiss_check_set(HWND w, int v) { int i = swiss_check_idx(w); if (i >= 0) { g_checks[i].checked = v ? 1 : 0; InvalidateRect(w, NULL, FALSE); } }
static long long swiss_check_get(HWND w) { int i = swiss_check_idx(w); return i >= 0 ? g_checks[i].checked : 0; }
// flat owner-drawn combo item / closed display (accent selection)
static int swiss_combo_draw(LPDRAWITEMSTRUCT d) {
  if (d->CtlType != ODT_COMBOBOX) return 0;
  RECT rc = d->rcItem; int sel = (d->itemState & ODS_SELECTED) ? 1 : 0;
  HBRUSH b = CreateSolidBrush(sel ? RGB(0, 102, 204) : g_bgcol); FillRect(d->hDC, &rc, b); DeleteObject(b);
  if (d->itemID != (UINT)-1) {
    char txt[256]; txt[0] = 0; SendMessageA(d->hwndItem, CB_GETLBTEXT, d->itemID, (LPARAM)txt);
    SetBkColor(d->hDC, sel ? RGB(0, 102, 204) : g_bgcol); SetBkMode(d->hDC, OPAQUE); SetTextColor(d->hDC, sel ? RGB(255, 255, 255) : g_fgcol);
    HFONT f = (HFONT)SendMessageA(d->hwndItem, WM_GETFONT, 0, 0); HGDIOBJ of = f ? SelectObject(d->hDC, f) : NULL;
    RECT tr = rc; tr.left += SC(8);
    DrawTextA(d->hDC, txt, -1, &tr, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
    if (of) SelectObject(d->hDC, of);
  }
  return 1;
}
// a Text with backgroundColor → an owner-drawn rounded pill (badges/chips), AA
// owner-drawn Text: a rounded pill (backgroundColor) and/or letterSpacing /
// lineHeight, which native STATIC controls can't do (system-drawn).
static struct { HWND w; COLORREF bg, fg, behind; int radius, align, hasbg, spacing, lineh; } g_pills[64]; static int g_npills;
static void swiss_pill_style(HWND w, COLORREF bg, int hasbg, COLORREF fg, COLORREF behind, int radius, int align, int spacing, int lineh) {
  if (g_npills < 64) { g_pills[g_npills].w = w; g_pills[g_npills].bg = bg; g_pills[g_npills].hasbg = hasbg; g_pills[g_npills].fg = fg; g_pills[g_npills].behind = behind; g_pills[g_npills].radius = radius; g_pills[g_npills].align = align; g_pills[g_npills].spacing = spacing; g_pills[g_npills].lineh = lineh; g_npills++; }
}
static int swiss_is_pill(HWND w) { for (int i = 0; i < g_npills; i++) if (g_pills[i].w == w) return 1; return 0; }
static void swiss_pill_metrics(HWND w, int* sp, int* lh) { for (int i = 0; i < g_npills; i++) if (g_pills[i].w == w) { *sp = g_pills[i].spacing; *lh = g_pills[i].lineh; return; } }
static int swiss_pill_draw(LPDRAWITEMSTRUCT d) {
  if (d->CtlType != ODT_STATIC) return 0;
  int i = -1; for (int k = 0; k < g_npills; k++) if (g_pills[k].w == d->hwndItem) { i = k; break; }
  if (i < 0) return 0;
  HBRUSH bb = CreateSolidBrush(g_pills[i].behind); FillRect(d->hDC, &d->rcItem, bb); DeleteObject(bb);
  if (g_pills[i].hasbg) { swiss_fill_round(d->hDC, d->rcItem, g_pills[i].radius, C2A(g_pills[i].bg), 0, 0); SetBkColor(d->hDC, g_pills[i].bg); SetBkMode(d->hDC, OPAQUE); }
  else SetBkMode(d->hDC, TRANSPARENT);
  SetTextColor(d->hDC, g_pills[i].fg);
  if (g_pills[i].spacing) SetTextCharacterExtra(d->hDC, g_pills[i].spacing);   // letterSpacing
  HFONT f = (HFONT)SendMessageA(d->hwndItem, WM_GETFONT, 0, 0); HGDIOBJ of = f ? SelectObject(d->hDC, f) : NULL;
  char buf[512]; GetWindowTextA(d->hwndItem, buf, sizeof buf);
  UINT al = g_pills[i].align == 1 ? DT_CENTER : g_pills[i].align == 2 ? DT_RIGHT : DT_LEFT;
  if (g_pills[i].lineh > 0) {   // custom line height: greedy word-wrap + hand-drawn lines
    TEXTMETRICA tm; GetTextMetricsA(d->hDC, &tm);
    int lh = tm.tmHeight * g_pills[i].lineh / 100;
    int maxw = d->rcItem.right - d->rcItem.left; if (maxw < 1) maxw = 1;
    int y = d->rcItem.top; char* p = buf;
    while (*p) {
      char* q = p; char* fit = NULL;        // longest prefix (word boundary) that fits maxw
      for (;;) {
        while (*q && *q != ' ' && *q != '\\n') q++;
        SIZE s; GetTextExtentPoint32A(d->hDC, p, (int)(q - p), &s);
        if (s.cx <= maxw || fit == NULL) { fit = q; if (*q == '\\n') { q++; break; } if (!*q) break; q++; }
        else break;
      }
      int len = (int)(fit - p); while (len > 0 && (p[len - 1] == ' ' || p[len - 1] == '\\n')) len--;
      TextOutA(d->hDC, d->rcItem.left, y, p, len); y += lh;
      p = fit; while (*p == ' ' || *p == '\\n') p++;
    }
  } else {
    DrawTextA(d->hDC, buf, -1, &d->rcItem, al | DT_VCENTER | DT_SINGLELINE);
  }
  if (g_pills[i].spacing) SetTextCharacterExtra(d->hDC, 0);
  if (of) SelectObject(d->hDC, of);
  return 1;
}
static int swiss_check_draw(LPDRAWITEMSTRUCT d) {
  int i = swiss_check_idx(d->hwndItem); if (i < 0) return 0;
  RECT rc = d->rcItem;
  HBRUSH bb = CreateSolidBrush(g_checks[i].behind); FillRect(d->hDC, &rc, bb); DeleteObject(bb);
  int box = SC(18), by = rc.top + (rc.bottom - rc.top - box) / 2, chk = g_checks[i].checked;
  RECT br = { rc.left, by, rc.left + box, by + box };
  swiss_fill_round(d->hDC, br, SC(4), chk ? C2A(RGB(0, 102, 204)) : C2A(RGB(255, 255, 255)),
                   chk ? C2A(RGB(0, 102, 204)) : C2A(RGB(170, 170, 170)), 1.5f);
  if (chk) {   // white checkmark
    GpGraphics* g = NULL; GdipCreateFromHDC(d->hDC, &g); GdipSetSmoothingMode(g, 4);
    GpPen* pen = NULL; GdipCreatePen1(C2A(RGB(255, 255, 255)), (float)SC(2), 2, &pen);
    if (pen && g) {
      float x = (float)rc.left, y = (float)by, b = (float)box;
      GdipDrawLine(g, pen, x + b * 0.26f, y + b * 0.52f, x + b * 0.44f, y + b * 0.70f);
      GdipDrawLine(g, pen, x + b * 0.44f, y + b * 0.70f, x + b * 0.74f, y + b * 0.32f);
    }
    if (pen) GdipDeletePen(pen); if (g) GdipDeleteGraphics(g);
  }
  SetBkColor(d->hDC, g_checks[i].behind); SetBkMode(d->hDC, OPAQUE); SetTextColor(d->hDC, g_checks[i].fg);
  HFONT f = (HFONT)SendMessageA(d->hwndItem, WM_GETFONT, 0, 0); HGDIOBJ of = f ? SelectObject(d->hDC, f) : NULL;
  char buf[256]; GetWindowTextA(d->hwndItem, buf, sizeof buf);
  RECT tr = { rc.left + box + SC(8), rc.top, rc.right, rc.bottom };
  DrawTextA(d->hDC, buf, -1, &tr, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
  if (of) SelectObject(d->hDC, of);
  return 1;
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
static void swiss_set_theme(long long dark) {
  g_darktheme = dark ? 1 : 0;
  g_bgcol = dark ? RGB(30, 30, 30) : RGB(255, 255, 255);
  g_fgcol = dark ? RGB(230, 230, 230) : RGB(26, 26, 26);
  if (g_white) DeleteObject(g_white);
  g_white = CreateSolidBrush(g_bgcol);
  if (g_main) {
    SetClassLongPtrA(g_main, GCLP_HBRBACKGROUND, (LONG_PTR)g_white);
    // repaint the window AND every child so each control re-queries its colors
    // (WS_CLIPCHILDREN means a plain InvalidateRect skips the children)
    RedrawWindow(g_main, NULL, NULL, RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW);
  }
}

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
      if (HIWORD(wp) == EN_SETFOCUS || HIWORD(wp) == EN_KILLFOCUS) {   // input focus ring
        g_focus = HIWORD(wp) == EN_SETFOCUS ? (HWND)lp : NULL; InvalidateRect(hwnd, NULL, FALSE);
      }
      if (HIWORD(wp) == BN_CLICKED) {   // owner-drawn checkboxes toggle themselves
        int _ci = swiss_check_idx((HWND)lp); if (_ci >= 0) { g_checks[_ci].checked = !g_checks[_ci].checked; InvalidateRect((HWND)lp, NULL, FALSE); }
      }
${cmdCases || '      break;'}
      break;
    }
    case WM_DRAWITEM: {
      if (swiss_btn_draw((LPDRAWITEMSTRUCT)lp)) return TRUE;
      if (swiss_check_draw((LPDRAWITEMSTRUCT)lp)) return TRUE;
      if (swiss_combo_draw((LPDRAWITEMSTRUCT)lp)) return TRUE;
      if (swiss_pill_draw((LPDRAWITEMSTRUCT)lp)) return TRUE;
      break;
    }
    case WM_MEASUREITEM: {
      LPMEASUREITEMSTRUCT m = (LPMEASUREITEMSTRUCT)lp;
      if (m->CtlType == ODT_COMBOBOX) { m->itemHeight = SC(24); return TRUE; }
      break;
    }
    case WM_SETCURSOR: {   // hand cursor over styled buttons (web cursor:pointer)
      if (swiss_is_btn((HWND)wp)) { SetCursor(LoadCursorA(NULL, (LPCSTR)IDC_HAND)); return TRUE; }
      break;
    }
    case WM_HSCROLL: {
      for (int i = 0; i < g_ntracks; i++) if (g_tracks[i].w == (HWND)lp) { g_tracks[i].cb(&S, (HWND)lp); break; }
      return 0;
    }
    case WM_TIMER: {
      if ((UINT_PTR)wp == 0x5A11) { swiss_anim_tick(); return 0; }   // reactive color transitions
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
      if (g_root) { swiss_paint_bg(g_root, mem); swiss_paint_frames(g_root, mem);   // View bg + input borders
        for (int i = 0; i < g_nabs; i++) { swiss_paint_bg(g_absnodes[i], mem); swiss_paint_frames(g_absnodes[i], mem); } }   // absolute overlays on top (zIndex order)
      BitBlt(hdc, 0, 0, rc.right, rc.bottom, mem, 0, 0, SRCCOPY);
      SelectObject(mem, ob); DeleteObject(bmp); DeleteDC(mem);
      EndPaint(hwnd, &ps); return 0;
    }
    case WM_CTLCOLORSTATIC: case WM_CTLCOLORBTN: {
      COLORREF col, bgc; HBRUSH bgb; HDC dc = (HDC)wp;
      SetTextColor(dc, swiss_get_color((HWND)lp, &col) ? col : g_fgcol);   // explicit color, else theme fg
      // opaque fill with the control's bg (own/inherited panel color, else the
      // theme background) so static text is correct without transparency — lets
      // WS_CLIPCHILDREN suppress repaint flicker
      if (swiss_get_bg((HWND)lp, &bgc, &bgb)) { SetBkColor(dc, bgc); SetBkMode(dc, OPAQUE); return (LRESULT)bgb; }
      SetBkColor(dc, g_bgcol); SetBkMode(dc, OPAQUE); return (LRESULT)g_white;
    }
    case WM_CTLCOLOREDIT: {   // inputs use the themed "card" surface (else system white → wrong in dark)
      HDC dc = (HDC)wp; SetTextColor(dc, g_fgcol);
      COLORREF c = swiss_tok(${TOKENS.indexOf('card')});
      static HBRUSH eb; static COLORREF ec;
      if (!eb || ec != c) { if (eb) DeleteObject(eb); eb = CreateSolidBrush(c); ec = c; }
      SetBkColor(dc, c); return (LRESULT)eb;
    }
    case WM_SIZE: swiss_relayout(); return 0;
    case WM_UPDATEUISTATE: InvalidateRect(hwnd, NULL, FALSE); break;   // focus-cue visibility changed → redraw indicators
    case WM_MOUSEWHEEL: {   // scroll the innermost overflow:auto View under the cursor
      int delta = (int)(short)HIWORD(wp);
      POINT pt = { (short)LOWORD(lp), (short)HIWORD(lp) }; ScreenToClient(hwnd, &pt);
      Node* sn = g_root ? swiss_scroll_hit(g_root, pt.x, pt.y) : NULL;
      if (sn) { sn->scrolly -= delta / 2; swiss_relayout(); InvalidateRect(hwnd, NULL, TRUE); return 0; }
      break;
    }
    case WM_DESTROY: PostQuitMessage(0); return 0;
  }
  return DefWindowProcA(hwnd, msg, wp, lp);
}

int WINAPI WinMain(HINSTANCE hi, HINSTANCE hp, LPSTR cmd, int show) {
  (void)hp; (void)cmd;
  g_hinst = hi;
  // per-monitor DPI awareness at runtime too (not just the manifest) so the app
  // never gets bitmap-upscaled (blurry) — must run before any window
  { HMODULE u = GetModuleHandleA("user32.dll");
    typedef BOOL (WINAPI *SetCtx)(HANDLE);
    SetCtx setctx = u ? (SetCtx)(void*)GetProcAddress(u, "SetProcessDpiAwarenessContext") : NULL;
    if (setctx) setctx((HANDLE)(INT_PTR)-4);   // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
  }
  { HDC _dc = GetDC(NULL); int _dpi = GetDeviceCaps(_dc, LOGPIXELSX); ReleaseDC(NULL, _dc); if (_dpi > 0) g_scale = _dpi / 96.0; }  // HiDPI factor
  { ULONG_PTR _gp; GdiplusStartupInput _gi = { 1, NULL, FALSE, FALSE }; GdiplusStartup(&_gp, &_gi, NULL); }   // antialiased control rendering
  swiss_pick_font();   // DejaVu Sans where available (matches the GTK target), else Segoe UI
  { INITCOMMONCONTROLSEX _ic = { sizeof(INITCOMMONCONTROLSEX), ICC_STANDARD_CLASSES | ICC_BAR_CLASSES | ICC_PROGRESS_CLASS }; InitCommonControlsEx(&_ic); }
${cells.filter((c) => c.cinit != null).map((c) => `  S.${c.name} = ${c.cinit};`).join('\n')}
${refs.map((r) => `  S.${r.name}__current = ${r.cinit};`).join('\n')}
  swiss_init(&S);
  WNDCLASSA wc; memset(&wc, 0, sizeof wc);
  wc.lpfnWndProc = swiss_wndproc; wc.hInstance = hi; wc.lpszClassName = "SwissWindow";
  swiss_set_theme(0);   // light default (creates g_white from the theme bg)
  wc.hCursor = LoadCursor(NULL, IDC_ARROW); wc.hbrBackground = g_white;
  RegisterClassA(&wc);
  g_main = CreateWindowExA(0, "SwissWindow", ${cstr(opts.title || 'Swiss')},
    WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN, CW_USEDEFAULT, CW_USEDEFAULT, SC(960), SC(640), NULL, NULL, hi, NULL);
  g_root = swiss_build_ui(&S);
  if (g_root) g_root->overflow = 1;   // page scroll when content exceeds the window (like the web body)
  swiss_effect(&S);
  swiss_relayout();
  ShowWindow(g_main, show); UpdateWindow(g_main);
  SendMessageW(g_main, WM_CHANGEUISTATE, MAKEWPARAM(UIS_INITIALIZE, UISF_HIDEFOCUS), 0);   // hide focus cues until keyboard nav (web :focus-visible feel)
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
  const font = args.includes('--font') ? args[args.indexOf('--font') + 1] : '';
  let sigs = {};
  if (args.includes('--sig') && existsSync(args[args.indexOf('--sig') + 1])) sigs = JSON.parse(readFileSync(args[args.indexOf('--sig') + 1], 'utf8'));
  if (!input) { console.error('usage: swiss-win32c <App.jsx> --out frontend.c [--title T] [--sig sig.json] [--font "Family"]'); process.exit(1); }
  const ast = parse(readFileSync(input, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
  writeFileSync(out, emit(ast, { title, sigs, font }));
  console.error(`swiss-win32c: ${input} → ${out}`);
}
main();
