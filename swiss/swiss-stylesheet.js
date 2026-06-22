// Swiss StyleSheet — platform-agnostic style objects.
//
// StyleSheet.create({...}) returns the styles unchanged (RN-compatible). Each
// target interprets the same keys: web maps them to CSS here; a native target
// maps them to widget props. Keep keys to the RN-ish layout/appearance subset
// so they port.
export const StyleSheet = {
  create: (sheet) => sheet,
  // merge an array of style objects (or a single one) into one
  flatten: (s) => (Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean)) : s || {}),
};

// numeric values for these CSS props get "px" appended on web.
const PX = new Set([
  'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'paddingHorizontal', 'paddingVertical',
  'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'marginHorizontal', 'marginVertical',
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'top', 'bottom', 'left', 'right', 'gap',
  'fontSize', 'borderWidth', 'borderRadius',
  'borderTopWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRightWidth',
]);

// RN shorthands that expand to two CSS props.
const EXPAND = {
  paddingHorizontal: (v) => ({ paddingLeft: v, paddingRight: v }),
  paddingVertical: (v) => ({ paddingTop: v, paddingBottom: v }),
  marginHorizontal: (v) => ({ marginLeft: v, marginRight: v }),
  marginVertical: (v) => ({ marginTop: v, marginBottom: v }),
};

function put(out, key, val) {
  if (typeof val === 'number' && PX.has(key)) out[key] = val + 'px';
  else out[key] = val;
}

// turn a Swiss/RN style object into a DOM-assignable CSS object.
export function styleToCss(style) {
  const s = StyleSheet.flatten(style);
  const out = {};
  for (const key in s) {
    const val = s[key];
    if (EXPAND[key]) {
      const pair = EXPAND[key](val);
      for (const k in pair) put(out, k, pair[k]);
    } else {
      put(out, key, val);
    }
  }
  return out;
}

export default StyleSheet;
