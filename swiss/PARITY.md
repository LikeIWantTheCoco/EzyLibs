# Swiss target parity

One JSX/React frontend → many native targets. This table is the contract: a
feature is "done" only when it behaves the same on every shipping target. Keep
it honest — if a target fakes or drops a feature, mark it, don't hide it.

Targets: **web** (React + react-reconciler + DOM), **gtk** (JSX→C, GTK3),
**win32** (JSX→C, Win32/GDI+), **android** (JSX→Kotlin, android.widget Views).
macOS/iOS are planned, not here yet.

> **android status**: the translator (`swiss-androidc.mjs`) emits Kotlin through
> the decoupled core + `swiss-kt-backend.mjs`. Output is structurally complete
> for the ✅ rows below and shaped to compile, but it is **not yet verified
> against the Android SDK** (no `emit-app --platform android` gradle harness
> yet) — unlike gtk/win32, which the regression harness compiles. Treat android
> ✅ as "emitted + reviewed", not "compiled in CI".

Legend: ✅ full · 🟡 partial (see note) · ❌ not yet · — n/a

## React / language

| Feature                            | web | gtk | win32 | android | Notes |
|------------------------------------|-----|-----|-------|---------|-------|
| `useState` (int/float/bool/string) | ✅  | ✅  | ✅   | ✅     | android: bool→Boolean, ints→Long |
| `useState` array / object          | ✅  | ✅  | ✅   | 🟡     | android: emitted (data class + MutableList), SDK-unverified |
| `useEffect` (mount + deps)         | ✅  | ✅  | ✅   | ✅     | runs at startup + on dep-cell change |
| `useMemo`                          | ✅  | ✅  | ✅   | ✅     | recomputed on dep change |
| `useCallback`                      | ✅  | ✅  | ✅   | ✅     | treated as a method |
| `useRef` (value / node)            | ✅  | ✅  | ✅   | ✅     | |
| Derived `const` (inlined)          | ✅  | ✅  | ✅   | ✅     | follows through to dep tracking |
| Conditional child `{c && <E/>}`    | ✅  | ✅  | ✅   | ✅     | android: reactive View.GONE |
| Ternary child `{c ? <A/> : <B/>}`  | ✅  | ✅  | ✅   | ✅     | |
| `.map` over state array            | ✅  | ✅  | ✅   | 🟡     | android: LinearLayout rebuilt on change (SDK-unverified) |
| `.filter(...).map(...)`            | ✅  | ✅  | ✅   | 🟡     | |
| `.map` over const/scalar array     | ✅  | ✅  | ✅   | ✅     | unrolled at build time |
| `.map` over const **object** array | ✅  | ❌  | ❌   | ❌     | native needs per-item record shape |
| Custom components (presentational) | ✅  | ✅  | ✅   | ✅     | inlined; props in, no own state |
| Custom components (**stateful**)   | ✅  | ✅  | ✅   | ✅     | static positions; each instance isolated (α-renamed) |
| Stateful child inside `.map`       | ✅  | ❌  | ❌   | ❌     | native can't statically alloc per-row state → hard error |
| Stateful child `props` (bare param)| ✅  | ❌  | ❌   | ❌     | native needs destructured `{ }` props → hard error |

## Layout

| Feature                    | web | gtk | win32 | android | Notes |
|----------------------------|-----|-----|-------|---------|-------|
| flex column / row          | ✅  | ✅  | ✅   | ✅     | LinearLayout orientation |
| gap                        | ✅  | ✅  | ✅   | ✅     | android: per-child margin (swissGap) |
| padding / margin           | ✅  | ✅  | ✅   | ✅     | |
| width / height / min / max | ✅  | ✅  | ✅   | 🟡     | android: width/height + 100%/flex; min/max collapse to width |
| flex-wrap                  | ✅  | ✅  | ✅   | ❌     | android: no FlexboxLayout yet |
| position: absolute + zIndex| ✅  | ✅  | ✅   | ❌     | android: needs a FrameLayout overlay path |
| overflow: hidden           | ✅  | ✅  | ✅   | ❌     | |
| overflow: scroll / auto    | ✅  | 🟡  | 🟡   | 🟡     | android: root + `<ScrollView>` only |

