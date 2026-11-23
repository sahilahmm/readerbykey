// Loaded only when a Word (.docx) or text (.txt) file is opened, so the app starts fast.
//
// readDocx() turns a Word file into a list of blocks, renderBlocks() draws them:
//   { type: "p", runs, align?, list?: { level, label } }     paragraph (or list item)
//   { type: "h", level, runs }                                 heading
//   { type: "table", rows: [[{ blocks, span }]] }              table
//   { type: "hr" }                                             page break
// A run is { t, b, i, u, s, v, c, hl, z, href } or { img, w, alt }.
// Nothing here uses innerHTML, and nothing is fetched: Word files are untrusted input.

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";

// limits, so a hostile or broken file can't use up the phone's memory
const MAX_FILE = 60 * 1024 * 1024; // the .docx itself
const MAX_XML = 40 * 1024 * 1024; // any one XML part once unzipped
const MAX_IMAGES_TOTAL = 60 * 1024 * 1024;
const MAX_IMAGES = 200;

const unsupported = (msg) => Object.assign(new Error(msg), { name: "Unsupported" });

/* ---------- Tiny zip reader (stored + deflate) ---------- */

async function inflateRaw(bytes, max) {
  if (typeof DecompressionStream === "undefined") throw new Error("no DecompressionStream");
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw unsupported("part too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export async function openZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let eocd = -1; // end of central directory sits within the last 64 KB
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw unsupported("not a zip");

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, {
      method: dv.getUint16(p + 10, true),
      csize: dv.getUint32(p + 20, true),
      usize: dv.getUint32(p + 24, true),
      local: dv.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    has: (name) => entries.has(name),
    size: (name) => (entries.has(name) ? entries.get(name).usize : 0),
    async get(name, max = MAX_XML) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.usize > max) throw unsupported("part too large");
      const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return data;
      if (e.method === 8) return inflateRaw(data, max);
      throw unsupported(`zip method ${e.method}`);
    },
  };
}

export async function readXml(zip, name) {
  const bytes = await zip.get(name);
  if (!bytes) return null;
  const text = new TextDecoder().decode(bytes);
  if (/<!ENTITY/i.test(text)) throw unsupported("entities are not allowed"); // entity-expansion bombs
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("bad xml");
  return doc;
}

/* ---------- Small XML helpers ---------- */

const kids = (el) => (el ? Array.from(el.children) : []);
const wChild = (el, name) => kids(el).find((c) => c.namespaceURI === W && c.localName === name) || null;
const wAttr = (el, name) => (el ? el.getAttributeNS(W, name) || el.getAttribute(`w:${name}`) || "" : "");
// <w:b/> means on, <w:b w:val="0"/> means off
const onoff = (el) => (el ? !/^(0|false|off)$/i.test(wAttr(el, "val")) : null);

/* ---------- Styles and numbering ---------- */

function readStyles(doc) {
  const out = { base: 22, byId: new Map() };
  if (!doc) return out;
  const dflt = doc.getElementsByTagNameNS(W, "rPrDefault")[0];
  const dsz = dflt && wChild(wChild(dflt, "rPr"), "sz");
  if (dsz) out.base = Number(wAttr(dsz, "val")) || 22;

  for (const s of doc.getElementsByTagNameNS(W, "style")) {
    const id = wAttr(s, "styleId");
    if (!id) continue;
    const pPr = wChild(s, "pPr");
    out.byId.set(id, {
      name: wAttr(wChild(s, "name"), "val"),
      basedOn: wAttr(wChild(s, "basedOn"), "val"),
      rPr: wChild(s, "rPr"),
      jc: wAttr(wChild(pPr, "jc"), "val"),
      outline: wChild(pPr, "outlineLvl") ? Number(wAttr(wChild(pPr, "outlineLvl"), "val")) : null,
      numPr: wChild(pPr, "numPr"),
    });
  }
  return out;
}

function readNumbering(doc) {
  const abstract = new Map();
  const nums = new Map();
  if (!doc) return { abstract, nums };
  for (const a of doc.getElementsByTagNameNS(W, "abstractNum")) {
    const levels = new Map();
    for (const l of kids(a).filter((c) => c.localName === "lvl")) {
      levels.set(Number(wAttr(l, "ilvl")), {
        fmt: wAttr(wChild(l, "numFmt"), "val") || "decimal",
        text: wAttr(wChild(l, "lvlText"), "val"),
        start: Number(wAttr(wChild(l, "start"), "val")) || 1,
      });
    }
    abstract.set(wAttr(a, "abstractNumId"), levels);
  }
  for (const n of doc.getElementsByTagNameNS(W, "num")) {
    nums.set(wAttr(n, "numId"), wAttr(wChild(n, "abstractNumId"), "val"));
  }
  return { abstract, nums };
}

