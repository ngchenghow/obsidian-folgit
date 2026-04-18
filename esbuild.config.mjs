import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isoGitEsm = resolve(__dirname, "node_modules/isomorphic-git/index.js");
const bufferShim = resolve(__dirname, "node_modules/buffer/index.js");

const banner = `/*
Folgit — built by esbuild. See repo for source.
*/`;

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    // Keep all other Node builtins external, but bundle a browser-compatible
    // `buffer` (sha.js pulls it in, and Obsidian Mobile has no `require`).
    ...builtins.filter((m) => m !== "buffer"),
  ],
  // Force isomorphic-git's ESM entry (uses pure-JS sha.js) instead of the
  // default CJS entry, which does `require('crypto')` at top level and blows
  // up Obsidian Mobile on plugin load.
  alias: {
    "isomorphic-git": isoGitEsm,
    buffer: bufferShim,
  },
  // Install Buffer on globalThis at bundle start — isomorphic-git / sha.js
  // reference the bare `Buffer` global on some code paths, and Obsidian
  // Mobile has no Node to provide it.
  inject: [resolve(__dirname, "buffer-shim.js")],
  mainFields: ["browser", "module", "main"],
  conditions: ["browser", "import"],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  platform: "node",
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
