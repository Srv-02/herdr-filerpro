// Adapted from herdr-files-plus by jjongkwann (https://github.com/jjongkwann/herdr-files-plus, MIT).
//
// File name tables for the editor's grammar and for the preview. Pure, no Herdr imports.
// Names the editor highlights were checked one by one; extensions it doesn't know map to a close grammar or stay plain.
export const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", yml: "yaml", jsonc: "json", json5: "json",
  svelte: "html", vue: "html", astro: "html", htm: "html", xhtml: "html", svg: "xml", plist: "xml", h: "c", hpp: "cpp", hh: "cpp", cc: "cpp", cxx: "cpp",
  csharp: "cs", zsh: "zsh", ksh: "bash", mk: "make", el: "lisp", lisp: "lisp", ml: "ocaml", mli: "ocaml", hs: "haskell", rake: "rb", gemspec: "rb" };
export const NAMES = { makefile: "make", gnumakefile: "make", gemfile: "rb", rakefile: "rb", ".zshrc": "zsh", ".zprofile": "zsh", ".zshenv": "zsh",
  ".bashrc": "bash", ".bash_profile": "bash", ".profile": "bash" };
export const PREVIEW = { md: "markdown", markdown: "markdown", html: "html", htm: "html", png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", ico: "image", svg: "image", pdf: "pdf" };

// Lower-case extension of the base name without the dot, "" when there is none.
export function extOf(path) {
  const name = path.split("/").pop();
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "";
}

export function langOf(path) {
  const name = path.split("/").pop().toLowerCase(), ext = extOf(path);
  return NAMES[name] ?? LANG[ext] ?? (ext || "txt");
}

// "markdown", "html", "image", "pdf" or null: whether a file has a rendered preview.
export function previewKind(path) {
  return PREVIEW[extOf(path)] ?? null;
}
