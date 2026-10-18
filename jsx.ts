// Bridge helper for hand-written element creation (no JSX in this package, so
// the host's Solid transform has nothing to rewrite and every import resolves
// to the host instance instead of an isolated copy).
//
// This mirrors what babel-preset-solid emits with generate: "universal":
// components receive the props object as-is (getters stay reactive through
// the component's own tracking), intrinsics get direct setProp calls with an
// effect wrapping dynamic values, and children go through a single insert.
// (Deviations were tried and reverted: per-child insertNode calls break
// mounting in async flows, and a null insert marker changes nothing.)
//
// Show children must stay lazy factories (`children: (_show) => ...`, mirroring
// the transform's `get children()`): the host destroys detached nodes, so every
// show/hide cycle has to mount brand-new elements. Reusing one static instance
// crashes the slot with "TextBuffer is destroyed".
import {
  createComponent,
  createElement,
  effect,
  insert,
  setProp,
} from "opentui:runtime-module:%40opentui%2Fsolid";

export function h(type: string | ((props: any) => unknown), props?: Record<string, any> | null): any {
  if (typeof type === "function") return createComponent(type, props ?? undefined);
  const element = createElement(type);
  if (props) {
    for (const key of Object.keys(props)) {
      if (key === "children") continue;
      const value = props[key];
      if (typeof value === "function" && !key.startsWith("on")) {
        effect((prev: any) => setProp(element, key, (value as () => unknown)(), prev));
      } else {
        setProp(element, key, value);
      }
    }
    if ("children" in props) insert(element, props.children);
  }
  return element;
}
