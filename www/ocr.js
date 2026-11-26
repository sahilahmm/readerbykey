// Text recognition for scanned pages. Loaded the first time it is needed; everything runs on the phone.
let worker = null;
let ready = null;

async function make(langs) {
  const { createWorker } = (await import("./lib/ocr/tesseract.esm.min.js")).default;
  return createWorker(langs, 1, {
    workerPath: new URL("./lib/ocr/worker.min.js", import.meta.url).href,
    corePath: new URL("./lib/ocr/core/", import.meta.url).href,
    langPath: new URL("./lib/ocr/lang/", import.meta.url).href,
    workerBlobURL: false,
    gzip: false,
    cacheMethod: "none", // the language files are already inside the app
  });
}

// English first: it is faster and more exact. Bangla joins only when a page turns out to need it.
export async function startOcr(langs = ["eng"]) {
  const key = langs.join("+");
  if (worker && ready === key) return worker;
  if (worker) await worker.terminate().catch(() => {});
  worker = null;
  worker = await make(langs);
  ready = key;
  return worker;
}

export async function stopOcr() {
  const w = worker;
  worker = null;
  ready = null;
  if (w) await w.terminate().catch(() => {});
}

async function run(w, canvas) {
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
  return { paragraphs, words, confidence: data.confidence || 0 };
}

// Small text reads better enlarged; boxes come back in the original canvas's pixels.
function enlarge(canvas) {
  const long = Math.max(canvas.width, canvas.height);
  const k = long < 2400 ? Math.min(2, 2400 / long) : 1;
  if (k <= 1.05) return [canvas, 1];
  const c = document.createElement("canvas");
  c.width = Math.round(canvas.width * k);
  c.height = Math.round(canvas.height * k);
  const x = c.getContext("2d");
  x.imageSmoothingQuality = "high";
  x.drawImage(canvas, 0, 0, c.width, c.height);
  return [c, k];
}

// -> { paragraphs: [string], words: [{ t, x0, y0, x1, y1 }] } in pixels of the canvas
export async function readPage(canvas) {
  const [img, k] = enlarge(canvas);
  let r = await run(await startOcr(["eng"]), img);
  if (r.confidence < 72) {
    // maybe not English: try with Bangla added and keep whichever is surer
    const r2 = await run(await startOcr(["eng", "ben"]), img);
    if (r2.confidence > r.confidence) r = r2;
  }
  const words = r.words.map((w) => ({ t: w.t, x0: w.x0 / k, y0: w.y0 / k, x1: w.x1 / k, y1: w.y1 / k }));
  return { paragraphs: r.paragraphs, words };
}
