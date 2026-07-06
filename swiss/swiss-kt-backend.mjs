// swiss-kt-backend — the Kotlin code-generation backend for the shared front-end.
//
// Mirror of swiss-c-backend, method-for-method, so it can diff cleanly. The
// core (swiss-jsx-core) owns all AST analysis + semantics and asks a backend to
// spell each leaf. This backend spells Kotlin, retargeting the SAME core at
// Android. A widget translator (swiss-androidc.mjs, like swiss-gtkc.mjs) plugs
// this in via `opts.backend`.
//
// State model assumed on the Kotlin side: a `SwissState` object whose cells are
// mutable fields (`var`), lists are `MutableList<T>`, refs are `<name>__current`
// fields, and a Kotlin runtime provides the swiss* helpers (swissAlert,
// swissConcat-equivalent via `+`, swissUpdate_<cell>, swissTimerAdd, …).
//
// ── Known C-shaped leaks in the backend interface (need core work for a
//    production Kotlin target; handled best-effort here + noted inline):
//   1. Truthiness: the core, being C-shaped, uses a bool/Long cell directly in
//      a condition. Kotlin conditions demand Boolean. bool is mapped to Boolean
//      here; any site where the core feeds a non-Boolean into a condition would
//      need a core-side coercion hook. Flagged where it bites.
//   2. C-style `for(init;test;update)`: Kotlin has no header for-loop. Emitted
//      as `init` + `while(test){ … update }` via a small block-kind stack.
//   3. `switch/case/break` → Kotlin `when`: no fallthrough, arms are blocks.
//      Translated best-effort; a `break` used to end a case early from inside a
//      nested `if` can't map cleanly (documented).
//
// Every method returns a string of Kotlin code (expression fragment or a full
// statement line, 2-space indented — flat, like the C backend). `kstr` quotes.
export function kstr(s) {
  return '"' + String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')     // Kotlin string interpolation sigil
    .replace(/\n/g, '\\n') + '"';
}

// value → String / Long coercion helpers (Kotlin-specific)
const asStr = (x) => x.t === 'string' ? x.c : `(${x.c}).toString()`;
const asNum = (x) => x.t === 'string' ? `(${x.c}).toLong()` : `((${x.c}).toLong())`;

