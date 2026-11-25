// Text recognition for scanned pages. Loaded the first time it is needed; everything runs on the phone.
let worker = null;

export async function startOcr() {
  if (worker) return worker;
  const { createWorker } = (await import("./lib/ocr/tesseract.esm.min.js")).default;
  worker = await createWorker(["eng", "ben"], 1, {
    workerPath: new URL("./lib/ocr/worker.min.js", import.meta.url).href,
    corePath: new URL("./lib/ocr/core/", import.meta.url).href,
    langPath: new URL("./lib/ocr/lang/", import.meta.url).href,
    workerBlobURL: false,
    gzip: true,
    cacheMethod: "none", // the language files are already inside the app
  });
  return worker;
}

export async function stopOcr() {
  const w = worker;
  worker = null;
  if (w) await w.terminate().catch(() => {});
}

// -> { paragraphs: [string], words: [{ t, x0, y0, x1, y1 }] } in pixels of the canvas
export async function readPage(canvas) {
  const w = await startOcr();
  const { data } = await w.recognize(canvas, {}, { blocks: true });
  const paragraphs = [];
  const words = [];
  for (const b of data.blocks || [])
    for (const para of b.paragraphs || []) {
      const lines = [];
      for (const ln of para.lines || []) {
        const t = (ln.text || "").replace(/\s+/g, " ").trim();
        if (t) lines.push(t);
        for (const wd of ln.words || []) {
          const t2 = (wd.text || "").trim();
          if (t2 && wd.bbox) words.push({ t: t2, x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1 });
        }
      }
      if (lines.length) paragraphs.push(lines.join(" "));
    }
  return { paragraphs, words };
}
