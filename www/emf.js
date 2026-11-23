// Pictures stored as EMF / WMF (old Office formats), turned into something a browser can show.
// Untrusted input: only reads from the byte array, draws to a canvas, never touches the DOM or network.

/* ---------- pictures stored as EMF / WMF: pull out the bitmap inside ---------- */

// a device-independent bitmap (header + pixels) as something the browser can show
export function dibToImage(bytes, off, bmiLen, bitsOff, bitsLen) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bmiLen < 12 || off + bmiLen > bytes.length || bitsOff + bitsLen > bytes.length || bitsLen <= 0) return null;
  const comp = bmiLen >= 20 ? dv.getUint32(off + 16, true) : 0;
  if (comp === 4 || comp === 5) return { data: bytes.slice(bitsOff, bitsOff + bitsLen), type: comp === 4 ? "image/jpeg" : "image/png" };
  if (bmiLen < 40) return null;
  const w = Math.abs(dv.getInt32(off + 4, true)), h = Math.abs(dv.getInt32(off + 8, true));
  if (!w || !h || w * h > 120e6) return null;
  const out = new Uint8Array(14 + bmiLen + bitsLen);
  const odv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  odv.setUint32(2, out.length, true);
  odv.setUint32(10, 14 + bmiLen, true);
  out.set(bytes.subarray(off, off + bmiLen), 14);
  out.set(bytes.subarray(bitsOff, bitsOff + bitsLen), 14 + bmiLen);
  return { data: out, type: "image/bmp", area: w * h, w, h };
}

export function bitmapFromWmf(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = dv.getUint32(0, true) === 0x9ac6cdd7 ? 22 : 0;
  p += 18; // the metafile header
  let best = null;
  for (let n = 0; p + 6 <= b.length && n < 100000; n++) {
    const size = dv.getUint32(p, true) * 2, fn = dv.getUint16(p + 4, true);
    if (size < 6 || p + size > b.length) break;
    const dibAt = fn === 0x0f43 ? p + 28 : fn === 0x0b41 ? p + 26 : 0;
    if (dibAt && dibAt + 40 <= p + size) {
      const hdr = dv.getUint32(dibAt, true);
      const bits = dv.getUint16(dibAt + 14, true);
      const comp = dv.getUint32(dibAt + 16, true);
      let colors = dv.getUint32(dibAt + 32, true);
      if (!colors && bits <= 8) colors = 1 << bits;
      const bmiLen = hdr + (bits <= 8 ? colors * 4 : 0) + (comp === 3 ? 12 : 0);
      const img = dibToImage(b, dibAt, bmiLen, dibAt + bmiLen, p + size - (dibAt + bmiLen));
      if (img && (!best || (img.area || 0) > (best.area || 0))) best = img;
    }
    p += size;
  }
  return best;
}


/* ---------- EMF: draw the metafile onto a canvas and hand back a PNG ---------- */

const rgb = (c) => `rgb(${c & 255},${(c >> 8) & 255},${(c >> 16) & 255})`;
const fontFamily = (face) =>
  /courier|consolas|mono/i.test(face) ? "ui-monospace,Menlo,Consolas,monospace" : /times|georgia|cambria|garamond|palatino|serif$/i.test(face) && !/sans/i.test(face) ? "Georgia,'Times New Roman',serif" : "system-ui,'Segoe UI',Roboto,Arial,sans-serif";
const STOCK_BRUSH = { 0: "#fff", 1: "#c0c0c0", 2: "#808080", 3: "#404040", 4: "#000" };
const STOCK_PEN = { 6: "#fff", 7: "#000" };

