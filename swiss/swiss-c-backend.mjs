// swiss-c-backend — the C code-generation backend for the shared front-end.
//
// swiss-jsx-core owns the AST analysis and the semantics (which cells exist,
// what an expression's type is, when a list rebuilds). It owns *no syntax*: it
// asks a backend to spell each leaf. This file is that backend for C (used by
// the GTK and Win32 translators). A Kotlin/Swift backend implements the same
// surface to retarget the SAME core at Android/iOS — the core never changes.
//
// Every method returns a string of target code (expression fragment or a full
// statement line). The core handles all bookkeeping (externs, fn tables, uids,
// dep tracking); the backend only spells things. `cstr` quotes a string literal.
export function cstr(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

// numeric cast helpers (printf-style, C-specific)
const asStr = (x) => x.t === 'string' ? x.c : x.t === 'float' ? `swiss_aprintf("%g", (double)(${x.c}))` : `swiss_aprintf("%lld", (long long)(${x.c}))`;
const asNum = (x) => x.t === 'string' ? `atoll(${x.c})` : `((long long)${x.c})`;

export const cBackend = {
  name: 'c',
  // ── types ──
  type: (t) => (t === 'float' ? 'double' : t === 'string' ? 'const char*' : t === 'void' ? 'void' : 'long long'),
  localType(t) { return this.type(t === 'bool' ? 'int' : t); },   // a local/snapshot var's declared type
  strLit: (s) => cstr(s),
  boolLit: (v) => (v ? '1' : '0'),
  numLit: (v) => String(v),                 // numeric literal (C: as-is)
  truthy: (code, t) => code,                // coerce to a boolean test — C: identity (any scalar is a truth value)
  nullRef: () => 'NULL',

  // ── value access ──
  stateRead: (name) => `s->${name}`,
  stateLValue: (name) => `s->${name}`,
  refRead: (name) => `s->${name}__current`,
  refLValue: (name) => `s->${name}__current`,
  snapRead: (name) => `_snap_${name}`,
  field: (recvCode, name) => `${recvCode}.${name}`,          // record/object field
  arrLen: (arrName) => `s->${arrName}.len`,
  arrElem: (arrName, iVar) => `s->${arrName}.data[${iVar}]`,
  strLen: (code) => `((long long)strlen(${code}))`,

  // ── operators ──
  ternary: (t, a, b) => `(${t} ? ${a} : ${b})`,
  not: (a) => `(!${a})`,
  neg: (a) => `(-${a})`,
  and: (l, r) => `(${l} && ${r})`,
  or: (l, r) => `(${l} || ${r})`,
  coalesce: (l, r) => `(${l} ? ${l} : ${r})`,
  binary: (op, l, r) => `(${l} ${op} ${r})`,
  concat: (l, r) => `swiss_concat(${asStr(l)}, ${asStr(r)})`,
  strCmp: (l, r, op) => `(strcmp(${l.c}, ${r.c}) ${op} 0)`,
  pow: (l, r) => `((long long)pow((double)(${l.c}), (double)(${r.c})))`,
  // count of arr.filter(pred).length — a GCC statement-expression
  filterCount: (arrName, iVar, predCode) => `({ long long _c = 0; for (long long ${iVar} = 0; ${iVar} < s->${arrName}.len; ${iVar}++) if (${predCode}) _c++; _c; })`,

  // ── template / conversion ──
  template(quasis, exprs) {   // quasis: string[], exprs: {c,t}[] interleaved
    let fmt = ''; const args = [];
    quasis.forEach((q, i) => {
      fmt += q.replace(/%/g, '%%');
      if (i < exprs.length) {
        const e = exprs[i];
        fmt += e.t === 'string' ? '%s' : e.t === 'float' ? '%g' : '%lld';
        args.push(e.t === 'string' ? e.c : e.t === 'float' ? `(double)(${e.c})` : `(long long)(${e.c})`);
      }
    });
    return `swiss_aprintf(${cstr(fmt)}${args.length ? ', ' + args.join(', ') : ''})`;
  },
  toStr: (x) => asStr(x),
  toInt: (x) => asNum(x),
  toNum: (x) => x.t === 'string' ? `atoll(${x.c})` : `(${x.c})`,   // Number(x)
  toFloat: (x) => x.t === 'string' ? `atof(${x.c})` : `((double)${x.c})`,
  strFrom: (x) => `swiss_aprintf("%lld", (long long)(${x.c}))`,   // str(n)

  // ── runtime helper calls ──
  trim: (r) => `swiss_trim(${r})`,
  upper: (r) => `swiss_upper(${r})`,
  lower: (r) => `swiss_lower(${r})`,
  includes: (r, a) => `(strstr(${r}, ${a}) != NULL)`,
  startsWith: (r, a) => `swiss_startswith(${r}, ${a})`,
  endsWith: (r, a) => `swiss_endswith(${r}, ${a})`,
  indexOf: (r, a) => `swiss_indexof(${r}, ${a})`,
  substr: (r, a, b) => `swiss_substr(${r}, ${a}, ${b || '-1'})`,
  replace: (r, a, b) => `swiss_replace(${r}, ${a}, ${b})`,
  mathCall(name, argCodes) {
    const mm = { floor: 'floor', ceil: 'ceil', round: 'round', abs: 'fabs', sqrt: 'sqrt', pow: 'pow', min: 'fmin', max: 'fmax' }[name];
    if (mm) return `((long long)${mm}(${argCodes.map((x) => `(double)(${x})`).join(', ')}))`;
    if (name === 'random') return `(rand() / (double)RAND_MAX)`;
    return null;
  },
  alert: (msgCode) => `swiss_alert(${msgCode})`,
  confirm: (msgCode) => `swiss_confirm(${msgCode})`,
  setTheme: (code) => `swiss_set_theme(${code})`,
  pickFolder: () => `swiss_pick_folder()`,
  pickFile: () => `swiss_pick_file()`,
  consoleNoop: () => `((void)0)`,
  ezyCall: (fn, argCodes) => `${fn}(${argCodes.join(', ')})`,
  timerAdd: (delayCode, id, repeat) => `swiss_timer_add(${delayCode}, ${id}, ${repeat ? '1' : '0'})`,
  timerClear: (code) => `swiss_timer_clear(${code})`,

  // ── statements (each returns one line, with leading indent + terminator) ──
  declStmt: (type, name, valCode) => `  ${type} ${name} = ${valCode};`,
  ifOpen: (condCode) => `  if (${condCode}) {`,
  elseOpen: () => '  } else {',
  blockClose: () => '  }',
  breakStmt: () => '  break;',
  continueStmt: () => '  continue;',
  switchOpen: (discCode) => `  switch (${discCode}) {`,
  caseLabel: (testCode) => (testCode == null ? '  default:' : `  case ${testCode}:`),
  whileOpen: (condCode) => `  while (${condCode}) {`,
  forOpen: (initCode, testCode, updateCode) => `  for (${initCode}; ${testCode}; ${updateCode}) {`,
  forInit: (name, valCode) => `long long ${name} = ${valCode}`,
  assignStmt: (lvCode, op, valCode) => `  ${lvCode} ${op} ${valCode};`,
  updateStmt: (lvCode, op) => `  ${lvCode}${op};`,
  exprStmt: (code) => `  ${code};`,
  updateCall: (name) => `swiss_update_${name}(s);`,
  updateCallStmt(name) { return `  ${this.updateCall(name)}`; },
  setCellStmt(name, valCode) { return `  ${this.stateLValue(name)} = ${valCode};`; },
  setFieldStmt: (cellName, field, valCode, isStr) => `  s->${cellName}.${field} = ${isStr ? `swiss_strdup(${valCode})` : valCode};`,
  snapDecl(t, name) { return `  ${this.localType(t)} _snap_${name} = s->${name};`; },
  strDup: (code) => `swiss_strdup(${code})`,

  // object / array state
  objLiteral: (struct, fieldInits) => `(${struct}){ ${fieldInits.join(', ')} }`,
  objFieldInit: (field, valCode, isStr, present) => present ? `.${field} = ${isStr ? `swiss_strdup(${valCode})` : valCode}` : `.${field} = ${isStr ? '""' : '0'}`,
  arrClear: (name) => `  s->${name}.len = 0;`,
  arrPush: (name, objLitCode) => `  arrpush_${name}(&s->${name}, ${objLitCode});`,
  arrFilterInPlace: (name, iVar, predCode) => `  { long long _w = 0; for (long long ${iVar} = 0; ${iVar} < s->${name}.len; ${iVar}++) { if (${predCode}) s->${name}.data[_w++] = s->${name}.data[${iVar}]; } s->${name}.len = _w; }`,

  // fn/method definitions
  methodDecl: (name, params, bodyLines) => `static void method_${name}(SwissState* s${params.length ? ', ' + params.map((p) => `long long ${p}`).join(', ') : ''}) {\n${bodyLines.join('\n')}\n}`,
  methodCall: (name, argCodes) => `  method_${name}(s${argCodes.length ? ', ' + argCodes.join(', ') : ''});`,
  timerFn: (id, bodyLines) => `static void ${id}(SwissState* s) {\n  (void)s;\n${bodyLines.join('\n')}\n}`,
};

export default cBackend;