const roman = (n) => {
  const t = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let s = "";
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
};
const letters = (n) => String.fromCharCode(96 + ((n - 1) % 26) + 1);

function numberLabel(fmt, n, level) {
  switch (fmt) {
    case "bullet":
      return ["•", "◦", "▪"][level % 3];
    case "none":
      return "";
    case "lowerLetter":
      return `${letters(n)}.`;
    case "upperLetter":
      return `${letters(n).toUpperCase()}.`;
    case "lowerRoman":
      return `${roman(n)}.`;
    case "upperRoman":
      return `${roman(n).toUpperCase()}.`;
    default:
      return `${n}.`;
  }
}

/* ---------- Reading a .docx ---------- */

export async function readDocx(blob) {
  if (blob.size > MAX_FILE) throw unsupported("file too large");
  const zip = await openZip(blob);
  const main = await readXml(zip, "word/document.xml");
  if (!main) throw unsupported("no document.xml");

  const styles = readStyles(await readXml(zip, "word/styles.xml"));
  const numbering = readNumbering(await readXml(zip, "word/numbering.xml"));

  // relationships: images and links
  const rels = new Map();
  const relDoc = await readXml(zip, "word/_rels/document.xml.rels");
  if (relDoc) {
    for (const r of relDoc.getElementsByTagName("Relationship")) {
      rels.set(r.getAttribute("Id"), { target: r.getAttribute("Target") || "", external: r.getAttribute("TargetMode") === "External" });
    }
  }

  const urls = []; // blob: URLs for pictures; the app revokes them when the file is closed
  const imageCache = new Map();
  let imageBytes = 0;

  async function pictureUrl(rid) {
    if (imageCache.has(rid)) return imageCache.get(rid);
    const rel = rels.get(rid);
    let url = null;
    if (rel && !rel.external && urls.length < MAX_IMAGES) {
      let path = rel.target.replace(/^\/+/, "");
      path = path.startsWith("word/") ? path : `word/${path}`;
      path = path.replace(/\/\.\//g, "/");
      const ext = (path.split(".").pop() || "").toLowerCase();
      const type = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: null }[ext];
      if (type && zip.has(path) && imageBytes + zip.size(path) <= MAX_IMAGES_TOTAL) {
        try {
          const bytes = await zip.get(path, MAX_IMAGES_TOTAL);
          imageBytes += bytes.length;
          url = URL.createObjectURL(new Blob([bytes], { type }));
          urls.push(url);
        } catch {
          /* skip a picture we can't read */
        }
      }
    }
    imageCache.set(rid, url);
    return url;
  }

  /* run formatting: the run's own settings win over its styles */
  function styleChain(id) {
    const chain = [];
    for (let s = styles.byId.get(id), n = 0; s && n < 6; s = styles.byId.get(s.basedOn), n++) chain.push(s);
    return chain;
  }
  function props(rPr, pStyleId, rStyleId) {
    const layers = [...styleChain(pStyleId).reverse(), ...styleChain(rStyleId).reverse()].map((s) => s.rPr);
    layers.push(rPr);
    const p = {};
    for (const l of layers) {
      if (!l) continue;
      for (const [key, name] of [["b", "b"], ["i", "i"], ["s", "strike"]]) {
        const v = onoff(wChild(l, name));
        if (v !== null) p[key] = v;
      }
      const u = wChild(l, "u");
      if (u) p.u = wAttr(u, "val") !== "none";
      const va = wAttr(wChild(l, "vertAlign"), "val");
      if (va) p.v = va === "superscript" ? "sup" : va === "subscript" ? "sub" : "";
      const c = wAttr(wChild(l, "color"), "val");
      if (c) p.c = /^[0-9a-f]{6}$/i.test(c) ? c : "";
      const hl = wAttr(wChild(l, "highlight"), "val");
      if (hl) p.hl = hl === "none" ? "" : hl;
      const sz = wAttr(wChild(l, "sz"), "val");
      if (sz) p.z = Number(sz) || 0;
    }
    return p;
  }

  /* walk one paragraph's content into runs */
  async function readRuns(node, ctx, out, link) {
    for (const el of kids(node)) {
      const ns = el.namespaceURI;
      if (ns === M) {
        if (el.localName === "oMath" || el.localName === "oMathPara") {
          const t = Array.from(el.getElementsByTagNameNS(M, "t")).map((x) => x.textContent).join("");
          if (t) out.push({ t, i: true, ...(link ? { href: link } : {}) });
        }
        continue;
      }
      if (el.localName === "Fallback") continue; // text boxes and shapes are stored twice
      if (ns !== W) {
        await readRuns(el, ctx, out, link); // mc:AlternateContent > mc:Choice, etc.
        continue;
      }
      switch (el.localName) {
        case "r": {
          const p = props(wChild(el, "rPr"), ctx.style, wAttr(wChild(wChild(el, "rPr"), "rStyle"), "val"));
          if (link) p.href = link;
          await readRun(el, p, out, ctx);
          break;
        }
        case "hyperlink": {
          const rel = rels.get(el.getAttributeNS(R, "id") || el.getAttribute("r:id") || "");
          const target = rel && rel.external ? rel.target : "";
          await readRuns(el, ctx, out, /^(https?:|mailto:|tel:)/i.test(target) ? target : link);
          break;
        }
        case "del":
        case "delText":
        case "pPr":
        case "bookmarkStart":
        case "bookmarkEnd":
          break; // deleted text, settings, markers
        default:
          await readRuns(el, ctx, out, link); // ins, smartTag, sdt, sdtContent, fldSimple...
      }
    }
  }

  async function readRun(r, p, out, ctx) {
    let text = "";
    const flush = () => {
      if (text) out.push({ ...p, t: text });
      text = "";
    };
    for (const el of kids(r)) {
      if (el.namespaceURI === M) continue;
      if (el.namespaceURI !== W) {
        if (el.localName === "AlternateContent") {
          // use the first choice only
          const choice = kids(el).find((c) => c.localName === "Choice");
          if (choice) {
            flush();
            await readRun(choice, p, out, ctx);
          }
        }
        continue;
      }
      switch (el.localName) {
        case "t":
          text += el.textContent;
          break;
        case "tab":
          text += " ";
          break;
        case "noBreakHyphen":
          text += "‑";
          break;
        case "softHyphen":
          break;
        case "sym": {
          const code = parseInt(wAttr(el, "char"), 16);
          if (code) text += String.fromCodePoint(code >= 0xf000 ? code - 0xf000 : code);
          break;
        }
        case "cr":
          text += "\n";
          break;
        case "br":
          if (wAttr(el, "type") === "page") {
            flush();
            out.push({ pageBreak: true });
          } else text += "\n";
          break;
        case "drawing":
        case "pict": {
          flush();
          const blip = el.getElementsByTagNameNS(A, "blip")[0];
          const old = el.getElementsByTagName("v:imagedata")[0];
          const rid = blip ? blip.getAttributeNS(R, "embed") || blip.getAttribute("r:embed") : old ? old.getAttributeNS(R, "id") || old.getAttribute("r:id") : "";
          const url = rid ? await pictureUrl(rid) : null;
          if (url) {
            const ext = el.getElementsByTagNameNS(WP, "extent")[0];
            const cx = ext ? Number(ext.getAttribute("cx")) / 9525 : 0;
            const doc = el.getElementsByTagNameNS(WP, "docPr")[0];
            out.push({ img: url, w: cx, alt: (doc && doc.getAttribute("descr")) || "", ...(p.href ? { href: p.href } : {}) });
          }
          break;
        }
        // rPr, lastRenderedPageBreak, footnoteReference, fldChar, instrText... carry no text of their own
      }
    }
    flush();
  }

  /* walk the body: paragraphs, tables, content controls */
  const counters = new Map();

  function listLabel(numPr, styleNumPr) {
    const np = numPr || styleNumPr;
    if (!np) return null;
    const numId = wAttr(wChild(np, "numId"), "val");
    if (!numId || numId === "0") return null;
    const level = Number(wAttr(wChild(np, "ilvl"), "val")) || 0;
    const levels = numbering.abstract.get(numbering.nums.get(numId));
    const def = (levels && levels.get(level)) || { fmt: "bullet", start: 1 };

    const key = numbering.nums.get(numId) || numId;
    const c = counters.get(key) || [];
    c[level] = (c[level] === undefined ? def.start - 1 : c[level]) + 1;
    c.length = level + 1; // a new item at this level restarts the deeper ones
    counters.set(key, c);
    return { level: Math.min(level, 4), label: numberLabel(def.fmt, c[level], level) };
  }

  async function readParagraph(p) {
    const pPr = wChild(p, "pPr");
    const styleId = wAttr(wChild(pPr, "pStyle"), "val");
    const chain = styleChain(styleId);

    const runs = [];
    await readRuns(p, { style: styleId }, runs, "");
    // glue neighbours with identical formatting, drop empties
    const merged = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && last.t !== undefined && r.t !== undefined && ["b", "i", "u", "s", "v", "c", "hl", "z", "href"].every((k) => last[k] === r[k])) last.t += r.t;
      else merged.push({ ...r });
    }

    const out = [];
    let cur = [];
    const pieces = [];
    for (const r of merged) {
      if (r.pageBreak) {
        pieces.push({ runs: cur });
        pieces.push({ hr: true });
        cur = [];
      } else cur.push(r);
    }
    pieces.push({ runs: cur });

    const jcRaw = wAttr(wChild(pPr, "jc"), "val") || (chain.find((s) => s.jc) || {}).jc || "";
    const align = { center: "center", right: "right", end: "right", both: "justify", distribute: "justify" }[jcRaw] || "";
    const outline = wChild(pPr, "outlineLvl") ? Number(wAttr(wChild(pPr, "outlineLvl"), "val")) : (chain.find((s) => s.outline !== null) || {}).outline ?? null;
    const name = (chain[0] && chain[0].name) || styleId;
    let level = 0;
    const hm = /^heading ?([1-9])$/i.exec(name) || /^heading([1-9])$/i.exec(styleId);
    if (hm) level = Number(hm[1]);
    else if (/^(title|subtitle)$/i.test(name)) level = 1;
    else if (outline !== null && outline < 9) level = outline + 1;
    const list = level ? null : listLabel(wChild(pPr, "numPr"), (chain.find((s) => s.numPr) || {}).numPr);
    const rtl = !!wChild(pPr, "bidi");

    for (const piece of pieces) {
      if (piece.hr) {
        out.push({ type: "hr" });
        continue;
      }
      const hasContent = piece.runs.some((r) => r.img || (r.t && r.t.trim()));
      if (!hasContent) continue;
      // trim spaces at the ends of the paragraph
      const first = piece.runs[0];
      const last = piece.runs[piece.runs.length - 1];
      if (first.t !== undefined) first.t = first.t.replace(/^[  ]+/, "");
      if (last.t !== undefined) last.t = last.t.replace(/[  \n]+$/, "");
      out.push(level ? { type: "h", level: level === 1 ? 1 : 2, runs: piece.runs, align } : { type: "p", runs: piece.runs, align, list, rtl });
    }
    return out;
  }

  async function readTable(tbl) {
    const rows = [];
    for (const tr of kids(tbl).filter((c) => c.namespaceURI === W && c.localName === "tr")) {
      const cells = [];
      for (const tc of kids(tr).filter((c) => c.namespaceURI === W && c.localName === "tc")) {
        const span = Number(wAttr(wChild(wChild(tc, "tcPr"), "gridSpan"), "val")) || 1;
        const blocks = [];
        await collect(tc, blocks);
        cells.push({ blocks, span });
      }
      if (cells.length) rows.push(cells);
    }
    return rows;
  }

  async function collect(node, out) {
    for (const el of kids(node)) {
      if (el.namespaceURI !== W) {
        if (el.localName === "AlternateContent") continue;
        continue;
      }
      if (el.localName === "p") out.push(...(await readParagraph(el)));
      else if (el.localName === "tbl") {
        const rows = await readTable(el);
        if (rows.length) out.push({ type: "table", rows });
      } else if (el.localName === "sdt" || el.localName === "sdtContent" || el.localName === "ins" || el.localName === "customXml" || el.localName === "smartTag") {
        await collect(el, out);
      }
    }
  }

  const body = main.getElementsByTagNameNS(W, "body")[0];
  const blocks = [];
  if (body) await collect(body, blocks);

  // text size: relative to the document's normal size, so titles stay bigger
  const base = styles.base || 22;
  const fix = (runs) => {
    for (const r of runs) {
      if (r.z) {
        const ratio = r.z / base;
        if (Math.abs(ratio - 1) > 0.12) r.z = Math.min(2.4, Math.max(0.7, ratio));
        else delete r.z;
      }
    }
  };
  const walk = (list) => {
    for (const b of list) {
      if (b.runs) fix(b.runs);
      if (b.type === "h") for (const r of b.runs) { delete r.z; delete r.c; } // headings have their own look
      if (b.rows) for (const row of b.rows) for (const c of row) walk(c.blocks);
    }
  };
  walk(blocks);

  return { blocks, urls };
}