export async function renderEmf(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 88 || dv.getUint32(0, true) !== 1) return null;
  let bl = dv.getInt32(8, true), bt = dv.getInt32(12, true), br = dv.getInt32(16, true), bb = dv.getInt32(20, true);
  let bw = br - bl + 1, bh = bb - bt + 1;
  if (bw < 2 || bh < 2 || bw > 1e6 || bh > 1e6) {
    // no device bounds: use the frame (0.01 mm) at 96 dpi
    bl = 0; bt = 0;
    bw = Math.max(2, Math.round(((dv.getInt32(32, true) - dv.getInt32(24, true)) / 2540) * 96));
    bh = Math.max(2, Math.round(((dv.getInt32(36, true) - dv.getInt32(28, true)) / 2540) * 96));
  }
  const scale = Math.min(4, Math.max(0.05, 1600 / Math.max(bw, bh)));
  const cw = Math.max(1, Math.round(bw * scale)), ch = Math.max(1, Math.round(bh * scale));
  if (cw * ch > 16e6) return null;
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");

  // coordinate mapping: logical -> world transform -> window/viewport -> canvas
  let wo = [0, 0], we = null, vo = [0, 0], ve = null;
  let xf = [1, 0, 0, 1, 0, 0];
  const pt = (x, y) => {
    let X = x * xf[0] + y * xf[2] + xf[4], Y = x * xf[1] + y * xf[3] + xf[5];
    if (we && ve && we[0] && we[1]) {
      X = (X - wo[0]) * (ve[0] / we[0]) + vo[0];
      Y = (Y - wo[1]) * (ve[1] / we[1]) + vo[1];
    }
    return [(X - bl) * scale, (Y - bt) * scale];
  };
  const unit = () => {
    const a = pt(1, 0), o = pt(0, 0);
    return Math.hypot(a[0] - o[0], a[1] - o[1]) || scale;
  };

  const objs = new Map();
  let pen = { color: "#000", width: 1, none: false };
  let brush = { color: "#fff", none: false };
  let font = { h: 12, face: "", bold: false, italic: false, ul: false };
  let textColor = "#000", bkMode = 2, bkColor = "#fff", align = 0;
  let cur = [0, 0], path = null, drew = 0;
  const stack = [];

  const strokeIt = () => {
    if (pen.none) return;
    ctx.strokeStyle = pen.color;
    ctx.lineWidth = Math.max(1, pen.width * unit());
    ctx.stroke();
  };
  const fillIt = () => {
    if (brush.none) return;
    ctx.fillStyle = brush.color;
    ctx.fill();
  };
  const draw = async (bytes, off, bmiLen, bitsOff, bitsLen, dx, dy, dw, dh) => {
    const img = dibToImage(b, off, bmiLen, bitsOff, bitsLen);
    if (!img) return;
    let bmp;
    try {
      const blob = new Blob([img.data], { type: img.type });
      const tw = Math.round(Math.abs(pt(dx + dw, dy)[0] - pt(dx, dy)[0])), th = Math.round(Math.abs(pt(dx, dy + dh)[1] - pt(dx, dy)[1]));
      try {
        // big scans are shrunk while decoding: far less memory and much faster
        bmp = img.w && tw > 0 && th > 0 && (tw < img.w || th < img.h) ? await createImageBitmap(blob, { resizeWidth: Math.max(1, tw), resizeHeight: Math.max(1, th), resizeQuality: "medium" }) : await createImageBitmap(blob);
      } catch {
        bmp = await createImageBitmap(blob);
      }
    } catch {
      return;
    }
    const [x1, y1] = pt(dx, dy), [x2, y2] = pt(dx + dw, dy + dh);
    ctx.save();
    ctx.drawImage(bmp, Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1) || bmp.width, Math.abs(y2 - y1) || bmp.height);
    ctx.restore();
    bmp.close && bmp.close();
    drew++;
  };

  const plus = { images: new Map() };
  async function emfPlus(p, size) {
    // records of EMF+ live inside a comment record that starts with "EMF+"
    let q = p + 16;
    const end = p + size;
    while (q + 12 <= end) {
      const type = dv.getUint16(q, true), flags = dv.getUint16(q + 2, true), sz = dv.getUint32(q + 4, true), dsz = dv.getUint32(q + 8, true);
      if (sz < 12 || q + sz > end) break;
      const d = q + 12;
      if (type === 0x4008 && ((flags >> 8) & 0x7f) === 5 && dsz >= 28) {
        // an image object; keep it only when it carries a compressed picture
        const itype = dv.getUint32(d + 4, true);
        if (itype === 1 && dv.getUint32(d + 24, true) === 1) plus.images.set(flags & 255, b.slice(d + 28, d + dsz));
        else if (itype === 1 && dv.getUint32(d + 24, true) === 0) {
          // raw pixels: width, height, stride, format
          const w = dv.getInt32(d + 8, true), h = dv.getInt32(d + 12, true), stride = dv.getInt32(d + 16, true), fmt = dv.getUint32(d + 20, true);
          if (w > 0 && h > 0 && w * h < 40e6 && (fmt & 0xff00) === 0x2000 || fmt === 0x26200a || fmt === 0x22009 || fmt === 0x21808) {
            const bpp = (fmt >> 8) & 255;
            const px = Math.floor(bpp / 8);
            const cv = document.createElement("canvas");
            cv.width = w; cv.height = h;
            const id = cv.getContext("2d").createImageData(w, h);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
              const o = d + 28 + y * stride + x * px;
              if (o + 2 >= b.length) break;
              const k = (y * w + x) * 4;
              id.data[k] = b[o + 2]; id.data[k + 1] = b[o + 1]; id.data[k + 2] = b[o]; id.data[k + 3] = px === 4 && fmt !== 0x22009 ? b[o + 3] : 255;
            }
            cv.getContext("2d").putImageData(id, 0, 0);
            plus.images.set(flags & 255, new Uint8Array(await (await new Promise((r) => cv.toBlob(r, "image/png"))).arrayBuffer()));
          }
        }
      } else if (type === 0x401a && plus.images.has(flags & 255) && dsz >= 40) {
        const small = (flags & 0x4000) !== 0;
        let r;
        if (small) r = [dv.getInt16(d + 24, true), dv.getInt16(d + 26, true), dv.getInt16(d + 28, true), dv.getInt16(d + 30, true)];
        else r = [dv.getFloat32(d + 24, true), dv.getFloat32(d + 28, true), dv.getFloat32(d + 32, true), dv.getFloat32(d + 36, true)];
        const data = plus.images.get(flags & 255);
        const isPng = data[0] === 0x89;
        try {
          const bmp = await createImageBitmap(new Blob([data], { type: isPng ? "image/png" : "image/jpeg" }));
          // EMF+ coordinates are device pixels like the header bounds
          const x = (r[0] - bl) * scale, y = (r[1] - bt) * scale;
          ctx.drawImage(bmp, x, y, r[2] * scale, r[3] * scale);
          drew++;
        } catch {
          /* skip */
        }
      }
      q += sz;
    }
  }

  const n32 = (p, o) => dv.getInt32(p + o, true);
  for (let p = 0, count = 0; p + 8 <= b.length && count < 200000; count++) {
    const type = dv.getUint32(p, true), size = dv.getUint32(p + 4, true);
    if (size < 8 || p + size > b.length) break;
    try {
      switch (type) {
        case 9: we = [n32(p, 8), n32(p, 12)]; break;
        case 10: wo = [n32(p, 8), n32(p, 12)]; break;
        case 11: ve = [n32(p, 8), n32(p, 12)]; break;
        case 12: vo = [n32(p, 8), n32(p, 12)]; break;
        case 33: stack.push({ pen, brush, font, textColor, xf: [...xf], wo, we, vo, ve }); break;
        case 34: { const s = stack.pop(); if (s) ({ pen, brush, font, textColor, xf, wo, we, vo, ve } = s); break; }
        case 35: xf = [dv.getFloat32(p + 8, true), dv.getFloat32(p + 12, true), dv.getFloat32(p + 16, true), dv.getFloat32(p + 20, true), dv.getFloat32(p + 24, true), dv.getFloat32(p + 28, true)]; break;
        case 36: {
          const m = [0, 4, 8, 12, 16, 20].map((o) => dv.getFloat32(p + 8 + o, true));
          const mode = dv.getUint32(p + 32, true);
          const mul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3], A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5]];
          if (mode === 1) xf = [1, 0, 0, 1, 0, 0];
          else if (mode === 2) xf = mul(m, xf);
          else if (mode === 3) xf = mul(xf, m);
          else if (mode === 4) xf = m;
          break;
        }
        case 18: bkMode = dv.getUint32(p + 8, true); break;
        case 22: align = dv.getUint32(p + 8, true); break;
        case 24: textColor = rgb(dv.getUint32(p + 8, true)); break;
        case 25: bkColor = rgb(dv.getUint32(p + 8, true)); break;
        case 38: objs.set(dv.getUint32(p + 8, true), { pen: { color: rgb(dv.getUint32(p + 24, true)), width: n32(p, 16), none: dv.getUint32(p + 12, true) === 5 } }); break;
        case 95: objs.set(dv.getUint32(p + 8, true), { pen: { color: rgb(dv.getUint32(p + 48, true)), width: dv.getUint32(p + 32, true), none: (dv.getUint32(p + 28, true) & 15) === 5 } }); break;
        case 39: objs.set(dv.getUint32(p + 8, true), { brush: { color: rgb(dv.getUint32(p + 16, true)), none: dv.getUint32(p + 12, true) === 1 } }); break;
        case 82: {
          const o = p + 12;
          let face = "";
          for (let i = 0; i < 32; i++) { const ch2 = dv.getUint16(o + 28 + i * 2, true); if (!ch2) break; face += String.fromCharCode(ch2); }
          objs.set(dv.getUint32(p + 8, true), { font: { h: Math.abs(dv.getInt32(o, true)) || 12, face, bold: dv.getInt32(o + 16, true) >= 600, italic: b[o + 20] !== 0, ul: b[o + 21] !== 0 } });
          break;
        }
        case 40: objs.delete(dv.getUint32(p + 8, true)); break;
        case 37: {
          const id = dv.getUint32(p + 8, true);
          if (id & 0x80000000) {
            const k = id & 0x7fffffff;
            if (k in STOCK_BRUSH) brush = { color: STOCK_BRUSH[k], none: false };
            else if (k === 5) brush = { ...brush, none: true };
            else if (k in STOCK_PEN) pen = { color: STOCK_PEN[k], width: 1, none: false };
            else if (k === 8) pen = { ...pen, none: true };
          } else {
            const o = objs.get(id);
            if (o && o.pen) pen = o.pen;
            if (o && o.brush) brush = o.brush;
            if (o && o.font) font = o.font;
          }
          break;
        }
        case 27: cur = [n32(p, 8), n32(p, 12)]; if (path) { const q2 = pt(...cur); ctx.moveTo(q2[0], q2[1]); } break;
        case 54: {
          const a = pt(...cur), z = pt(n32(p, 8), n32(p, 12));
          if (!path) ctx.beginPath();
          ctx.moveTo(a[0], a[1]); ctx.lineTo(z[0], z[1]);
          if (!path) { strokeIt(); drew++; }
          cur = [n32(p, 8), n32(p, 12)];
          break;
        }
        case 3: case 4: case 6: case 86: case 87: case 89: {
          const small = type >= 86;
          const cnt = dv.getUint32(p + 24, 1 || true);
          const pts = [];
          for (let i = 0; i < cnt && i < 100000; i++) pts.push(small ? [dv.getInt16(p + 28 + i * 4, true), dv.getInt16(p + 30 + i * 4, true)] : [n32(p, 28 + i * 8), n32(p, 32 + i * 8)]);
          if (!pts.length) break;
          if (!path) ctx.beginPath();
          const start = type === 6 || type === 89 ? pt(...cur) : pt(...pts[0]);
          ctx.moveTo(start[0], start[1]);
          for (const q2 of type === 6 || type === 89 ? pts : pts.slice(1)) { const a = pt(...q2); ctx.lineTo(a[0], a[1]); }
          if (type === 3 || type === 86) ctx.closePath();
          if (!path) { if (type === 3 || type === 86) fillIt(); strokeIt(); drew++; }
          cur = pts[pts.length - 1];
          break;
        }
        case 43: case 42: case 44: {
          const [x1, y1] = pt(n32(p, 8), n32(p, 12)), [x2, y2] = pt(n32(p, 16), n32(p, 20));
          if (!path) ctx.beginPath();
          if (type === 42) ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
          else ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
          if (!path) { fillIt(); strokeIt(); drew++; }
          break;
        }
        case 59: path = true; ctx.beginPath(); break;
        case 60: path = null; break;
        case 61: ctx.closePath(); break;
        case 62: fillIt(); path = null; drew++; break;
        case 63: fillIt(); strokeIt(); drew++; break;
        case 64: strokeIt(); drew++; break;
        case 84: {
          const rx = n32(p, 36), ry = n32(p, 40), n = dv.getUint32(p + 44, true), off = dv.getUint32(p + 48, true);
          let str = "";
          for (let i = 0; i < n && i < 4000; i++) str += String.fromCharCode(dv.getUint16(p + off + i * 2, true));
          if (!str.trim()) break;
          const [x, y] = pt(rx, ry);
          const px = Math.max(4, font.h * unit());
          ctx.font = `${font.italic ? "italic " : ""}${font.bold ? "700 " : ""}${px}px ${fontFamily(font.face)}`;
          ctx.fillStyle = textColor;
          ctx.textAlign = (align & 6) === 6 ? "center" : (align & 6) === 2 ? "right" : "left";
          ctx.textBaseline = (align & 24) === 24 ? "alphabetic" : (align & 8) ? "bottom" : "top";
          if (bkMode === 2 && (align & 1) === 0 && false) { /* opaque text is drawn without its box */ }
          ctx.fillText(str, x, y);
          drew++;
          break;
        }
        case 81: {
          const [off, cb, offB, cbB] = [48, 52, 56, 60].map((o) => dv.getUint32(p + o, true));
          await draw(b, p + off, cb, p + offB, cbB, n32(p, 24), n32(p, 28), n32(p, 72), n32(p, 76));
          break;
        }
        case 76: case 77: {
          const [off, cb, offB, cbB] = [84, 88, 92, 96].map((o) => dv.getUint32(p + o, true));
          if (cb && cbB) await draw(b, p + off, cb, p + offB, cbB, n32(p, 24), n32(p, 28), n32(p, 32), n32(p, 36));
          break;
        }
        case 80: {
          const [off, cb, offB, cbB] = [48, 52, 56, 60].map((o) => dv.getUint32(p + o, true));
          await draw(b, p + off, cb, p + offB, cbB, n32(p, 24), n32(p, 28), n32(p, 40), n32(p, 44));
          break;
        }
        case 70:
          if (size > 20 && dv.getUint32(p + 12, true) === 0x2b464d45) await emfPlus(p + 4, size - 4);
          break;
        default:
      }
    } catch (err) {
      console.warn("emf record", type, err);
    }
    p += size;
  }
  if (!drew) return null;
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  if (!blob) return null;
  return { data: new Uint8Array(await blob.arrayBuffer()), type: "image/png" };
}