export const ktBackend = {
  name: 'kt',

  // small stack so C-style for-loops and switch/when close correctly.
  // pushed by every block-opener, popped by blockClose. Fresh per process.
  _blocks: [],

  // ── types ──
  type: (t) => (t === 'float' ? 'Double' : t === 'string' ? 'String' : t === 'bool' ? 'Boolean' : t === 'void' ? 'Unit' : 'Long'),
  localType(t) { return this.type(t); },     // Kotlin bool already Boolean via type()
  strLit: (s) => kstr(s),
  boolLit: (v) => (v ? 'true' : 'false'),
  // integer literals must be Long (cells are Long); Kotlin won't widen an Int
  // *expression* to Long, so spell every integer literal with the L suffix.
  numLit: (v) => (Number.isInteger(v) ? `${v}L` : String(v)),
  // Kotlin conditions demand a real Boolean — coerce a non-bool test value.
  truthy: (code, t) => (t === 'bool' ? code : t === 'string' ? `(${code}).isNotEmpty()` : t === 'float' ? `(${code} != 0.0)` : `(${code} != 0L)`),
  nullRef: () => 'null',

  // ── value access ──
  stateRead: (name) => `s.${name}`,
  stateLValue: (name) => `s.${name}`,
  refRead: (name) => `s.${name}__current`,
  refLValue: (name) => `s.${name}__current`,
  snapRead: (name) => `_snap_${name}`,
  field: (recvCode, name) => `${recvCode}.${name}`,
  arrLen: (arrName) => `s.${arrName}.size.toLong()`,
  arrElem: (arrName, iVar) => `s.${arrName}[(${iVar}).toInt()]`,   // Kotlin list index is Int
  strLen: (code) => `${code}.length.toLong()`,

  // ── operators ──
  ternary: (t, a, b) => `(if (${t}) ${a} else ${b})`,
  not: (a) => `(!${a})`,
  neg: (a) => `(-${a})`,
  and: (l, r) => `(${l} && ${r})`,
  or: (l, r) => `(${l} || ${r})`,
  coalesce: (l, r) => `(${l} ?: ${r})`,        // null-coalesce; C used truthiness
  binary: (op, l, r) => `(${l} ${op} ${r})`,
  concat: (l, r) => `(${asStr(l)} + ${asStr(r)})`,
  strCmp: (l, r, op) => `(${l.c} ${op} ${r.c})`,   // Kotlin String is Comparable: <,>,<=,>=,==,!=
  pow: (l, r) => `(Math.pow((${l.c}).toDouble(), (${r.c}).toDouble()).toLong())`,
  // count of arr.filter(pred).length — predCode uses arrElem(name, iVar)
  filterCount: (arrName, iVar, predCode) => `(run { var _c = 0L; for (${iVar} in 0 until s.${arrName}.size) { if (${predCode}) _c++ }; _c })`,

  // ── template / conversion ──
  template(quasis, exprs) {   // quasis: string[], exprs: {c,t}[] interleaved
    let out = '"';
    quasis.forEach((q, i) => {
      out += q.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\n/g, '\\n');
      if (i < exprs.length) out += '${' + exprs[i].c + '}';   // Kotlin toString; %g float formatting is lost
    });
    return out + '"';
  },
  toStr: (x) => asStr(x),
  toInt: (x) => asNum(x),
  toNum: (x) => x.t === 'string' ? `(${x.c}).toLong()` : `(${x.c})`,   // Number(x)
  toFloat: (x) => x.t === 'string' ? `(${x.c}).toDouble()` : `((${x.c}).toDouble())`,
  strFrom: (x) => `(${x.c}).toString()`,   // str(n)

  // ── runtime helper calls ──
  trim: (r) => `${r}.trim()`,
  upper: (r) => `${r}.uppercase()`,
  lower: (r) => `${r}.lowercase()`,
  includes: (r, a) => `${r}.contains(${a})`,
  startsWith: (r, a) => `${r}.startsWith(${a})`,
  endsWith: (r, a) => `${r}.endsWith(${a})`,
  indexOf: (r, a) => `${r}.indexOf(${a}).toLong()`,
  substr: (r, a, b) => `swissSubstr(${r}, ${a}, ${b || '-1'})`,   // runtime helper (C swiss_substr semantics)
  replace: (r, a, b) => `swissReplace(${r}, ${a}, ${b})`,         // runtime helper (C swiss_replace semantics)
  mathCall(name, argCodes) {
    const mm = { floor: 'floor', ceil: 'ceil', round: 'rint', abs: 'abs', sqrt: 'sqrt', pow: 'pow', min: 'min', max: 'max' }[name];
    if (mm) return `(Math.${mm}(${argCodes.map((x) => `(${x}).toDouble()`).join(', ')}).toLong())`;
    if (name === 'random') return `(Math.random())`;
    return null;
  },
  alert: (msgCode) => `swissAlert(${msgCode})`,
  confirm: (msgCode) => `swissConfirm(${msgCode})`,
  setTheme: (code) => `swissSetTheme(${code})`,
  pickFolder: () => `swissPickFolder()`,
  pickFile: () => `swissPickFile()`,
  consoleNoop: () => `Unit`,
  ezyCall: (fn, argCodes) => `${fn}(${argCodes.join(', ')})`,
  timerAdd: (delayCode, id, repeat) => `swissTimerAdd(${delayCode}, ::${id}, ${repeat ? 'true' : 'false'})`,
  timerClear: (code) => `swissTimerClear(${code})`,

  // ── statements (each returns one line, 2-space indent) ──
  // Semicolons are appended even though Kotlin makes them optional: the core
  // concatenates two statements on one line in a couple of spots (handlerBody,
  // the memo recompute), and Kotlin needs a `;` between them there.
  declStmt: (type, name, valCode) => `  var ${name}: ${type} = ${valCode};`,
  ifOpen(condCode) { this._blocks.push(null); return `  if (${condCode}) {`; },
  elseOpen: () => '  } else {',                 // stays within the same if-frame
  blockClose() {
    const b = this._blocks.pop();
    if (b && b.when) { const pre = b.armOpen ? '  }\n' : ''; return `${pre}  }`; }
    if (b && b.update) return `  ${b.update};\n  }`;   // C-style for: emit the update, then close
    return '  }';
  },
  // In a `when` arm a source `break` is redundant (no fallthrough) → drop it.
  // In a real loop it's a Kotlin `break`. Disambiguate via the block stack.
  breakStmt() {
    const top = this._blocks[this._blocks.length - 1];
    return (top && top.when) ? '' : '  break;';
  },
  continueStmt: () => '  continue;',
  switchOpen(discCode) { this._blocks.push({ when: true, armOpen: false }); return `  when (${discCode}) {`; },
  caseLabel(testCode) {
    const f = this._blocks[this._blocks.length - 1];
    const pre = (f && f.armOpen) ? '  }\n' : '';   // close previous arm
    if (f) f.armOpen = true;
    return `${pre}    ${testCode == null ? 'else' : testCode} -> {`;
  },
  whileOpen(condCode) { this._blocks.push(null); return `  while (${condCode}) {`; },
  // C-style for → init line + while; the update is stashed and emitted at blockClose.
  forOpen(initCode, testCode, updateCode) { this._blocks.push({ update: updateCode }); return `  ${initCode}\n  while (${testCode}) {`; },
  forInit: (name, valCode) => `var ${name} = ${valCode}`,
  assignStmt: (lvCode, op, valCode) => `  ${lvCode} ${op} ${valCode};`,
  updateStmt: (lvCode, op) => `  ${lvCode}${op};`,
  exprStmt: (code) => `  ${code};`,
  updateCall: (name) => `swissUpdate_${name}(s);`,
  updateCallStmt(name) { return `  ${this.updateCall(name)}`; },
  setCellStmt(name, valCode) { return `  ${this.stateLValue(name)} = ${valCode};`; },
  setFieldStmt: (cellName, field, valCode) => `  s.${cellName}.${field} = ${valCode};`,   // Kotlin strings immutable — no strdup
  snapDecl(t, name) { return `  val _snap_${name}: ${this.localType(t)} = s.${name};`; },
  strDup: (code) => `(${code})`,   // no-op in Kotlin

  // object / array state
  objLiteral: (struct, fieldInits) => `${struct}(${fieldInits.join(', ')})`,   // data class ctor, named args
  objFieldInit: (field, valCode, isStr, present) => present ? `${field} = ${valCode}` : `${field} = ${isStr ? '""' : '0L'}`,
  arrClear: (name) => `  s.${name}.clear();`,
  arrPush: (name, objLitCode) => `  s.${name}.add(${objLitCode});`,
  arrFilterInPlace: (name, iVar, predCode) => `  run { val _keep = ArrayList(s.${name}); s.${name}.clear(); for (${iVar} in 0 until _keep.size) { if (${predCode.replace(new RegExp(`s\\.${name}\\[`, 'g'), '_keep[')}) s.${name}.add(_keep[(${iVar}).toInt()]) } };`,

  // fn/method definitions
  methodDecl: (name, params, bodyLines) => `fun method_${name}(s: SwissState${params.length ? ', ' + params.map((p) => `${p}: Long`).join(', ') : ''}) {\n${bodyLines.join('\n')}\n}`,
  methodCall: (name, argCodes) => `  method_${name}(s${argCodes.length ? ', ' + argCodes.join(', ') : ''});`,
  timerFn: (id, bodyLines) => `fun ${id}(s: SwissState) {\n${bodyLines.join('\n')}\n}`,
};

export default ktBackend;
