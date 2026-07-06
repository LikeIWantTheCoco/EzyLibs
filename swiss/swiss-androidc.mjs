// swiss-androidc — Swiss Android translator (BUILD TIME ONLY; never shipped as JS).
//
// React/JSX  ──@babel/parser──▶ AST ──lower──▶ Kotlin + Android Views  (no JS
// engine in the app). Mirrors swiss-gtkc/swiss-win32c: the SAME shared core
// (swiss-jsx-core) parses and lowers the SAME React semantics; only the widget
// emission + runtime differ. Where GTK emits C over GTK3, this emits Kotlin over
// the android.widget View tree, and drives expression/statement codegen through
// the Kotlin backend (swiss-kt-backend) instead of the C backend.
//
//   useState → SwissState fields, setState → swissUpdate_<cell>() touching only
//   the widgets that read the cell, .map → a LinearLayout rebuilt on the array,
//   ezy.call('f',…) → a direct call into the Ezy backend (JNI extern).
//
// Supported subset (v0.1): function component (default export), useState/useMemo/
// useRef/useEffect, presentational + stateful child components (via the core's
// build-time inline), View/Text/Button/Input/Switch/Checkbox/Slider/ProgressBar/
// Image/Separator/Select/TextArea/ScrollView, {expr} interpolation, .map lists,
// {cond && <E/>} / ternary children, onPress/onChange/onClick handlers.
//
// Known gaps vs GTK/Win32 (documented in PARITY.md): live re-theme (tokens are
// resolved to the light palette at build time), blocking confirm()/pickFile()
// (Android dialogs are async — emitted as stubs), Tabs/Calendar/Expander/Spinner.
//
// Usage:  node swiss-androidc.mjs App.jsx --out MainActivity.kt [--pkg com.x.y] [--sig sig.json]
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { parse, cstr, stripParens, createFrontend, walk, THEME, isToken } from './swiss-jsx-core.mjs';
import { ktBackend } from './swiss-kt-backend.mjs';

// a theme token resolves to its light-palette hex at build time (live re-theme
// is a documented gap on this target); anything else passes through to Color.
const col = (x) => (isToken(x) ? THEME[x][0] : x);

