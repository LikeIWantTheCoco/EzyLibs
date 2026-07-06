# Swiss target parity

One JSX/React frontend → many native targets. This table is the contract: a
feature is "done" only when it behaves the same on every shipping target. Keep
it honest — if a target fakes or drops a feature, mark it, don't hide it.

Targets: **web** (React + react-reconciler + DOM), **gtk** (JSX→C, GTK3),
**win32** (JSX→C, Win32/GDI+). macOS/iOS/Android are planned, not here yet.

Legend: ✅ full · 🟡 partial (see note) · ❌ not yet · — n/a

## React / language

| Feature                            | web | gtk | win32 | Notes |
|------------------------------------|-----|-----|-------|-------|
| `useState` (int/float/bool/string) | ✅  | ✅  | ✅   | |
| `useState` array / object          | ✅  | ✅  | ✅   | records: fixed shape inferred at build |
| `useEffect` (mount + deps)         | ✅  | ✅  | ✅   | runs at startup + on dep-cell change |
| `useMemo`                          | ✅  | ✅  | ✅   | recomputed on dep change |
| `useCallback`                      | ✅  | ✅  | ✅   | treated as a method |
| `useRef` (value / node)            | ✅  | ✅  | ✅   | |
| Derived `const` (inlined)          | ✅  | ✅  | ✅   | follows through to dep tracking |
| Conditional child `{c && <E/>}`    | ✅  | ✅  | ✅   | |
| Ternary child `{c ? <A/> : <B/>}`  | ✅  | ✅  | ✅   | |
| `.map` over state array            | ✅  | ✅  | ✅   | box rebuilt on array change |
| `.filter(...).map(...)`            | ✅  | ✅  | ✅   | |
| `.map` over const/scalar array     | ✅  | ✅  | ✅   | unrolled at build time |
| `.map` over const **object** array | ✅  | ❌  | ❌   | native needs per-item record shape |
| Custom components (presentational) | ✅  | ✅  | ✅   | inlined; props in, no own state |
| Custom components (**stateful**)   | ✅  | ✅  | ✅   | static positions; each instance gets isolated state (α-renamed) |
| Stateful child inside `.map`       | ✅  | ❌  | ❌   | native can't statically alloc per-row state → hard error |
| Stateful child `props` (bare param)| ✅  | ❌  | ❌   | native needs destructured `{ }` props → hard error |

## Layout

| Feature                    | web | gtk | win32 | Notes |
|----------------------------|-----|-----|-------|-------|
| flex column / row          | ✅  | ✅  | ✅   | View default = column (RN/Yoga) |
| gap                        | ✅  | ✅  | ✅   | |
| padding / margin           | ✅  | ✅  | ✅   | border-box everywhere |
| width / height / min / max | ✅  | ✅  | ✅   | |
| flex-wrap                  | ✅  | ✅  | ✅   | gtk GtkFlowBox; win32 arrange path |
| position: absolute + zIndex| ✅  | ✅  | ✅   | gtk GtkOverlay; win32 z-order arrange |
| overflow: hidden           | ✅  | ✅  | ✅   | gtk cairo clip; win32 RoundRectRgn |
| overflow: scroll / auto    | ✅  | 🟡  | 🟡   | native: basic scroll only |

## Style

| Feature                     | web | gtk | win32 | Notes |
|-----------------------------|-----|-----|-------|-------|
| backgroundColor / color     | ✅  | ✅  | ✅   | |
| borderRadius                | ✅  | ✅  | ✅   | |
| border (shorthand + sides)  | ✅  | ✅  | ✅   | |
| fontSize / fontWeight       | ✅  | ✅  | ✅   | |
| opacity                     | ✅  | ✅  | ✅   | |
| linear-gradient background  | ✅  | ✅  | ✅   | win32 GDI+; gtk CSS |
| Semantic theme tokens       | ✅  | ✅  | ✅   | bg/surface/card/text/primary/… |
| Light / dark mode           | ✅  | ✅  | ✅   | live re-theme |
| Reactive style (color/bg)   | ✅  | ✅  | ✅   | win32 timer-lerp; gtk class-swap |
| Reactive layout/radius/etc. | ✅  | ✅  | ✅   | |
| CSS transitions             | ✅  | ✅  | ✅   | native: timer-lerp animation |
| :hover                      | ✅  | ✅  | ✅   | |

## Widgets

| Widget       | web | gtk | win32 | Notes |
|--------------|-----|-----|-------|-------|
| View / Text  | ✅  | ✅  | ✅   | |
| Button       | ✅  | ✅  | ✅   | flat, no OS chrome |
| Input        | ✅  | ✅  | ✅   | placeholder, themed |
| Checkbox     | ✅  | ✅  | ✅   | |
| Switch       | ✅  | ✅  | ✅   | |
| Slider       | ✅  | ✅  | ✅   | |
| Select       | ✅  | ✅  | ✅   | |
| TextArea     | ✅  | ✅  | ✅   | |
| ProgressBar  | ✅  | ✅  | ✅   | |
| Image        | ✅  | ✅  | ✅   | |
| Separator    | ✅  | ✅  | ✅   | |

## Known native-only gaps (priority order)

1. **Stateful child inside `.map`** — a static child instance gets isolated
   state (α-renamed into the root struct), but a dynamic list can't be
   statically allocated. Emits a clear error; lift state to the parent for now.
2. **`.map` over const object arrays** — needs per-item record-shape inference
   so `it.name` resolves; scalar arrays already unroll.
3. **overflow: scroll/auto** — only basic scrolling on native.

Resolved: stateful child components at static positions (each usage inlined
with per-instance state), `.map` over const scalar arrays, useEffect.

## How parity is enforced

`tests/run.sh` emits every `tests/cases/*.jsx` to each target and compiles it
(GTK C, Win32 C, web bundle). A change that breaks any target fails the run
before it ships. Baseline: **30/30 green**. Add a case with each new feature.
