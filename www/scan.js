// Document scanner engine (lazy-loaded with the scanner screen). Everything runs on the phone:
// find the page in a photo, straighten it, clean it up, and write a PDF. No libraries, no network.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ---------- finding the page ---------- */

// Corners of the page as fractions of the image, ordered top-left, top-right, bottom-right, bottom-left.
export function detectCorners(source) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const scale = Math.min(1, 320 / Math.max(sw, sh));
  const w = Math.max(8, Math.round(sw * scale)), h = Math.max(8, Math.round(sh * scale));
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  let gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  gray = boxBlur(boxBlur(gray, w, h, 2), w, h, 2);

  const thr = otsu(gray, w * h);

  // Third look: how far each pixel is from the table around the edge of the photo (a tilted plane per colour
  // channel), which still works when the page and the table are both light, or uneven light crosses the frame.
  const away = backdropGap(data, w, h);
  const awayThr = otsu(away, w * h);

  let pick = null;
  for (const [map, t, bright] of [[gray, thr, true], [gray, thr, false], [away, awayThr, true]]) {
    const comp = largestComponent(map, w, h, t, bright);
    if (!comp) continue;
    const share = comp.area / (w * h);
    if (share < 0.18 || share > 0.96) continue;
    const quad = extremes(comp.pts);
    const qa = quadArea(quad);
    const fill = comp.area / Math.max(qa, 1);
    if (fill < 0.72 || qa / (w * h) < 0.2) continue;
    const score = fill * Math.min(share / 0.5, 1) * (0.15 + edgeSupport(away, w, h, quad));
    if (!pick || score > pick.score) pick = { score, quad };
  }
  if (pick) return pick.quad.map(([x, y]) => [x / w, y / h]);
  return [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]]; // nothing clear: the whole frame
}

// How strongly the backdrop-gap map changes across the sides of a candidate quad (a real page edge is sharp).
function edgeSupport(map, w, h, q) {
  let hi = 1e-6;
  for (let i = 0; i < w * h; i++) if (map[i] > hi) hi = map[i];
  const at = (x, y) => map[clamp(Math.round(y), 0, h - 1) * w + clamp(Math.round(x), 0, w - 1)];
  let total = 0;
  for (let k = 0; k < 4; k++) {
    const [x1, y1] = q[k], [x2, y2] = q[(k + 1) % 4];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, nx = -dy / len * 3, ny = dx / len * 3;
    let good = 0;
    for (let i = 1; i < 32; i++) {
      const px = x1 + dx * i / 32, py = y1 + dy * i / 32;
      if (Math.abs(at(px + nx, py + ny) - at(px - nx, py - ny)) / hi > 0.12) good++;
    }
    total += good / 31;
  }
  return total / 4;
}

function otsu(v, n) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
  const span = Math.max(hi - lo, 1e-6), hist = new Float64Array(256);
  for (let i = 0; i < n; i++) hist[Math.min(255, ((v[i] - lo) / span * 255) | 0)]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sumB = 0, best = 0, t0 = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) { best = between; t0 = t; }
  }
  return lo + (t0 + 0.5) / 255 * span;
}