// ───────────────────────── emit ─────────────────────────
function emit(ast, opts) {
  const F = createFrontend(ast, { sigs: opts.sigs || {}, tag: 'swiss-androidc', widgetType: 'View?', backend: ktBackend });
  const {
    err, sigs, styles, comp, cells, methods, refs, derived, components,
    cellByName, cellBySetter, methodByName, refByName, componentByName,
    arrayCells, objectCells, deps, out, stateFields, vid,
    cexpr, genStmt, genStmts, genArraySet, objLit, emitMethods, handlerBody,
    cellsIn, jsxOf, rootJSX,
  } = F;

  // ── helpers over the JSX AST (same shapes as the GTK translator) ──
  function attrs(el) { const o = {}; for (const a of el.openingElement.attributes) if (a.type === 'JSXAttribute') o[a.name.name] = a.value; return o; }
  const elName = (el) => el.openingElement.name.name;
  const strAttr = (a) => !a ? '' : a.type === 'StringLiteral' ? a.value : a.type === 'JSXExpressionContainer' && a.expression.type === 'StringLiteral' ? a.expression.value : '';
  // a widget field on SwissState, typed for the reactive update fns (`s.f!!.text = …`)
  const field = (name, ktType) => { stateFields.push(`  var ${name}: ${ktType}? = null`); return name; };

  // ── styles: parse inline {{…}} / resolve styles.x refs (like GTK) ──
  function parseInline(obj) {
    const num = (s) => { const m = String(s).match(/-?\d+/); return m ? parseInt(m[0]) : 0; };
    const o = {};
    for (const p of obj.properties) {
      if (p.type !== 'ObjectProperty' && p.type !== 'Property') continue;
      const k = p.key.name || p.key.value; const v = p.value;
      const raw = v.type === 'StringLiteral' ? v.value : v.type === 'NumericLiteral' ? v.value : null;
      if (raw == null) continue; const s = String(raw);
      if (k === 'padding') o.padding = num(s);
      else if (k === 'paddingTop') o.paddingTop = num(s);
      else if (k === 'paddingBottom') o.paddingBottom = num(s);
      else if (k === 'paddingLeft') o.paddingLeft = num(s);
      else if (k === 'paddingRight') o.paddingRight = num(s);
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
      else if (k === 'fontStyle') o.fontStyle = s;
      else if (k === 'textTransform') o.textTransform = s;
      else if (k === 'color') o.color = s;
      else if (k === 'backgroundColor' || k === 'background') o.backgroundColor = s;
      else if (k === 'borderRadius') o.borderRadius = num(s);
      else if (k === 'textAlign') o.textAlign = s;
      else if (k === 'flexDirection') o.flexDirection = s;
      else if (k === 'gap') o.gap = num(s);
      else if (k === 'alignItems') o.alignItems = s;
      else if (k === 'justifyContent') o.justifyContent = s;
      else if (k === 'opacity') o.opacity = Number(s);
      else if (k === 'border') { if (s !== 'none') { const m = s.match(/(\d+)px\s+\w+\s+(\S+)/); if (m) { o.borderWidth = parseInt(m[1]); o.borderColor = m[2]; } } }
      else if (k === 'borderWidth') o.borderWidth = num(s);
      else if (k === 'borderColor') o.borderColor = s;
      else if (k === 'overflow' || k === 'overflowY') o.overflow = s;
    }
    return o;
  }
  function resolveStyle(node) {
    if (!node || node.type !== 'JSXExpressionContainer') return null;
    const e = node.expression;
    if (e.type === 'ObjectExpression') return parseInline(e);
    const names = [];
    if (e.type === 'MemberExpression' && e.object.name === 'styles') names.push(e.property.name);
    else if (e.type === 'ArrayExpression')
      for (const el of e.elements) if (el && el.type === 'MemberExpression' && el.object.name === 'styles') names.push(el.property.name);
    if (!names.length) return null;
    return Object.assign({}, ...names.map((n) => styles[n] || {}));
  }

  // ── apply a style object to a just-created view `v` (emits Kotlin lines) ──
  const P = (line) => out.build.push(line);
  function applyPadding(v, st) {
    const l = st.paddingLeft ?? st.padding ?? 0, r = st.paddingRight ?? st.padding ?? 0;
    const t = st.paddingTop ?? st.padding ?? 0, b = st.paddingBottom ?? st.padding ?? 0;
    if (l || r || t || b) P(`  ${v}.setPadding(dp(${l}), dp(${t}), dp(${r}), dp(${b}))`);
  }
  // background: rounded/bordered → a GradientDrawable; otherwise a flat color
  function applyBackground(v, st) {
    const hasShape = st.borderRadius != null || st.borderWidth != null;
    if (hasShape) {
      P(`  ${v}.background = GradientDrawable().apply {`);
      if (st.backgroundColor) P(`    setColor(swissColor(${cstr(col(st.backgroundColor))}))`);
      if (st.borderRadius != null) P(`    cornerRadius = dp(${Number(st.borderRadius)}).toFloat()`);
      if (st.borderWidth != null) P(`    setStroke(dp(${Number(st.borderWidth)}), swissColor(${cstr(col(st.borderColor || '#000000'))}))`);
      P(`  }`);
    } else if (st.backgroundColor) {
      P(`  ${v}.setBackgroundColor(swissColor(${cstr(col(st.backgroundColor))}))`);
    }
  }
  // common non-text style (background, padding, opacity)
  function applyCommon(v, st) {
    if (!st) return;
    applyBackground(v, st);
    applyPadding(v, st);
    if (st.opacity != null) P(`  ${v}.alpha = ${Number(st.opacity)}f`);
  }
  // text style (color, size, weight, align, transform) on a TextView-typed var
  function applyText(v, st) {
    if (!st) return;
    if (st.color) P(`  ${v}.setTextColor(swissColor(${cstr(col(st.color))}))`);
    if (st.fontSize != null) P(`  ${v}.textSize = ${Number(st.fontSize)}f`);   // sp
    if (st.fontWeight === 'bold' || Number(st.fontWeight) >= 600) P(`  ${v}.setTypeface(${v}.typeface, Typeface.BOLD)`);
    if (st.fontStyle === 'italic') P(`  ${v}.setTypeface(${v}.typeface, Typeface.ITALIC)`);
    const g = st.textAlign === 'center' ? 'Gravity.CENTER_HORIZONTAL' : st.textAlign === 'right' ? 'Gravity.END' : 'Gravity.START';
    P(`  ${v}.gravity = ${g}`);
  }
  // add `v` to `parent` with LinearLayout params derived from its own style
  function pack(v, st, parentHorizontal) {
    if (!parentHorizontal && parentHorizontal !== false) parentHorizontal = false;
    const wants = (dim) => st && st[dim];
    let w = 'ViewGroup.LayoutParams.WRAP_CONTENT', h = 'ViewGroup.LayoutParams.WRAP_CONTENT';
    if (st && (st.fillCross)) w = 'ViewGroup.LayoutParams.MATCH_PARENT';
    if (st && st.width != null) w = `dp(${Number(st.width)})`;
    if (st && st.height != null) h = `dp(${Number(st.height)})`;
    // flex → weight, main-axis dimension 0 (Android convention)
    const weight = st && (st.flex || st.flexGrow) ? Number(st.flex || st.flexGrow) : 0;
    if (weight) { if (parentHorizontal) w = '0'; else h = '0'; }
    P(`  run { val _lp = LinearLayout.LayoutParams(${w}, ${h})`);
    if (weight) P(`    _lp.weight = ${weight}f`);
    if (st && st.margin != null) P(`    _lp.setMargins(dp(${st.margin}), dp(${st.margin}), dp(${st.margin}), dp(${st.margin}))`);
    if (st && st.marginTop != null) P(`    _lp.topMargin = dp(${st.marginTop})`);
    if (st && st.marginBottom != null) P(`    _lp.bottomMargin = dp(${st.marginBottom})`);
    if (st && st.marginLeft != null) P(`    _lp.leftMargin = dp(${st.marginLeft})`);
    if (st && st.marginRight != null) P(`    _lp.rightMargin = dp(${st.marginRight})`);
    if (st && st.alignSelf === 'center') P(`    _lp.gravity = Gravity.CENTER_HORIZONTAL`);
    P(`    ${v}.layoutParams = _lp }`);
  }

  // ── text children → a Kotlin String expression (parts joined with +) ──
  function textExpr(el, scope) {
    const parts = []; const reads = new Set(); let dynamic = false, staticText = '';
    for (const ch of el.children) {
      if (ch.type === 'JSXText') { const t = ch.value.replace(/\s+/g, ' '); if (t.trim() !== '') { parts.push(cstr(t)); staticText += t; } }
      else if (ch.type === 'JSXExpressionContainer' && ch.expression.type !== 'JSXEmptyExpression') {
        const v = cexpr(ch.expression, scope);
        parts.push(v.t === 'string' ? v.c : `(${v.c}).toString()`); dynamic = true;
        cellsIn(ch.expression).forEach((c) => reads.add(c));
      }
    }
    return { expr: parts.length ? parts.join(' + ') : '""', reads, dynamic, staticText };
  }

  // ── handler arrow → a Kotlin lambda body (list of statement lines) ──
  // valExpr is the Kotlin expression for the event value (or null).
  function handlerLines(attrNode, scope, valExpr) {
    return handlerBody(attrNode.expression, scope, valExpr);
  }

  // ── recursive widget builder ──
  function build(el, parent, scope) {
    if (el.type === 'JSXFragment') {
      const v = vid('frag');
      P(`  val ${v} = LinearLayout(appCtx); ${v}.orientation = LinearLayout.VERTICAL`);
      buildChildren(el.children, v, scope, false);
      if (parent) { P(`  ${parent}.addView(${v})`); }
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
    const parentH = !!(scope && scope.__parentHorizontal);

    if (name === 'View' || name === 'Tab' || name === 'ScrollView') {
      const horizontal = !!(st && st.flexDirection === 'row');
      if (name === 'ScrollView') {
        const sc = vid('sc');
        P(`  val ${sc} = ScrollView(appCtx)`);
        const inner = vid('v');
        P(`  val ${inner} = LinearLayout(appCtx); ${inner}.orientation = LinearLayout.VERTICAL`);
        buildChildren(el.children, inner, { ...scope, __parentHorizontal: false }, false);
        if (st && st.gap) P(`  swissGap(${inner}, dp(${Number(st.gap)}), false)`);
        applyCommon(inner, st);
        P(`  ${sc}.addView(${inner})`);
        if (parent) { pack(sc, st, parentH); P(`  ${parent}.addView(${sc})`); }
        return sc;
      }
      const v = vid('v');
      P(`  val ${v} = LinearLayout(appCtx); ${v}.orientation = ${horizontal ? 'LinearLayout.HORIZONTAL' : 'LinearLayout.VERTICAL'}`);
      if (st && (st.alignItems || st.justifyContent)) {
        const gmap = { center: 'Gravity.CENTER', 'flex-start': horizontal ? 'Gravity.START' : 'Gravity.TOP', 'flex-end': horizontal ? 'Gravity.END' : 'Gravity.BOTTOM', start: 'Gravity.START', end: 'Gravity.END' };
        const parts = [];
        if (st.justifyContent && gmap[st.justifyContent]) parts.push(gmap[st.justifyContent]);
        if (st.alignItems && gmap[st.alignItems]) parts.push(gmap[st.alignItems]);
        if (parts.length) P(`  ${v}.gravity = ${parts.join(' or ')}`);
      }
      applyCommon(v, st);
      buildChildren(el.children, v, { ...scope, __parentHorizontal: horizontal }, false);
      if (st && st.gap) P(`  swissGap(${v}, dp(${Number(st.gap)}), ${horizontal})`);
      if (parent) { pack(v, st, parentH); P(`  ${parent}.addView(${v})`); }
      return v;
    }
    if (name === 'Text') {
      const info = textExpr(el, scope);
      if (info.dynamic && !scope.__inrow) {
        const f = field(vid('lbl'), 'TextView');
        P(`  s.${f} = TextView(appCtx)`);
        const real = textExpr(el, scope);
        P(`  s.${f}!!.text = ${real.expr}`);
        info.reads.forEach((cn) => deps[cn] && deps[cn].push(`s.${f}!!.text = ${real.expr};`));
        applyCommon(`s.${f}!!`, st); applyText(`s.${f}!!`, st);
        if (parent) { pack(`s.${f}!!`, st, parentH); P(`  ${parent}.addView(s.${f})`); }
        return `s.${f}`;
      }
      const l = vid('t');
      let txt = info.dynamic ? info.expr : cstr(st && st.textTransform === 'uppercase' ? info.staticText.toUpperCase() : st && st.textTransform === 'lowercase' ? info.staticText.toLowerCase() : info.staticText);
      P(`  val ${l} = TextView(appCtx); ${l}.text = ${txt}`);
      applyCommon(l, st); applyText(l, st);
      if (parent) { pack(l, st, parentH); P(`  ${parent}.addView(${l})`); }
      return l;
    }
    if (name === 'Button') {
      const b = vid('b');
      let label = '', dynTitle = null;
      if (a.title && a.title.type === 'StringLiteral') label = a.title.value;
      else if (a.title && a.title.type === 'JSXExpressionContainer') { if (a.title.expression.type === 'StringLiteral') label = a.title.expression.value; else dynTitle = a.title.expression; }
      else if (!a.title) label = el.children.filter((c) => c.type === 'JSXText').map((c) => c.value.trim()).filter(Boolean).join(' ');
      // dynamic title → store the button so an update fn can re-set the text
      let bref = b;
      if (dynTitle && !scope.__inrow) { bref = 's.' + field(vid('btn'), 'Button') + '!!'; P(`  ${bref.slice(0, -2)} = Button(appCtx)`); }
      else P(`  val ${b} = Button(appCtx)`);
      P(`  ${bref}.text = ${dynTitle ? cexprText(dynTitle, scope) : cstr(label)}`);
      P(`  ${bref}.isAllCaps = false`);
      if (dynTitle && !scope.__inrow) { const snip = `${bref}.text = ${cexprText(dynTitle, scope)};`; cellsIn(dynTitle).forEach((cn) => deps[cn] && deps[cn].push(snip)); }
      applyCommon(bref, st); applyText(bref, st);
      let press = a.onPress || a.onClick;
      if (press) {
        const lines = handlerLines(press, scope, null);
        P(`  ${bref}.setOnClickListener {`);
        lines.forEach((ln) => P('  ' + ln));
        P(`  }`);
      }
      if (parent) { pack(bref, st, parentH); P(`  ${parent}.addView(${bref.replace(/!!$/, '')})`); }
      return bref;
    }
    if (name === 'Input' || name === 'TextArea') {
      const f = field(vid('ent'), 'EditText');
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      P(`  s.${f} = EditText(appCtx)`);
      if (name === 'TextArea') P(`  s.${f}!!.setSingleLine(false)`);
      const ph = strAttr(a.placeholder);
      if (ph) P(`  s.${f}!!.hint = ${cstr(ph)}`);
      if (cell) {
        P(`  s.${f}!!.setText(${cell.t === 'string' ? `s.${cell.name}` : '""'})`);
        deps[cell.name].push(`if (s.${f}!!.text.toString() != s.${cell.name}) s.${f}!!.setText(s.${cell.name});`);
        if (a.onChange) {
          const h = a.onChange.expression; const lines = [];
          if (h.type === 'Identifier' && cellBySetter(h.name)) {
            const tc = cellBySetter(h.name);
            lines.push(`s.${tc.name} = _s`, `swissUpdate_${tc.name}(s)`);
          } else if (h.type === 'ArrowFunctionExpression') {
            genStmts(h.body, { ...scope, __evtext: `_s` }, lines);
          } else err('Input onChange must be a setter or (e)=>setX(e.target.value)', a.onChange);
          P(`  s.${f}!!.addTextChangedListener(object : TextWatcher {`);
          P(`    override fun afterTextChanged(e: Editable?) { val _s = e.toString()`);
          lines.forEach((ln) => P('    ' + ln.replace(/^\s+/, '')));
          P(`    }`);
          P(`    override fun beforeTextChanged(x: CharSequence?, a: Int, b: Int, c: Int) {}`);
          P(`    override fun onTextChanged(x: CharSequence?, a: Int, b: Int, c: Int) {}`);
          P(`  })`);
        }
      }
      applyCommon(`s.${f}!!`, st); applyText(`s.${f}!!`, st);
      if (parent) { pack(`s.${f}!!`, st, parentH); P(`  ${parent}.addView(s.${f})`); }
      return `s.${f}`;
    }
    if (name === 'Switch') {
      const f = field(vid('sw'), 'Switch');
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      P(`  s.${f} = Switch(appCtx)`);
      if (cell) { P(`  s.${f}!!.isChecked = ${cellBoolExpr(cell)}`); deps[cell.name].push(`s.${f}!!.isChecked = ${cellBoolExpr(cell)};`); }
      if (a.onChange) {
        const lines = handlerLines(a.onChange, scope, '(if (_on) 1L else 0L)');
        P(`  s.${f}!!.setOnCheckedChangeListener { _, _on ->`);
        lines.forEach((ln) => P('  ' + ln));
        P(`  }`);
      }
      applyCommon(`s.${f}!!`, st);
      if (parent) { pack(`s.${f}!!`, st, parentH); P(`  ${parent}.addView(s.${f})`); }
      return `s.${f}`;
    }
    if (name === 'Checkbox') {
      const f = field(vid('chk'), 'CheckBox');
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      P(`  s.${f} = CheckBox(appCtx); s.${f}!!.text = ${cstr(strAttr(a.label))}`);
      if (cell) { P(`  s.${f}!!.isChecked = ${cellBoolExpr(cell)}`); deps[cell.name].push(`s.${f}!!.isChecked = ${cellBoolExpr(cell)};`); }
      if (a.onChange) {
        const lines = handlerLines(a.onChange, scope, '(if (_on) 1L else 0L)');
        P(`  s.${f}!!.setOnCheckedChangeListener { _, _on ->`);
        lines.forEach((ln) => P('  ' + ln));
        P(`  }`);
      }
      applyCommon(`s.${f}!!`, st);
      if (parent) { pack(`s.${f}!!`, st, parentH); P(`  ${parent}.addView(s.${f})`); }
      return `s.${f}`;
    }
    if (name === 'Slider') {
      const f = field(vid('sl'), 'SeekBar');
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      const max = Number(strAttr(a.max) || (a.max && a.max.expression && a.max.expression.value) || 100);
      P(`  s.${f} = SeekBar(appCtx); s.${f}!!.max = ${max}`);
      if (cell) { P(`  s.${f}!!.progress = (s.${cell.name}).toInt()`); deps[cell.name].push(`if (s.${f}!!.progress.toLong() != s.${cell.name}) s.${f}!!.progress = (s.${cell.name}).toInt();`); }
      if (a.onChange) {
        const lines = handlerLines(a.onChange, scope, '_p.toLong()');
        P(`  s.${f}!!.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {`);
        P(`    override fun onProgressChanged(sb: SeekBar?, _p: Int, fromUser: Boolean) { if (!fromUser) return`);
        lines.forEach((ln) => P('    ' + ln.replace(/^\s+/, '')));
        P(`    }`);
        P(`    override fun onStartTrackingTouch(sb: SeekBar?) {}`);
        P(`    override fun onStopTrackingTouch(sb: SeekBar?) {}`);
        P(`  })`);
      }
      applyCommon(`s.${f}!!`, st);
      if (parent) { pack(`s.${f}!!`, st, parentH); P(`  ${parent}.addView(s.${f})`); }
      return `s.${f}`;
    }
    if (name === 'ProgressBar') {
      const f = field(vid('pb'), 'ProgressBar');
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      const max = Number(strAttr(a.max) || (a.max && a.max.expression && a.max.expression.value) || 100);
      P(`  s.${f} = ProgressBar(appCtx, null, android.R.attr.progressBarStyleHorizontal); s.${f}!!.max = ${max}`);
      if (cell) { P(`  s.${f}!!.progress = (s.${cell.name}).toInt()`); deps[cell.name].push(`s.${f}!!.progress = (s.${cell.name}).toInt();`); }
      applyCommon(`s.${f}!!`, st);
      if (parent) { pack(`s.${f}!!`, st, parentH); P(`  ${parent}.addView(s.${f})`); }
      return `s.${f}`;
    }
    if (name === 'Select') {
      const f = field(vid('cmb'), 'Spinner');
      const cell = a.value && a.value.type === 'JSXExpressionContainer' ? cellByName(a.value.expression.name) : null;
      const opts2 = a.options && a.options.expression && a.options.expression.type === 'ArrayExpression' ? a.options.expression.elements.map((o) => cstr(o.value)) : [];
      P(`  s.${f} = Spinner(appCtx)`);
      P(`  s.${f}!!.adapter = ArrayAdapter(appCtx, android.R.layout.simple_spinner_dropdown_item, arrayOf(${opts2.join(', ')}))`);
      if (cell) { P(`  s.${f}!!.setSelection((s.${cell.name}).toInt())`); deps[cell.name].push(`if (s.${f}!!.selectedItemPosition.toLong() != s.${cell.name}) s.${f}!!.setSelection((s.${cell.name}).toInt());`); }
      if (a.onChange) {
        const lines = handlerLines(a.onChange, scope, 'pos.toLong()');
        P(`  s.${f}!!.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {`);
        P(`    override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) {`);
        lines.forEach((ln) => P('    ' + ln.replace(/^\s+/, '')));
        P(`    }`);
        P(`    override fun onNothingSelected(p: AdapterView<*>?) {}`);
        P(`  }`);
      }
      applyCommon(`s.${f}!!`, st);
      if (parent) { pack(`s.${f}!!`, st, parentH); P(`  ${parent}.addView(s.${f})`); }
      return `s.${f}`;
    }
    if (name === 'Image') {
      const v = vid('img');
      P(`  val ${v} = ImageView(appCtx); swissLoadImage(${v}, ${cstr(strAttr(a.src))})`);
      applyCommon(v, st);
      if (parent) { pack(v, st, parentH); P(`  ${parent}.addView(${v})`); }
      return v;
    }
    if (name === 'Separator') {
      const v = vid('sep');
      P(`  val ${v} = View(appCtx); ${v}.setBackgroundColor(swissColor(${cstr(col((st && st.backgroundColor) || 'border'))}))`);
      const horiz = !(st && st.flexDirection === 'row');
      P(`  ${v}.layoutParams = LinearLayout.LayoutParams(${horiz ? 'ViewGroup.LayoutParams.MATCH_PARENT, dp(1)' : 'dp(1), ViewGroup.LayoutParams.MATCH_PARENT'})`);
      if (parent) P(`  ${parent}.addView(${v})`);
      return v;
    }
    err(`unsupported component <${name}> on the Android target`, el);
  }

  // a dynamic value coerced to a Kotlin String (for a Button title)
  function cexprText(node, scope) { const v = cexpr(node, scope); return v.t === 'string' ? v.c : `(${v.c}).toString()`; }
  // read a cell as a Boolean (bool cells already are; ints compared != 0)
  function cellBoolExpr(cell) { return cell.t === 'bool' ? `s.${cell.name}` : `(s.${cell.name} != 0L)`; }
  // a JSX condition expression coerced to a Kotlin Boolean
  function truthy(node, scope) { const v = cexpr(node, scope); return ktBackend.truthy(v.c, v.t); }

  // ── children loop (map unroll / arr.map / conditionals) — mirrors GTK ──
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
          // const/derived scalar array literal → unroll at build time
          let lit = o.type === 'ArrayExpression' ? o : (o.type === 'Identifier' && derived[o.name] && stripParens(derived[o.name]).type === 'ArrayExpression' ? stripParens(derived[o.name]) : null);
          if (lit && !lit.elements.every((e) => e && e.type !== 'ObjectExpression' && e.type !== 'ArrayExpression')) lit = null;
          if (lit) {
            const p = ex.arguments[0].params; const itN = p[0] ? p[0].name : 'it'; const ixN = p[1] ? p[1].name : null;
            const body = stripParens(ex.arguments[0].body);
            lit.elements.forEach((elm, i) => { if (!elm) return; const v = cexpr(elm, scope); const rs = { ...scope, [itN]: { c: v.c, t: v.t } }; if (ixN) rs[ixN] = { c: String(i), t: 'int' }; const j = jsxOf(body); if (j) build(j, parentVar, rs); });
            continue;
          }
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
  // {arr.map((it,i)=><JSX>)} → a LinearLayout rebuilt from the array cell
  function buildMap(ex, parent, scope, arrName, filterArrow) {
    const cell = cellByName(arrName);
    const itName = ex.arguments[0].params[0] ? ex.arguments[0].params[0].name : 'it';
    const idxParam = ex.arguments[0].params[1] ? ex.arguments[0].params[1].name : null;
    const itemJSX = stripParens(ex.arguments[0].body);
    const box = field(vid('map'), 'LinearLayout');
    P(`  s.${box} = LinearLayout(appCtx); s.${box}!!.orientation = LinearLayout.VERTICAL`);
    if (parent) P(`  ${parent}.addView(s.${box})`);
    out.lists.push({ box, rowFn: `swiss_map_${out.lists.length}`, rebuildFn: `swiss_maprebuild_${out.lists.length}`, itemJSX, itName, idxParam, cell, filterArrow });
    const L = out.lists[out.lists.length - 1];
    const reads = cellsIn(itemJSX); reads.add(cell.name);
    if (filterArrow) cellsIn(filterArrow.body).forEach((c) => reads.add(c));
    reads.forEach((cn) => { if (deps[cn] && !deps[cn].includes(`${L.rebuildFn}(s);`)) deps[cn].push(`${L.rebuildFn}(s);`); });
    return `s.${box}`;
  }
  // inline a presentational component (props in, no own state)
  function inlineComponent(cmp, el, parent, callerScope) {
    const a = attrs(el);
    const scope = {};
    const param = cmp.node.params[0];
    if (param && param.type === 'ObjectPattern') {
      for (const pr of param.properties) {
        const key = pr.key.name, av = a[key];
        scope[key] = av === undefined ? { c: '0L', t: 'int' }
          : av.type === 'JSXExpressionContainer' ? cexpr(av.expression, callerScope)
          : { c: cstr(av.value), t: 'string' };
      }
    } else if (param && param.type === 'Identifier') {
      scope.__props = {};
      for (const k in a) { const av = a[k]; scope.__props[k] = av.type === 'JSXExpressionContainer' ? cexpr(av.expression, callerScope) : { c: cstr(av.value), t: 'string' }; }
    }
    scope.__children = { nodes: el.children, scope: callerScope };
    scope.__parentHorizontal = callerScope.__parentHorizontal;
    const body = cmp.node.body;
    const jsx = body.type === 'BlockStatement' ? (body.body.find((s) => s.type === 'ReturnStatement') || {}).argument : body;
    return build(stripParens(jsx), parent, scope);
  }
  // a built widget must be reachable from the update/effect fns (which only see
  // `s`), so store it in a SwissState field — like GTK's stash().
  const stash = (w) => { const f = field(vid('cond'), 'View'); P(`  s.${f} = ${String(w).replace(/!!$/, '')}`); return `s.${f}!!`; };
  // {cond && <X/>} and {cond ? <A/> : <B/>} → build + reactive visibility (View.GONE)
  function buildCond(expr, parentVar, scope) {
    expr = stripParens(expr);
    if (scope.__inrow) {   // in a rebuilt row → a plain runtime if, no persistent tracking
      if (expr.type === 'LogicalExpression' && expr.operator === '&&') {
        const el = jsxOf(expr.right); if (!el) return;
        P(`  if (${truthy(expr.left, scope)}) {`); build(el, parentVar, scope); P(`  }`); return;
      }
      if (expr.type === 'ConditionalExpression') {
        const ae = jsxOf(expr.consequent), be = jsxOf(expr.alternate);
        if (ae && be) { P(`  if (${truthy(expr.test, scope)}) {`); build(ae, parentVar, scope); P(`  } else {`); build(be, parentVar, scope); P(`  }`); return; }
      }
    }
    if (expr.type === 'LogicalExpression' && expr.operator === '&&') {
      const el = jsxOf(expr.right); if (!el) return;
      const w = stash(build(el, parentVar, scope));
      const snip = `${w}.visibility = if (${truthy(expr.left, scope)}) View.VISIBLE else View.GONE;`;
      out.postShow.push(snip.replace(/;$/, ''));
      cellsIn(expr.left).forEach((cn) => deps[cn].push(snip));
      return;
    }
    if (expr.type === 'ConditionalExpression') {
      const ae = jsxOf(expr.consequent), be = jsxOf(expr.alternate);
      if (ae && be) {
        const wa = stash(build(ae, parentVar, scope)), wb = stash(build(be, parentVar, scope));
        const snip = `run { val _c = (${truthy(expr.test, scope)}); ${wa}.visibility = if (_c) View.VISIBLE else View.GONE; ${wb}.visibility = if (_c) View.GONE else View.VISIBLE };`;
        out.postShow.push(snip.replace(/;$/, ''));
        cellsIn(expr.test).forEach((cn) => deps[cn].push(snip));
        return;
      }
    }
    err('only {cond && <El/>} or {cond ? <A/> : <B/>} JSX expression children are supported', expr);
  }

  // ── list row builders (deferred; each row is a fresh subtree) ──
  function emitLists() {
    for (const L of out.lists) {
      const saved = out.build; out.build = [];
      const idxVar = '_mi';
      const rowScope = { __index: { c: idxVar, t: 'int' }, __indexName: idxVar, __inrow: true, __parentHorizontal: false };
      rowScope[L.itName] = { rec: `s.${L.cell.name}[(${idxVar}).toInt()]`, shape: L.cell.fields };
      if (L.idxParam) rowScope[L.idxParam] = { c: idxVar, t: 'int' };
      let skip = '';
      if (L.filterArrow) {
        const fs = { ...rowScope }; const fp = L.filterArrow.params[0];
        if (fp) fs[fp.name] = { rec: `s.${L.cell.name}[(${idxVar}).toInt()]`, shape: L.cell.fields };
        skip = `    if (!(${cexpr(stripParens(L.filterArrow.body), fs).c})) return null\n`;
      }
      const rootVar = build(stripParens(L.itemJSX), null, rowScope);
      const rowBody = out.build; out.build = saved;
      out.fns.push(`fun ${L.rowFn}(s: SwissState, ${idxVar}: Long): View? {\n${skip}${rowBody.join('\n')}\n  return ${rootVar.replace(/!!$/, '')}\n}`);
      out.fns.push(
        `fun ${L.rebuildFn}(s: SwissState) {\n` +
        `  s.${L.box}?.removeAllViews()\n` +
        `  var ${idxVar} = 0L\n` +
        `  while (${idxVar} < s.${L.cell.name}.size) {\n` +
        `    val _row = ${L.rowFn}(s, ${idxVar})\n` +
        `    if (_row != null) s.${L.box}?.addView(_row)\n` +
        `    ${idxVar}++\n` +
        `  }\n}`
      );
    }
  }

  // ── go ── (same order as GTK: methods, root JSX, lists, effects, inits) ──
  emitMethods();
  const rootVar = build(rootJSX(), null, { __parentHorizontal: false });
  emitLists();

  // useEffect(fn, deps) → fn at startup; re-run on dep-cell change
  const initLines = []; let effN = 0;
  for (const s of comp.body.body)
    walk(s, (n) => {
      if (n.type === 'CallExpression' && n.callee.name === 'useEffect') {
        const id = `swiss_effect_${effN++}`;
        const lines = []; genStmts(n.arguments[0].body, {}, lines);
        out.fns.push(`fun ${id}(s: SwissState) {\n${lines.join('\n')}\n}`);
        initLines.push(`  ${id}(s)`);
        const da = n.arguments[1];
        if (da && da.type === 'ArrayExpression')
          for (const d of da.elements) { const cell = d.type === 'Identifier' ? cellByName(d.name) : null; if (cell) deps[cell.name].push(`${id}(s);`); }
      }
    });

  // non-literal useState inits (e.g. useState(ezy.call(...)))
  const initCellLines = cells.filter((c) => c.initNode).map((c) => `  s.${c.name} = ${cexpr(c.initNode, {}).c}`);
  // object-state inits: per-field from the {…} literal
  for (const c of objectCells)
    if (c.initObj) for (const p of c.initObj.properties) {
      if (p.type === 'SpreadElement' || !p.key) continue;
      const fn = p.key.name || p.key.value;
      initCellLines.push(`  s.${c.name}.${fn} = ${cexpr(p.value, {}).c}`);
    }
  // seed initial array-state elements (useState([{…}, …]))
  for (const c of arrayCells)
    if (c.initArr) for (const el of c.initArr.elements)
      if (el && el.type === 'ObjectExpression') initCellLines.push(`  s.${c.name}.add(${objLit(c, el, {})})`);
  for (const L of out.lists) initLines.push(`  ${L.rebuildFn}(s)`);

  // cell update functions
  for (const c of cells)
    out.updates.push(`fun swissUpdate_${c.name}(s: SwissState) {\n${deps[c.name].map((d) => '  ' + d).join('\n') || '  // no readers'}\n}`);

  // ── assemble the .kt file ──
  const pkg = opts.pkg || 'com.swiss.app';
  const externDecls = [...out.externs].map((f) => {
    const s = sigs[f]; const kt = (t) => ktBackend.type(t);
    if (!s) return `external fun ${f}(): Long`;
    return `external fun ${f}(${s.args.map((t, i) => `a${i}: ${kt(t)}`).join(', ')}): ${kt(s.ret)}`;
  }).join('\n');
  // if the app calls into the Ezy backend, load its JNI .so before any
  // `external fun` runs (emit-app --platform android builds it via the NDK).
  const backendLoader = out.externs.size
    ? '\nprivate val _swissBackend = try { System.loadLibrary("swissbackend"); true } catch (e: Throwable) { false }'
    : '';

  const itemClasses = [...arrayCells, ...objectCells].map((c) =>
    `data class ${c.struct}(${(c.fields.length ? c.fields : [{ name: '_u', ctype: 'Long' }]).map((f) => `var ${f.name}: ${f.ctype} = ${f.ctype === 'String' ? '""' : f.ctype === 'Double' ? '0.0' : f.ctype === 'Boolean' ? 'false' : '0L'}`).join(', ')})`
  ).join('\n');

  const stateDecls = [
    ...cells.map((c) => {
      if (c.t === 'array') return `  val ${c.name}: MutableList<${c.struct}> = mutableListOf()`;
      if (c.t === 'object') return `  var ${c.name}: ${c.struct} = ${c.struct}()`;
      const init = c.cinit != null ? c.cinit : (c.ctype === 'String' ? '""' : c.ctype === 'Double' ? '0.0' : c.ctype === 'Boolean' ? 'false' : '0L');
      return `  var ${c.name}: ${c.ctype} = ${init}`;
    }),
    ...refs.map((r) => `  var ${r.name}__current: ${r.ctype} = ${r.cinit}`),
    ...stateFields,
  ].join('\n');

  return `// Generated by swiss-androidc — do not edit.
package ${pkg}

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.*

${externDecls || '// (no ezy backend calls)'}${backendLoader}

${itemClasses || '// (no record/object state)'}

class SwissState {
${stateDecls || '  // no state'}
}

// ── runtime: Context + swiss* helpers the kt backend and translator emit ──
lateinit var appCtx: Context
private val swissMainHandler = Handler(Looper.getMainLooper())

fun dp(v: Int): Int = (v * appCtx.resources.displayMetrics.density).toInt()
fun swissColor(s: String): Int = try { Color.parseColor(s) } catch (e: Exception) { Color.TRANSPARENT }
fun swissGap(v: LinearLayout, g: Int, horizontal: Boolean) {
  for (i in 1 until v.childCount) {
    val lp = v.getChildAt(i).layoutParams as? LinearLayout.LayoutParams ?: continue
    if (horizontal) lp.leftMargin = g else lp.topMargin = g
    v.getChildAt(i).layoutParams = lp
  }
}
fun swissAlert(msg: String) { AlertDialog.Builder(appCtx).setMessage(msg).setPositiveButton("OK", null).show() }
// NOTE: Android dialogs are async — a blocking confirm() can't return a result
// inline. This shows the dialog and returns 0; wire a callback for real use.
fun swissConfirm(msg: String): Long { AlertDialog.Builder(appCtx).setMessage(msg).setPositiveButton("OK", null).setNegativeButton("Cancel", null).show(); return 0L }
fun swissSetTheme(dark: Long) { /* live re-theme is a documented gap on this target */ }
fun swissPickFolder(): String = ""   // needs the Storage Access Framework (async)
fun swissPickFile(): String = ""
fun swissLoadImage(v: ImageView, src: String) { /* hook a real loader (Glide/Coil) here */ }
fun swissAprintf(fmt: String, vararg args: Any?): String = String.format(fmt, *args)
fun swissSubstr(s: String, a: Long, b: Long): String { val n = s.length.toLong(); var x = if (a < 0) 0 else a; var y = if (b < 0 || b > n) n else b; if (y < x) y = x; return s.substring(x.toInt(), y.toInt()) }
fun swissReplace(s: String, from: String, to: String): String = s.replace(from, to)
fun swissTimerAdd(ms: Long, cb: (SwissState) -> Unit, repeat: Boolean): Long {
  val id = ms   // simple handle; a real impl tracks Runnables for clearing
  val r = object : Runnable { override fun run() { cb(S); if (repeat) swissMainHandler.postDelayed(this, ms) } }
  swissMainHandler.postDelayed(r, ms); return id
}
fun swissTimerClear(id: Long) { /* track+remove the Runnable for a full impl */ }

lateinit var S: SwissState

${cells.map((c) => `fun swissUpdate_${c.name}(s: SwissState)`).length ? '' : ''}${out.fns.join('\n\n')}

${out.updates.join('\n\n')}

fun swissInit(s: SwissState) {
${initCellLines.join('\n') || '  // no non-literal inits'}
}

fun swissBuildUi(s: SwissState): View {
${out.build.join('\n')}
  return ${rootVar.replace(/!!$/, '')}
}

fun swissEffect(s: SwissState) {
${[...out.postShow.map((x) => '  ' + x), ...initLines].join('\n') || '  // no effects'}
}

class MainActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    appCtx = this
    S = SwissState()
    swissInit(S)
    val root = swissBuildUi(S)
    root.setBackgroundColor(swissColor(${cstr(col('bg'))}))
    val scroll = ScrollView(this)
    scroll.addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    setContentView(scroll)
    swissEffect(S)
  }
}
`;
}

function main() {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith('--'));
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'MainActivity.kt';
  const pkg = args.includes('--pkg') ? args[args.indexOf('--pkg') + 1] : 'com.swiss.app';
  let sigs = {};
  if (args.includes('--sig') && existsSync(args[args.indexOf('--sig') + 1])) sigs = JSON.parse(readFileSync(args[args.indexOf('--sig') + 1], 'utf8'));
  if (!input) { console.error('usage: swiss-androidc <App.jsx> --out MainActivity.kt [--pkg com.x.y] [--sig sig.json]'); process.exit(1); }
  const ast = parse(readFileSync(input, 'utf8'));
  writeFileSync(out, emit(ast, { pkg, sigs }));
  console.error(`swiss-androidc: ${input} → ${out}`);
}
main();
