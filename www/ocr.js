// Text recognition for scanned pages. Loaded the first time it is needed; everything runs on the phone.
// A page is cut into a few bands (between lines of text) that are read at the same time by separate workers.
let pool = null;
let poolKey = null;
let lastLangs = ["eng"]; // the next page of the same scan starts with the language that worked

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

const workersWanted = () => globalThis.__ocrWorkers || Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));

async function getPool(langs, n) {
  const key = `${langs.join("+")}:${n}`;
  if (pool && poolKey === key) return pool;
  await stopOcr();
  const made = [];
  try {
    for (let i = 0; i < n; i++) made.push(make(langs));
    pool = await Promise.all(made);
  } catch (e) {
    (await Promise.allSettled(made)).forEach((r) => r.status === "fulfilled" && r.value.terminate().catch(() => {}));
    throw e;
  }
  poolKey = key;
  return pool;
}

export async function stopOcr() {
  const p = pool;
  pool = null;
  poolKey = null;
  if (p) await Promise.all(p.map((w) => w.terminate().catch(() => {})));
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

// cut points (pixel rows) in the blank gaps between lines, near equal slices
function cuts(canvas, n) {
  const h = canvas.height;
  if (n < 2 || h < 1200) return [0, h];
  const w2 = Math.min(canvas.width, 400), h2 = Math.round((h * w2) / canvas.width);
  const s = document.createElement("canvas");
  s.width = w2;
  s.height = h2;
  const sx = s.getContext("2d", { willReadFrequently: true });
  sx.drawImage(canvas, 0, 0, w2, h2);
  const d = sx.getImageData(0, 0, w2, h2).data;
  const ink = new Float32Array(h2);
  for (let y = 0; y < h2; y++) {
    let c = 0;
    for (let x = 0; x < w2; x++) if (d[(y * w2 + x) * 4] < 150) c++;
    ink[y] = c;
  }
  const out = [0];
  for (let k = 1; k < n; k++) {
    const target = Math.round((h2 * k) / n), reach = Math.round(h2 / (n * 3));
    const lo = Math.max(out[out.length - 1] + 20, target - reach), hi = Math.min(h2 - 20, target + reach);
    let best = -1, bestScore = Infinity;
    for (let y = lo; y < hi; y++) {
      // a row in the middle of a blank stretch scores best; a row through text scores worst
      let near = 0;
      for (let j = -3; j <= 3; j++) near += ink[Math.min(h2 - 1, Math.max(0, y + j))];
      const score = near * 1000 + Math.abs(y - target);
      if (score < bestScore) { bestScore = score; best = y; }
    }
    if (best > 0) out.push(Math.round((best * h) / h2));
  }
  out.push(h);
  return out;
}

// one band through one worker -> paragraphs, words, and how sure the reader was
async function run(w, canvas, top) {
  const { data } = await w.recognize(canvas, {}, { blocks: true });
  const paragraphs = [];
  const words = [];
  let sum = 0, n = 0;
  for (const b of data.blocks || [])
    for (const para of b.paragraphs || []) {
      const lines = [];
      for (const ln of para.lines || []) {
        const ws = (ln.words || []).filter((wd) => (wd.text || "").trim());
        for (const wd of ws) { sum += wd.confidence || 0; n++; }
        if (!ws.length) continue;
        const mean = ws.reduce((a, wd) => a + (wd.confidence || 0), 0) / ws.length;
        const t = (ln.text || "").replace(/\s+/g, " ").trim();
        // noise from pictures, dust and page edges: low confidence and hardly any letters
        const letters = (t.match(/\p{L}|\p{N}/gu) || []).length;
        if (mean < 45 || letters < 2 || (letters < 4 && mean < 70)) continue;
        lines.push(t);
        for (const wd of ws)
          if (wd.bbox && (wd.confidence || 0) >= 30) words.push({ t: wd.text.trim(), x0: wd.bbox.x0, y0: wd.bbox.y0 + top, x1: wd.bbox.x1, y1: wd.bbox.y1 + top });
      }
      if (lines.length) paragraphs.push(lines.join(" "));
    }
  return { paragraphs, words, sum, n };
}

async function pass(langs, canvas, edges, onFrac) {
  const workers = await getPool(langs, Math.min(workersWanted(), edges.length - 1));
  const jobs = edges.slice(0, -1).map((y0, i) => [y0, edges[i + 1]]);
  const res = new Array(jobs.length);
  let next = 0, done = 0;
  await Promise.all(
    workers.map(async (w) => {
      while (next < jobs.length) {
        const i = next++;
        const [y0, y1] = jobs[i];
        const band = document.createElement("canvas");
        band.width = canvas.width;
        band.height = y1 - y0;
        band.getContext("2d").drawImage(canvas, 0, y0, canvas.width, y1 - y0, 0, 0, canvas.width, y1 - y0);
        res[i] = await run(w, band, y0);
        onFrac(++done / jobs.length);
      }
    })
  );
  const paragraphs = res.flatMap((r) => r.paragraphs);
  const words = res.flatMap((r) => r.words);
  const n = res.reduce((a, r) => a + r.n, 0);
  const conf = n ? res.reduce((a, r) => a + r.sum, 0) / n : 0;
  return { paragraphs, words, conf };
}

const bengaliShare = (paras) => {
  const t = paras.join(" ");
  const letters = (t.match(/\p{L}/gu) || []).length || 1;
  return (t.match(/[ঀ-৿]/g) || []).length / letters;
};

// -> { paragraphs: [string], words: [{ t, x0, y0, x1, y1 }] } in pixels of the canvas; onProgress(0..1)
export async function readPage(canvas, onProgress = () => {}) {
  const [img, k] = enlarge(canvas);
  const edges = cuts(img, workersWanted());
  const wantBangla = lastLangs.length > 1;
  let r = await pass(wantBangla ? ["eng", "ben"] : ["eng"], img, edges, (f) => onProgress(f * (wantBangla ? 1 : 0.7)));
  if (!wantBangla && r.conf < 60) {
    // perhaps Bangla: read again with it, and keep that only if the page really has Bangla letters
    const r2 = await pass(["eng", "ben"], img, edges, (f) => onProgress(0.7 + f * 0.3));
    if (bengaliShare(r2.paragraphs) >= 0.2 && r2.conf >= r.conf - 5) {
      r = r2;
      lastLangs = ["eng", "ben"];
    }
  }
  onProgress(1);
  const words = r.words.map((w) => ({ t: w.t, x0: w.x0 / k, y0: w.y0 / k, x1: w.x1 / k, y1: w.y1 / k }));
  return { paragraphs: r.paragraphs, words };
}