// Distance of every pixel from a colour plane fitted to the outer ring of the photo.
function backdropGap(data, w, h) {
  const ring = Math.max(2, Math.round(Math.min(w, h) * 0.05));
  const out = new Float32Array(w * h);
  const planes = [];
  for (let c = 0; c < 3; c++) {
    // least squares v = a + b*x + c*y over ring pixels
    const m = [0, 0, 0, 0, 0, 0, 0, 0, 0], r = [0, 0, 0];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x >= ring && x < w - ring && y >= ring && y < h - ring) { x = w - ring - 1; continue; }
      const nx = x / w, ny = y / h, v = data[(y * w + x) * 4 + c];
      m[0] += 1; m[1] += nx; m[2] += ny; m[4] += nx * nx; m[5] += nx * ny; m[8] += ny * ny;
      r[0] += v; r[1] += v * nx; r[2] += v * ny;
    }
    m[3] = m[1]; m[6] = m[2]; m[7] = m[5];
    planes.push(solve3(m, r));
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let d = 0;
    for (let c = 0; c < 3; c++) {
      const p = planes[c], e = data[(y * w + x) * 4 + c] - (p[0] + p[1] * x / w + p[2] * y / h);
      d += e * e;
    }
    out[y * w + x] = Math.sqrt(d);
  }
  return boxBlur(boxBlur(out, w, h, 2), w, h, 2);
}
function solve3(m, r) {
  const a = [[m[0], m[1], m[2], r[0]], [m[3], m[4], m[5], r[1]], [m[6], m[7], m[8], r[2]]];
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let j = i + 1; j < 3; j++) if (Math.abs(a[j][i]) > Math.abs(a[p][i])) p = j;
    [a[i], a[p]] = [a[p], a[i]];
    if (Math.abs(a[i][i]) < 1e-9) return [r[0] / Math.max(m[0], 1), 0, 0];
    for (let j = i + 1; j < 3; j++) {
      const f = a[j][i] / a[i][i];
      for (let k = i; k < 4; k++) a[j][k] -= f * a[i][k];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let v = a[i][3];
    for (let k = i + 1; k < 3; k++) v -= a[i][k] * x[k];
    x[i] = v / a[i][i];
  }
  return x;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0, n = 0;
    for (let x = -r; x <= r; x++) {
      if (x >= 0 && x < w) { acc += src[y * w + x]; n++; }
    }
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / n;
      const add = x + r + 1, del = x - r;
      if (add < w) { acc += src[y * w + add]; n++; }
      if (del >= 0) { acc -= src[y * w + del]; n--; }
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0, n = 0;
    for (let y = -r; y <= r; y++) {
      if (y >= 0 && y < h) { acc += tmp[y * w + x]; n++; }
    }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      const add = y + r + 1, del = y - r;
      if (add < h) { acc += tmp[add * w + x]; n++; }
      if (del >= 0) { acc -= tmp[del * w + x]; n--; }
    }
  }
  return out;
}

function largestComponent(gray, w, h, thr, bright) {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = (bright ? gray[i] > thr : gray[i] <= thr) ? 1 : 0;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let best = null;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    let top = 0, area = 0;
    const pts = [];
    stack[top++] = s;
    seen[s] = 1;
    while (top) {
      const i = stack[--top];
      area++;
      const x = i % w, y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !(x & 1) || !(y & 1)) pts.push([x, y]);
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[top++] = i - w; }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[top++] = i + w; }
    }
    if (!best || area > best.area) best = { area, pts };
  }
  return best;
}

function extremes(pts) {
  let tl = pts[0], tr = pts[0], br = pts[0], bl = pts[0];
  for (const p of pts) {
    if (p[0] + p[1] < tl[0] + tl[1]) tl = p;
    if (p[0] - p[1] > tr[0] - tr[1]) tr = p;
    if (p[0] + p[1] > br[0] + br[1]) br = p;
    if (p[0] - p[1] < bl[0] - bl[1]) bl = p;
  }
  return [tl, tr, br, bl];
}
function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/* ---------- straightening ---------- */

