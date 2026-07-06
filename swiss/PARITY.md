# Swiss target parity

One JSX/React frontend → many native targets. This table is the contract: a
feature is "done" only when it behaves the same on every shipping target. Keep
it honest — if a target fakes or drops a feature, mark it, don't hide it.

Targets: **web** (React + react-reconciler + DOM), **gtk** (JSX→C, GTK3),
**win32** (JSX→C, Win32/GDI+), **android** (JSX→Kotlin, android.widget Views).
macOS/iOS are planned, not here yet.

> **android status**: `swiss emit-app --platform android` produces a complete
> Gradle project — `swiss-androidc.mjs` translates the JSX to Kotlin (through the
> decoupled core + `swiss-kt-backend.mjs`), and if the app calls `ezy.call` the
> backend is emitted to C + a JNI bridge built by the NDK. The regression harness
> emit-checks every case to android (the `.kt` is produced). What's NOT yet in
> CI is the final `./build.sh` (Gradle `assembleDebug`) — that needs the Android
> SDK on the runner. So treat android ✅ as "emitted + reviewed + harness-checked",
> not "APK compiled in CI".

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

1. **android: compile the APK in CI** — `emit-app --platform android` (Gradle
   project + AndroidManifest + JNI + `build.sh`) is wired and the harness
   emit-checks it; the missing piece is running `./build.sh` (Gradle
   `assembleDebug`) on a runner with the Android SDK, the way gtk/win32 run
   `cc`/MinGW. Until an SDK is on CI, android stops at emit-check.
2. **Stateful child inside `.map`** — a static child instance gets isolated
   state; a dynamic list can't be statically allocated. Emits a clear error.
3. **android: flex-wrap / absolute / overflow:hidden / linear-gradient /
   live re-theme / reactive style** — present on gtk+win32, not yet on android.
4. **`.map` over const object arrays** — needs per-item record-shape inference.

Resolved: android target (core widget set, reactive state, effects, stateful
child inline, `.map`); Kotlin backend + truthiness/Long-literal coercion in the
core; stateful child components; `.map` over const scalar arrays; useEffect.

## How parity is enforced

`tests/run.sh [targets]` emits every `tests/cases/*.jsx` to each target: gtk C,
Win32 C and the web bundle are **compiled**; android is **emit-checked** (the
`.kt` is produced — no Android SDK on CI, see gap #1). A change that breaks any
target fails the run before it ships. Baseline: **44/44 green**
(linux+windows+web+android × 11 cases).