## Style

| Feature                     | web | gtk | win32 | android | Notes |
|-----------------------------|-----|-----|-------|---------|-------|
| backgroundColor / color     | ✅  | ✅  | ✅   | ✅     | |
| borderRadius                | ✅  | ✅  | ✅   | ✅     | android: GradientDrawable |
| border (shorthand + sides)  | ✅  | ✅  | ✅   | 🟡     | android: uniform stroke only |
| fontSize / fontWeight       | ✅  | ✅  | ✅   | ✅     | bold/italic via Typeface |
| opacity                     | ✅  | ✅  | ✅   | ✅     | View.alpha |
| linear-gradient background  | ✅  | ✅  | ✅   | ❌     | android: solid fill only for now |
| Semantic theme tokens       | ✅  | ✅  | ✅   | 🟡     | android: resolved to the light palette at build time |
| Light / dark mode           | ✅  | ✅  | ✅   | ❌     | android: no live re-theme yet |
| Reactive style (color/bg)   | ✅  | ✅  | ✅   | ❌     | android: not wired |
| Reactive layout/radius/etc. | ✅  | ✅  | ✅   | ❌     | |
| CSS transitions             | ✅  | ✅  | ✅   | ❌     | |
| :hover                      | ✅  | ✅  | ✅   | —      | android: touch, no hover |

## Widgets

| Widget       | web | gtk | win32 | android | Notes |
|--------------|-----|-----|-------|---------|-------|
| View / Text  | ✅  | ✅  | ✅   | ✅     | LinearLayout / TextView |
| Button       | ✅  | ✅  | ✅   | ✅     | isAllCaps=false (flat, web-like) |
| Input        | ✅  | ✅  | ✅   | ✅     | EditText, placeholder=hint |
| Checkbox     | ✅  | ✅  | ✅   | ✅     | |
| Switch       | ✅  | ✅  | ✅   | ✅     | |
| Slider       | ✅  | ✅  | ✅   | ✅     | SeekBar |
| Select       | ✅  | ✅  | ✅   | ✅     | Spinner + ArrayAdapter |
| TextArea     | ✅  | ✅  | ✅   | ✅     | EditText multiline |
| ProgressBar  | ✅  | ✅  | ✅   | ✅     | horizontal style |
| Image        | ✅  | ✅  | ✅   | 🟡     | android: ImageView; loader hook is a stub |
| Separator    | ✅  | ✅  | ✅   | ✅     | 1dp View |
| Tabs         | —   | ✅  | ✅   | ❌     | android: no ViewPager/TabLayout yet |

## Known native-only gaps (priority order)

1. **android: compile against the SDK** — wire `emit-app --platform android`
   (gradle project + AndroidManifest + `build.sh`) so the harness compiles the
   emitted Kotlin, the way it compiles gtk/win32. Until then android is
   emit-and-review only.
2. **Stateful child inside `.map`** — a static child instance gets isolated
   state; a dynamic list can't be statically allocated. Emits a clear error.
3. **android: flex-wrap / absolute / overflow:hidden / linear-gradient /
   live re-theme / reactive style** — present on gtk+win32, not yet on android.
4. **`.map` over const object arrays** — needs per-item record-shape inference.

Resolved: android target (core widget set, reactive state, effects, stateful
child inline, `.map`); Kotlin backend + truthiness/Long-literal coercion in the
core; stateful child components; `.map` over const scalar arrays; useEffect.

## How parity is enforced

`tests/run.sh` emits every `tests/cases/*.jsx` to each target and compiles it
(GTK C, Win32 C, web bundle). A change that breaks any target fails the run
before it ships. Baseline: **33/33 green** (linux+windows+web × 11 cases).
Android is emitted + reviewed but not in the compile matrix yet (see gap #1).