// Cut the quadrilateral out of the image and stretch it into a flat rectangle.
export function warp(source, corners, maxSide = 2000) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const k = Math.min(1, 3200 / Math.max(sw, sh));
  const iw = Math.round(sw * k), ih = Math.round(sh * k);
  const src = document.createElement("canvas");
  src.width = iw;
  src.height = ih;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(source, 0, 0, iw, ih);
  const sd = sctx.getImageData(0, 0, iw, ih).data;

  const P = corners.map(([x, y]) => [x * iw, y * ih]);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let ow = Math.max(d(P[0], P[1]), d(P[3], P[2])), oh = Math.max(d(P[0], P[3]), d(P[1], P[2]));
  const sc = Math.min(1, maxSide / Math.max(ow, oh));
  ow = Math.max(16, Math.round(ow * sc));
  oh = Math.max(16, Math.round(oh * sc));

  // homography from output rectangle to source quad
  const H = homography([[0, 0], [ow, 0], [ow, oh], [0, oh]], P);
  const out = document.createElement("canvas");
  out.width = ow;
  out.height = oh;
  const octx = out.getContext("2d");
  const od = octx.createImageData(ow, oh);
  const o = od.data;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const den = H[6] * x + H[7] * y + 1;
      const u = (H[0] * x + H[1] * y + H[2]) / den, v = (H[3] * x + H[4] * y + H[5]) / den;
      const x0 = clamp(Math.floor(u), 0, iw - 2), y0 = clamp(Math.floor(v), 0, ih - 2);
      const fx = clamp(u - x0, 0, 1), fy = clamp(v - y0, 0, 1);
      const i00 = (y0 * iw + x0) * 4, i10 = i00 + 4, i01 = i00 + iw * 4, i11 = i01 + 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const q = (y * ow + x) * 4;
      o[q] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
      o[q + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
      o[q + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
      o[q + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

// 8 coefficients mapping (x, y) in `from` to (u, v) in `to`
function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    const p = A[c][c] || 1e-9;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / p;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / (A[i][i] || 1e-9));
}

/* ---------- cleaning up ---------- */

export function enhance(canvas, mode) {
  const w = canvas.width, h = canvas.height;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  ctx.drawImage(canvas, 0, 0);
  if (mode === "orig") return out;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  // how bright is the paper around each pixel? estimate it on a small copy and blow it back up
  const bw = Math.max(8, Math.round(w / 6)), bh = Math.max(8, Math.round(h / 6));
  const small = document.createElement("canvas");
  small.width = bw;
  small.height = bh;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(canvas, 0, 0, bw, bh);
  const sd = sctx.getImageData(0, 0, bw, bh).data;
  let g = new Float32Array(bw * bh);
  for (let i = 0; i < bw * bh; i++) g[i] = Math.max(sd[i * 4], sd[i * 4 + 1], sd[i * 4 + 2]);
  // paper is the bright part: a wide max-ish blur ignores the ink
  g = boxBlur(boxBlur(dilate(g, bw, bh, 3), bw, bh, 3), bw, bh, 3);
  const bgSmall = document.createElement("canvas");
  bgSmall.width = bw;
  bgSmall.height = bh;
  const bctx = bgSmall.getContext("2d");
  const bimg = bctx.createImageData(bw, bh);
  for (let i = 0; i < bw * bh; i++) {
    bimg.data[i * 4] = bimg.data[i * 4 + 1] = bimg.data[i * 4 + 2] = g[i];
    bimg.data[i * 4 + 3] = 255;
  }
  bctx.putImageData(bimg, 0, 0);
  const bgBig = document.createElement("canvas");
  bgBig.width = w;
  bgBig.height = h;
  const bgctx = bgBig.getContext("2d", { willReadFrequently: true });
  bgctx.imageSmoothingQuality = "high";
  bgctx.drawImage(bgSmall, 0, 0, w, h);
  const bg = bgctx.getImageData(0, 0, w, h).data;

  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const paper = Math.max(bg[p], 40);
    if (mode === "color") {
      d[p] = clamp((d[p] / paper) * 245, 0, 255);
      d[p + 1] = clamp((d[p + 1] / paper) * 245, 0, 255);
      d[p + 2] = clamp((d[p + 2] / paper) * 245, 0, 255);
    } else {
      let v = ((d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) / paper) * 255;
      if (mode === "bw") v = v < 190 ? 0 : 255;
      else v = clamp((v - 110) * (255 / 120), 0, 255); // white paper, firm dark text
      d[p] = d[p + 1] = d[p + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function dilate(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = -r; k <= r; k++) m = Math.max(m, src[y * w + clamp(x + k, 0, w - 1)]);
    tmp[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = -r; k <= r; k++) m = Math.max(m, tmp[clamp(y + k, 0, h - 1) * w + x]);
    out[y * w + x] = m;
  }
  return out;
}

/* ---------- saving ---------- */

export function toJpeg(canvas, quality = 0.85) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error("encode failed"))), "image/jpeg", quality)
  );
}