/* ---------- Drawing blocks on screen ---------- */

const hasContrast = (hex) => {
  // Word often marks black or white text with an explicit color; skip those so Night/Dark stay readable
  const n = parseInt(hex, 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.2 && lum < 0.85;
};
const HIGHLIGHT = { yellow: "#fff3a0", green: "#b9f6ca", cyan: "#b2ebf2", magenta: "#f8bbd0", blue: "#bbdefb", red: "#ffcdd2", darkYellow: "#f5e6a0", lightGray: "#e0e0e0" };

function drawRuns(runs, parent) {
  for (const r of runs) {
    let node;
    if (r.img) {
      const img = document.createElement("img");
      img.src = r.img;
      img.alt = r.alt || "";
      img.loading = "lazy";
      if (r.w > 0) img.style.width = `min(${Math.round(r.w)}px, 100%)`;
      node = img;
    } else {
      node = document.createTextNode(r.t);
      if (r.hl && HIGHLIGHT[r.hl]) {
        const m = document.createElement("mark");
        m.style.background = HIGHLIGHT[r.hl];
        m.style.color = "#000";
        m.append(node);
        node = m;
      }
      for (const [flag, tag] of [["b", "strong"], ["i", "em"], ["u", "u"], ["s", "s"]]) {
        if (r[flag]) {
          const e = document.createElement(tag);
          e.append(node);
          node = e;
        }
      }
      if (r.v === "sup" || r.v === "sub") {
        const e = document.createElement(r.v);
        e.append(node);
        node = e;
      }
      if ((r.c && hasContrast(r.c)) || r.z) {
        const e = document.createElement("span");
        if (r.c && hasContrast(r.c)) e.style.color = `#${r.c}`;
        if (r.z) e.style.fontSize = `${r.z}em`;
        e.append(node);
        node = e;
      }
    }
    if (r.href) {
      const a = document.createElement("a");
      a.href = r.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.append(node);
      node = a;
    }
    parent.append(node);
  }
}

export function renderBlocks(blocks, root) {
  for (const b of blocks) {
    if (b.type === "hr") {
      const d = document.createElement("div");
      d.className = "pg";
      d.setAttribute("role", "separator");
      root.append(d);
    } else if (b.type === "h") {
      const h = document.createElement(b.level === 1 ? "h2" : "h3");
      h.dir = "auto";
      if (b.align) h.style.textAlign = b.align;
      drawRuns(b.runs, h);
      root.append(h);
    } else if (b.type === "table") {
      const wrap = document.createElement("div");
      wrap.className = "tw";
      const table = document.createElement("table");
      for (const row of b.rows) {
        const tr = document.createElement("tr");
        for (const cell of row) {
          const td = document.createElement("td");
          if (cell.span > 1) td.colSpan = Math.min(cell.span, 20);
          renderBlocks(cell.blocks, td);
          tr.append(td);
        }
        table.append(tr);
      }
      wrap.append(table);
      root.append(wrap);
    } else {
      const p = document.createElement("p");
      p.dir = b.rtl ? "rtl" : "auto";
      if (b.align) p.style.textAlign = b.align;
      if (b.list) {
        p.className = "li";
        p.style.setProperty("--lv", b.list.level);
        const lb = document.createElement("span");
        lb.className = "lb";
        lb.textContent = b.list.label;
        p.append(lb);
      }
      drawRuns(b.runs, p);
      root.append(p);
    }
  }
}

/* ---------- Plain text (.txt) ---------- */

export async function readText(blob) {
  if (blob.size > MAX_FILE) throw unsupported("file too large");
  const buf = new Uint8Array(await blob.arrayBuffer());
  let enc = "utf-8";
  if (buf[0] === 0xff && buf[1] === 0xfe) enc = "utf-16le";
  else if (buf[0] === 0xfe && buf[1] === 0xff) enc = "utf-16be";

  let text;
  try {
    text = new TextDecoder(enc, { fatal: enc === "utf-8" }).decode(buf);
  } catch {
    text = new TextDecoder("windows-1252").decode(buf); // old files that aren't UTF-8
  }
  text = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

  return text
    .split(/\n[ \t]*\n+/)
    .map((block) => {
      const lines = block.replace(/[ \t]+$/gm, "").replace(/^\n+|\n+$/g, "").split("\n");
      // hard-wrapped prose (long lines, no indents): let it reflow to the screen.
      // Poems, lists and code keep their line breaks.
      const prose = lines.length > 1 && lines.slice(0, -1).every((l) => l.length >= 45 && !/^\s/.test(l));
      return prose ? lines.join(" ").replace(/ {2,}/g, " ") : lines.join("\n");
    })
    .filter((p) => p.trim());
}
