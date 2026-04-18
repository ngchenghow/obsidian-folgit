// Auto-injected by esbuild: any bare `Buffer` reference in the bundle gets
// rewritten to import the named export from here. We also stash it on
// globalThis so dynamic lookups (e.g. `typeof Buffer`, `globalThis.Buffer`)
// work on Obsidian Mobile, which has no Node to provide Buffer implicitly.
import { Buffer as BufferImpl } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = BufferImpl;
}
export const Buffer = BufferImpl;