// A PDF with one JPEG picture per page. pages: [{ jpeg: Uint8Array, w, h }] (pixel sizes)
// An invisible, searchable text layer: every character used gets a 2-byte code, and a ToUnicode map says which letter it is.
// The page picture stays exactly as scanned; the text only lets you search and copy.
function textLayer(words, w, h) {
  const k = 72 / 150;
  let out = "BT 3 Tr\n";
  for (const wd of words) {
    const chars = [...wd.t].filter((c) => c.codePointAt(0) <= 0xffff);
    if (!chars.length) continue;
    const size = Math.max(4, (wd.y1 - wd.y0) * k * 0.8);
    const width = (wd.x1 - wd.x0) * k;
    const tz = Math.max(10, Math.min(400, (width / (chars.length * size * 0.5)) * 100));
    out += `/F1 ${size.toFixed(1)} Tf ${tz.toFixed(0)} Tz 1 0 0 1 ${(wd.x0 * k).toFixed(1)} ${((h - wd.y1) * k + size * 0.2).toFixed(1)} Tm <${chars.map((c) => hex(codeOf(c))).join("")}> Tj\n`;
  }
  return out + "ET";
}
const codes = new Map();
const codeOf = (c) => {
  if (!codes.has(c)) codes.set(c, codes.size + 1);
  return codes.get(c);
};
const hex = (n) => n.toString(16).padStart(4, "0");
function toUnicodeMap() {
  const rows = [...codes].map(([c, n]) => `<${hex(n)}> <${hex(c.codePointAt(0))}>`);
  let body = "";
  for (let i = 0; i < rows.length; i += 100) body += `${Math.min(100, rows.length - i)} beginbfchar\n${rows.slice(i, i + 100).join("\n")}\nendbfchar\n`;
  return `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n${body}endcmap CMapName currentdict /CMap defineresource pop end end`;
}

// pages: [{ jpeg, w, h, words? }]  (words from text recognition make the PDF searchable)
export function makePdf(pages, title = "Scan") {
  codes.clear();
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let pos = 0;
  const push = (x) => {
    const b = typeof x === "string" ? enc.encode(x) : x;
    parts.push(b);
    pos += b.length;
  };
  const obj = (n, body) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n`);
    push(body);
    push("\nendobj\n");
  };
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const n = pages.length;
  const searchable = pages.some((p) => p.words && p.words.length);
  const contents = pages.map((p) => `q ${((p.w * 72) / 150).toFixed(2)} 0 0 ${((p.h * 72) / 150).toFixed(2)} 0 0 cm /Im0 Do Q` + (p.words && p.words.length ? "\n" + textLayer(p.words, p.w, p.h) : ""));
  const fontNo = 4 + n * 3; // after the info object
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] >>`);
  pages.forEach((p, i) => {
    const pg = 3 + i * 3, content = pg + 1, image = pg + 2;
    const pw = (p.w * 72) / 150, ph = (p.h * 72) / 150; // about 150 dpi
    obj(pg, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] /Resources << /XObject << /Im0 ${image} 0 R >>${searchable ? ` /Font << /F1 ${fontNo} 0 R >>` : ""} >> /Contents ${content} 0 R >>`);
    const stream = contents[i];
    obj(content, `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`);
    offsets[image] = pos;
    push(`${image} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
    push(p.jpeg);
    push("\nendstream\nendobj\n");
  });
  const infoNo = 3 + n * 3;
  obj(infoNo, `<< /Title (${title.replace(/[()\\]/g, "")}) /Producer (Reader by Key) >>`);
  if (searchable) {
    const cm = toUnicodeMap();
    obj(fontNo, `<< /Type /Font /Subtype /Type0 /BaseFont /ReaderOCR /Encoding /Identity-H /DescendantFonts [${fontNo + 1} 0 R] /ToUnicode ${fontNo + 2} 0 R >>`);
    obj(fontNo + 1, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ReaderOCR /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 /FontDescriptor ${fontNo + 3} 0 R /CIDToGIDMap /Identity >>`);
    obj(fontNo + 2, `<< /Length ${cm.length} >>\nstream\n${cm}\nendstream`);
    obj(fontNo + 3, "<< /Type /FontDescriptor /FontName /ReaderOCR /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>");
  }
  const last = searchable ? fontNo + 3 : infoNo;
  const xref = pos;
  push(`xref\n0 ${last + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i <= last; i++) push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${last + 1} /Root 1 0 R /Info ${infoNo} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}
