// Copies PDF.js (legacy build, works on older Android WebViews) into www/lib
// so the app works fully offline. Run before `cap sync`.
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pdfjs = join(root, "node_modules", "pdfjs-dist");
const out = join(root, "www", "lib");

if (!existsSync(pdfjs)) {
  console.error("pdfjs-dist not found. Run `npm install` first.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(join(pdfjs, "legacy", "build", "pdf.min.mjs"), join(out, "pdf.min.mjs"));
cpSync(join(pdfjs, "legacy", "build", "pdf.worker.min.mjs"), join(out, "pdf.worker.min.mjs"));

// Resources PDF.js loads on demand (fonts, color profiles, image decoders).
// The big CJK character maps (cmaps) are left out to keep the app small.
for (const dir of ["standard_fonts", "iccs", "wasm"]) {
  // PDF scripting is off, so its engine (quickjs) is not shipped; WebViews all run WebAssembly,
  // so the slow JavaScript fallbacks for the image decoders are left out too.
  const skip = /quickjs|nowasm_fallback/;
  if (existsSync(join(pdfjs, dir))) cpSync(join(pdfjs, dir), join(out, dir), { recursive: true, filter: (src) => !skip.test(src) });
}

console.log("PDF.js copied to www/lib");

// In CI the app's own scripts and styles are minified (about half the size). Local runs leave them readable.
if (process.env.CI) {
  const { transformSync } = await import("esbuild");
  const { readdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const www = join(root, "www");
  let before = 0, after = 0;
  for (const f of readdirSync(www)) {
    const loader = f.endsWith(".js") ? "js" : f.endsWith(".css") ? "css" : null;
    if (!loader) continue;
    const src = readFileSync(join(www, f), "utf8");
    const min = transformSync(src, { loader, minify: true, target: "es2020", legalComments: "none" }).code;
    writeFileSync(join(www, f), min);
    before += src.length;
    after += min.length;
  }
  console.log(`minified app code: ${before} -> ${after} bytes`);
}
