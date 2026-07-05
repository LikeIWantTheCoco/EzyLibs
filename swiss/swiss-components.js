// Swiss components — the cross-platform primitive surface app code imports.
//
//   import { View, Text, Button, Input, FlatList } from 'swiss';
//
// View/Text/Button/Input are HOST primitives: they render an intrinsic element
// (swiss-view, …) that the active HostConfig realizes. FlatList is a COMPOSITE
// built from those primitives, so it needs no per-platform code.
import { createElement } from 'react';

export const View = (props) => createElement('swiss-view', props, props.children);

export const Text = (props) => createElement('swiss-text', props, props.children);

// Button: `title` text + `onPress`. (children also allowed for custom content.)
export const Button = (props) =>
  createElement('swiss-button', props, props.children);

// Input: controlled — `value` + `onChange(text)`.
export const Input = (props) => createElement('swiss-input', props, null);

// Form widgets — same surface as the native (GTK/Win32) targets so one App.jsx
// runs everywhere. Checkbox/Switch: `value`(checked) + `label` + `onChange(bool)`.
// Slider: `value` + `min`/`max` + `onChange(number)`. Select: `options`(string[])
// + `value`(index) + `onChange(index)`. TextArea: `value` + `onChange(text)`.
export const Checkbox = (props) => createElement('swiss-checkbox', props, null);
export const Switch = (props) => createElement('swiss-switch', props, null);
export const Slider = (props) => createElement('swiss-slider', props, null);
export const Select = (props) => createElement('swiss-select', props, null);
export const TextArea = (props) => createElement('swiss-textarea', props, null);
export const ProgressBar = (props) => createElement('swiss-progress', props, null);
export const Image = (props) => createElement('swiss-image', props, null);
export const Separator = (props) => createElement('swiss-separator', props, null);

// ScrollView — a View that scrolls its overflow. On gtk it maps to a
// GtkScrolledWindow; on web, a flex box with overflow:auto.
export const ScrollView = (props) =>
  createElement('swiss-view', { ...props, style: [{ overflow: 'auto', flex: 1 }, props.style] }, props.children);

// FlatList — composite. Renders a View wrapper, maps `data` through
// `renderItem({ item, index })`, keys via `keyExtractor`.
export function FlatList(props) {
  const { data = [], renderItem, keyExtractor, style } = props;
  const items = data.map((item, index) => {
    const node = renderItem({ item, index });
    const key = keyExtractor ? keyExtractor(item, index) : index;
    return createElement(View, { key }, node);
  });
  return createElement(View, { style }, items);
}
