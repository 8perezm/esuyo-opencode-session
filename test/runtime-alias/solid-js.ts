// Test-only aliases for the host's `opentui:runtime-module:*` virtual ids.
// Under bun test there is no opencode host loader, so these re-export the
// devDependencies copies (same versions the suite already ran against).
export * from "solid-js";
