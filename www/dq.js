// Page finder: a small neural network (DocQuadNet, Apache-2.0) that points at the four corners of a page.
// It runs offline in the WebView. If it can't load, the plain image methods in scan.js carry on alone.
import { detectCorners } from "./scan.js";

const S = 256; // the network looks at a 256 x 256 picture
let loading = null;

function load() {
  loading ||= (async () => {
    const base = new URL("./lib/dq/", import.meta.url);
    const ort = await import(new URL("ort.js", base).href);
    ort.env.wasm.numThreads = 1; // WebViews are not cross-origin isolated, so one thread
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { mjs: new URL("glue.js", base).href, wasm: new URL("ort.wasm", base).href };
    ort.env.wasm.wasmBinary = await (await fetch(new URL("ort.wasm", base))).arrayBuffer();
    const model = new Uint8Array(await (await fetch(new URL("docquad.ort", base))).arrayBuffer());
    return { ort, session: await ort.InferenceSession.create(model, { executionProviders: ["wasm"] }) };
  })();
  loading.catch(() => (loading = null));
  return loading;
}

// order four points: top-left first, then clockwise
function order(p) {
  const cx = p.reduce((s, q) => s + q[0], 0) / 4, cy = p.reduce((s, q) => s + q[1], 0) / 4;
  const q = [...p].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let k = 0;
  for (let i = 1; i < 4; i++) if (q[i][0] + q[i][1] < q[k][0] + q[k][1]) k = i;
  return [0, 1, 2, 3].map((i) => q[(k + i) % 4]);
}

const area = (q) => Math.abs(q.reduce((s, p, i) => s + p[0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * p[1], 0)) / 2;
function convex(q) {
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 0) return false;
  }
  return true;
}

// one pass: the photo turned by `deg` (so tilted pages look upright to the network), corners mapped back to 0..1
async function pass({ ort, session }, src, deg) {
  const w = src.width, h = src.height;
  const k = Math.min(S / w, S / h) * (deg ? 0.78 : 1);
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.fillStyle = "#000";
  x.fillRect(0, 0, S, S);
  x.imageSmoothingQuality = "high";
  x.translate(S / 2, S / 2);
  x.rotate((deg * Math.PI) / 180);
  x.drawImage(src, (-w * k) / 2, (-h * k) / 2, w * k, h * k);
  const d = x.getImageData(0, 0, S, S).data, n = S * S, f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    f[i] = d[i * 4] / 255;
    f[n + i] = d[i * 4 + 1] / 255;
    f[2 * n + i] = d[i * 4 + 2] / 255;
  }
  const out = await session.run({ input: new ort.Tensor("float32", f, [1, 3, S, S]) });
  const hm = out.corner_heatmaps.data, cell = 64 * 64;
  const rad = (-deg * Math.PI) / 180, cs = Math.cos(rad), sn = Math.sin(rad);
  const pts = [];
  let conf = 1;
  for (let ch = 0; ch < 4; ch++) {
    let best = -1e9, bi = 0;
    for (let i = 0; i < cell; i++) if (hm[ch * cell + i] > best) { best = hm[ch * cell + i]; bi = i; }
    conf = Math.min(conf, 1 / (1 + Math.exp(-best)));
    const px = ((bi % 64) + 0.5) * 4 - S / 2, py = (Math.floor(bi / 64) + 0.5) * 4 - S / 2;
    const rx = px * cs - py * sn, ry = px * sn + py * cs; // undo the turn
    pts.push([(rx / k + w / 2) / w, (ry / k + h / 2) / h]);
  }
  return { quad: order(pts), conf };
}

async function neural(src) {
  const m = await load();
  let best = null;
  for (const deg of [0, 25, -25, 45, -45]) {
    const r = await pass(m, src, deg);
    if (!best || r.conf > best.conf) best = r;
    if (best.conf >= 0.6) break; // tilted pages get extra tries, upright ones stop at once
  }
  return best;
}

const far = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

// -> four corners (0..1, top-left first); `.sure` is false when the person should confirm them
export async function findPage(src) {
  const plain = detectCorners(src);
  let nn = null;
  try {
    nn = await neural(src);
    const a = area(nn.quad);
    if (!(a > 0.12 && a < 1.02 && convex(nn.quad))) nn = null;
  } catch {
    nn = null; // model not available: image methods only
  }
  if (nn && nn.conf >= 0.6) {
    nn.quad.sure = true;
    return nn.quad;
  }
  if (plain.sure) return plain;
  if (nn && nn.conf >= 0.08) {
    nn.quad.sure = false;
    return nn.quad;
  }
  return plain;
}
