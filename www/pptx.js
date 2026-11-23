// PowerPoint (.pptx / .ppsx) reader. Loaded only when a presentation is opened.
//
// readPptx(blob) turns the file into a model: one entry per slide with positioned items
// (shapes, text, pictures, lines, tables). drawSlide() paints a slide at its native size,
// and the reader scales it to the screen. outlineBlocks() gives the same deck as plain
// text for the Text view. Presentations are untrusted input: nothing here uses innerHTML,
// nothing is fetched, colours and fonts are validated, links are limited to safe schemes.

import { openZip, readXml } from "./docs.js";
import { renderEmf, bitmapFromWmf } from "./emf.js";

const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const EMU = 9525; // EMU per CSS pixel (96 dpi)
const MAX_FILE = 150 * 1024 * 1024;
const MAX_SLIDES = 1000;
const MAX_ITEMS = 2500; // per slide
const MAX_IMAGES = 300;
const MAX_IMAGE_BYTES = 80 * 1024 * 1024;

const unsupported = (msg) => Object.assign(new Error(msg), { name: "Unsupported" });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const px = (emu) => num(emu) / EMU;

const kids = (el) => (el ? Array.from(el.children) : []);
const c = (el, name) => kids(el).find((k) => k.localName === name) || null;
const cs = (el, name) => kids(el).filter((k) => k.localName === name);
const at = (el, name) => (el ? el.getAttribute(name) : null);
const rattr = (el, name) => (el ? el.getAttributeNS(R, name) || el.getAttribute(`r:${name}`) || "" : "");
const flag = (v) => v === "1" || v === "true";

/* ---------- colours ---------- */

const hex2 = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
const PRESET = { black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", gray: "808080", grey: "808080", orange: "FFA500", purple: "800080", cyan: "00FFFF", magenta: "FF00FF" };

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

// the colour child of a fill/line/run element, as a CSS colour; `ph` stands in for phClr
function colorOf(holder, ctx, ph) {
  const el = kids(holder).find((k) => /^(srgbClr|schemeClr|sysClr|prstClr)$/.test(k.localName));
  if (!el) return null;
  let hex = null;
  const v = at(el, "val");
  if (el.localName === "srgbClr") hex = v;
  else if (el.localName === "sysClr") hex = at(el, "lastClr") || (v === "window" ? "FFFFFF" : "000000");
  else if (el.localName === "prstClr") hex = PRESET[v] || "000000";
  else if (v === "phClr") hex = ph || "000000";
  else {
    const key = ctx.clrMap[v] || v;
    hex = ctx.theme[key] || ctx.theme[v] || "000000";
  }
  if (!/^[0-9a-fA-F]{6}$/.test(hex || "")) hex = "000000";
  let r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  let alpha = 1;
  for (const m of kids(el)) {
    const val = num(at(m, "val")) / 100000;
    if (m.localName === "lumMod" || m.localName === "lumOff" || m.localName === "satMod") {
      let [h, s, l] = rgbToHsl(r, g, b);
      if (m.localName === "lumMod") l *= val;
      else if (m.localName === "lumOff") l += val;
      else s *= val;
      [r, g, b] = hslToRgb(h, clamp(s, 0, 1), clamp(l, 0, 1));
    } else if (m.localName === "tint") {
      r = r * val + 255 * (1 - val); g = g * val + 255 * (1 - val); b = b * val + 255 * (1 - val);
    } else if (m.localName === "shade") {
      r *= val; g *= val; b *= val;
    } else if (m.localName === "alpha") alpha = clamp(val, 0, 1);
  }
  return alpha < 1 ? `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha.toFixed(2)})` : `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/* ---------- fonts ---------- */

const SANS = "system-ui,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";
const MONO = "ui-monospace,Menlo,Consolas,'Courier New',monospace";
function fontStack(face, ctx) {
  let f = face || "";
  if (f === "+mj-lt") f = ctx.fonts.major;
  else if (f === "+mn-lt") f = ctx.fonts.minor;
  if (/courier|consolas|mono|menlo|code/i.test(f)) return MONO;
  if (/times|georgia|cambria|garamond|palatino|book antiqua|serif$/i.test(f) && !/sans/i.test(f)) return SERIF;
  return SANS;
}

/* ---------- package helpers ---------- */

function resolve(base, target) {
  if (!target) return "";
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}
async function relsOf(zip, part) {
  const dir = part.split("/").slice(0, -1).join("/");
  const name = part.split("/").pop();
  const doc = await readXml(zip, `${dir ? dir + "/" : ""}_rels/${name}.rels`).catch(() => null);
  const map = new Map();
  if (doc) {
    for (const r of doc.getElementsByTagName("Relationship")) {
      const external = r.getAttribute("TargetMode") === "External";
      map.set(r.getAttribute("Id"), {
        type: (r.getAttribute("Type") || "").split("/").pop(),
        target: external ? r.getAttribute("Target") || "" : resolve(part, r.getAttribute("Target") || ""),
        external,
      });
    }
  }
  return map;
}
const firstRel = (rels, type) => [...rels.values()].find((r) => r.type === type) || null;


/* ---------- reading a presentation ---------- */

export async function readPptx(blob) {
  if (blob.size > MAX_FILE) throw unsupported("file too large");
  const zip = await openZip(blob);
  const pres = await readXml(zip, "ppt/presentation.xml");
  if (!pres) throw unsupported("not a presentation");
  const presRels = await relsOf(zip, "ppt/presentation.xml");

  const sz = pres.getElementsByTagNameNS("*", "sldSz")[0];
  const W = px(at(sz, "cx") || 9144000);
  const H = px(at(sz, "cy") || 6858000);

  const urls = [];
  const imageCache = new Map();
  let imageBytes = 0;
  async function imageUrl(path) {
    if (!path) return null;
    if (imageCache.has(path)) return imageCache.get(path);
    let url = null;
    const ext = (path.split(".").pop() || "").toLowerCase();
    let type = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" }[ext];
    if (!type && (ext === "emf" || ext === "wmf") && zip.has(path) && urls.length < MAX_IMAGES && imageBytes + zip.size(path) <= MAX_IMAGE_BYTES) {
      // old Office pictures: most are a photo or scan wrapped in a metafile, so lift the bitmap out
      try {
        const bytes = await zip.get(path, MAX_IMAGE_BYTES);
        imageBytes += bytes.length;
        const bmp = ext === "emf" ? await renderEmf(bytes) : bitmapFromWmf(bytes);
        if (bmp) {
          url = URL.createObjectURL(new Blob([bmp.data], { type: bmp.type }));
          urls.push(url);
        }
      } catch {
        /* leave it as a labelled box */
      }
      imageCache.set(path, url);
      return url;
    }
    if (type && zip.has(path) && urls.length < MAX_IMAGES && imageBytes + zip.size(path) <= MAX_IMAGE_BYTES) {
      try {
        const bytes = await zip.get(path, MAX_IMAGE_BYTES);
        imageBytes += bytes.length;
        url = URL.createObjectURL(new Blob([bytes], { type }));
        urls.push(url);
      } catch {
        /* skip a picture we can't read */
      }
    }
    imageCache.set(path, url);
    return url;
  }

  // layouts and masters are shared by many slides: read each once
  const masterCache = new Map();
  async function loadMaster(path) {
    if (masterCache.has(path)) return masterCache.get(path);
    const xml = await readXml(zip, path);
    const rels = await relsOf(zip, path);
    const themeRel = firstRel(rels, "theme");
    const themeXml = themeRel ? await readXml(zip, themeRel.target).catch(() => null) : null;
    const theme = {};
    const fonts = { major: "", minor: "" };
    if (themeXml) {
      const cm = themeXml.getElementsByTagNameNS("*", "clrScheme")[0];
      for (const k of kids(cm)) {
        const col = kids(k)[0];
        if (col) theme[k.localName] = at(col, "val") && col.localName === "srgbClr" ? at(col, "val") : at(col, "lastClr") || "000000";
      }
      const fs = themeXml.getElementsByTagNameNS("*", "fontScheme")[0];
      fonts.major = at(c(c(fs, "majorFont"), "latin"), "typeface") || "";
      fonts.minor = at(c(c(fs, "minorFont"), "latin"), "typeface") || "";
    }
    const cmEl = c(c(xml, "sldMaster") || xml.documentElement, "clrMap");
    const clrMap = {};
    if (cmEl) for (const a of cmEl.attributes) clrMap[a.name] = a.value;
    const m = { xml, rels, path, ctx: { theme, fonts, clrMap }, images: new Map() };
    masterCache.set(path, m);
    return m;
  }
  const layoutCache = new Map();
  async function loadLayout(path) {
    if (layoutCache.has(path)) return layoutCache.get(path);
    const xml = await readXml(zip, path);
    const rels = await relsOf(zip, path);
    const mRel = firstRel(rels, "slideMaster");
    const master = mRel ? await loadMaster(mRel.target) : null;
    const l = { xml, rels, path, master };
    layoutCache.set(path, l);
    return l;
  }

  const defaultTextStyle = c(pres.documentElement, "defaultTextStyle");

  const slides = [];
  const sldIds = pres.getElementsByTagNameNS("*", "sldId");
  let total = 0;
  for (const idEl of sldIds) {
    if (total++ >= MAX_SLIDES) break;
    const rel = presRels.get(rattr(idEl, "id"));
    if (!rel || !zip.has(rel.target)) continue;
    try {
      slides.push(await readSlide(rel.target, slides.length + 1));
    } catch (err) {
      console.warn("slide skipped", rel.target, err);
      slides.push({ bg: "#fff", items: [], title: "", paras: [], notes: "" });
    }
  }
  if (!slides.length) throw unsupported("no slides");

  /* ----- one slide ----- */
  async function readSlide(path, number) {
    const xml = await readXml(zip, path);
    const rels = await relsOf(zip, path);
    const layRel = firstRel(rels, "slideLayout");
    const layout = layRel ? await loadLayout(layRel.target) : null;
    const master = layout && layout.master;
    const ctx = master ? master.ctx : { theme: {}, fonts: { major: "", minor: "" }, clrMap: { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" } };
    if (!ctx.theme.dk1) Object.assign(ctx.theme, { dk1: "000000", lt1: "FFFFFF", dk2: "44546A", lt2: "E7E6E6", accent1: "4472C4" });

    const sld = xml.documentElement;
    const cSld = c(sld, "cSld");
    const model = { fonts: ctx.fonts, bg: null, items: [], title: "", paras: [], notes: "", number };

    // background: slide, else layout, else master
    const bgOf = async (root, rl) => {
      const bg = c(c(root.documentElement, "cSld"), "bg");
      if (!bg) return null;
      const bgPr = c(bg, "bgPr");
      if (bgPr) return fillCss(bgPr, ctx, null, rl, false);
      const ref = c(bg, "bgRef");
      if (ref) {
        const col = colorOf(ref, ctx, null);
        return col ? { css: col } : null;
      }
      return null;
    };
    const bg = (await bgOf(xml, rels)) || (layout && (await bgOf(layout.xml, layout.rels))) || (master && (await bgOf(master.xml, master.rels)));
    model.bg = bg ? bg.css : "#ffffff";

    const sctx = { ...ctx, defaultTextStyle, master, layout };

    // fill / line helpers need image loading, so they live in the async closure
    async function fillCss(spPr, cx, phClr, rl) {
      for (const k of kids(spPr)) {
        if (k.localName === "noFill") return { css: "none" };
        if (k.localName === "solidFill") {
          const col = colorOf(k, cx, phClr);
          return col ? { css: col } : null;
        }
        if (k.localName === "gradFill") {
          const stops = cs(c(k, "gsLst"), "gs")
            .map((g) => ({ pos: clamp(num(at(g, "pos")) / 1000, 0, 100), col: colorOf(g, cx, phClr) }))
            .filter((s) => s.col);
          if (!stops.length) return null;
          const list = stops.map((s) => `${s.col} ${s.pos}%`).join(",");
          const lin = c(k, "lin");
          if (lin) return { css: `linear-gradient(${(num(at(lin, "ang")) / 60000 + 90).toFixed(1)}deg,${list})` };
          return { css: stops.length === 1 ? stops[0].col : `radial-gradient(circle,${list})` };
        }
        if (k.localName === "pattFill") {
          const col = colorOf(c(k, "fgClr"), cx, phClr) || colorOf(k, cx, phClr);
          return col ? { css: col } : null;
        }
        if (k.localName === "blipFill") {
          const blip = c(k, "blip");
          const rel = rl && rl.get(rattr(blip, "embed"));
          const url = rel && !rel.external ? await imageUrl(rel.target) : null;
          return url ? { img: url } : null;
        }
      }
      return null;
    }
    const lineOf = (spPr, style, cx) => {
      const ln = c(spPr, "ln");
      const refEl = c(style, "lnRef");
      let width = null, color = null, dash = "solid", on = false;
      if (refEl && num(at(refEl, "idx")) > 0) {
        on = true;
        color = colorOf(refEl, cx, null);
        width = px(num(at(refEl, "idx")) * 9525 * 1.3);
      }
      if (ln) {
        if (c(ln, "noFill")) return null;
        if (at(ln, "w")) width = px(at(ln, "w"));
        const sf = c(ln, "solidFill");
        if (sf) {
          color = colorOf(sf, cx, null);
          on = true;
        }
        const d = at(c(ln, "prstDash"), "val");
        if (d) dash = /dot|sysDot/i.test(d) && !/dash/i.test(d) ? "dotted" : d === "solid" ? "solid" : "dashed";
        if (c(ln, "gradFill")) on = true;
        if (width === null) width = 1.33;
      }
      if (!on || !color) return null;
      return { w: Math.max(0.75, width || 1.33), color, dash };
    };

    /* placeholders: find the matching shape in the layout, then the master */
    const phKey = (sp) => {
      const ph = c(c(c(sp, "nvSpPr") || c(sp, "nvPicPr"), "nvPr"), "ph");
      return ph ? { type: at(ph, "type") || "body", idx: at(ph, "idx") } : null;
    };
    const normType = (t) => (t === "ctrTitle" ? "title" : t === "subTitle" ? "body" : t === "obj" || t === "tbl" || t === "chart" || t === "pic" ? "body" : t);
    const spTreeOf = (root) => c(c(root.documentElement, "cSld"), "spTree");
    const findPh = (root, key) => {
      if (!root || !key) return null;
      const tree = spTreeOf(root);
      const all = kids(tree).filter((k) => k.localName === "sp");
      return (
        all.find((s) => {
          const k = phKey(s);
          return k && key.idx && k.idx === key.idx && normType(k.type) === normType(key.type);
        }) ||
        all.find((s) => {
          const k = phKey(s);
          return k && normType(k.type) === normType(key.type) && (!key.idx || !k.idx || key.type === "title");
        }) ||
        all.find((s) => {
          const k = phKey(s);
          return k && key.idx && k.idx === key.idx;
        }) ||
        null
      );
    };
    const xfrmOf = (sp) => c(c(sp, "spPr"), "xfrm") || c(sp, "xfrm") || c(c(sp, "grpSpPr"), "xfrm");

    /* text styles */
    const styleGroup = (key) => {
      const t = key ? normType(key.type) : null;
      const tx = master && c(c(master.xml.documentElement, "txStyles"), t === "title" ? "titleStyle" : t === "body" ? "bodyStyle" : "otherStyle");
      return key ? tx : defaultTextStyle;
    };

    const bulletGlyph = (ch, font) => {
      if (!ch) return "•";
      if (/wingdings|symbol/i.test(font || "")) {
        return { "§": "▪", "Ø": "➢", "ü": "✓", "q": "❑", "v": "❖", "·": "•", "": "•", "": "▪", "": "•", "": "•", o: "○", "n": "■", "l": "●", "u": "◆" }[ch] || "•";
      }
      return ch;
    };

    /* a text body into paragraphs with every inherited property resolved */
    function readText(txBody, key, phChain, shapeColor) {
      if (!txBody) return null;
      const chain = [styleGroup(key), ...phChain.map((s) => c(c(s, "txBody"), "lstStyle")), c(txBody, "lstStyle")].filter(Boolean);
      const bodyPr = c(txBody, "bodyPr");
      const paras = [];
      const nums = [];
      for (const p of cs(txBody, "p")) {
        const pPr = c(p, "pPr");
        const lvl = clamp(num(at(pPr, "lvl")), 0, 8);
        const layers = chain.map((l) => c(l, `lvl${lvl + 1}pPr`)).filter(Boolean);
        if (pPr) layers.push(pPr);
        const pp = { algn: null, marL: 0, indent: 0, bu: null, buClr: null, spcBef: 0, spcAft: 0, lnSpc: null, rtl: false, defs: [] };
        for (const l of layers) {
          if (at(l, "algn")) pp.algn = at(l, "algn");
          if (at(l, "marL") !== null) pp.marL = px(at(l, "marL"));
          if (at(l, "indent") !== null) pp.indent = px(at(l, "indent"));
          if (at(l, "rtl") !== null) pp.rtl = flag(at(l, "rtl"));
          if (c(l, "buNone")) pp.bu = null;
          const bc = c(l, "buChar");
          if (bc) pp.bu = { ch: at(bc, "char"), font: at(c(l, "buFont"), "typeface") };
          const ba = c(l, "buAutoNum");
          if (ba) pp.bu = { auto: at(ba, "type") || "arabicPeriod", start: num(at(ba, "startAt"), 1) };
          const bclr = c(l, "buClr");
          if (bclr) pp.buClr = colorOf(bclr, sctx, null);
          for (const [tag, field] of [["spcBef", "spcBef"], ["spcAft", "spcAft"]]) {
            const s = c(l, tag);
            if (s) pp[field] = c(s, "spcPts") ? { pt: num(at(c(s, "spcPts"), "val")) / 100 } : c(s, "spcPct") ? { pct: num(at(c(s, "spcPct"), "val")) / 100000 } : 0;
          }
          const ls = c(l, "lnSpc");
          if (ls) pp.lnSpc = c(ls, "spcPct") ? { pct: num(at(c(ls, "spcPct"), "val")) / 100000 } : c(ls, "spcPts") ? { pt: num(at(c(ls, "spcPts"), "val")) / 100 } : null;
          const d = c(l, "defRPr");
          if (d) pp.defs.push(d);
        }

        const runs = [];
        let text = "";
        for (const r of kids(p)) {
          if (r.localName === "br") {
            runs.push({ br: true });
            text += "\n";
            continue;
          }
          if (r.localName !== "r" && r.localName !== "fld") continue;
          const t = c(r, "t") ? c(r, "t").textContent : "";
          if (!t) continue;
          const rPr = c(r, "rPr");
          const defs = [...pp.defs, rPr].filter(Boolean);
          const rp = { t, sz: null, b: false, i: false, u: false, s: false, color: null, font: "", base: 0, cap: false, href: "" };
          for (const d of defs) {
            if (at(d, "sz")) rp.sz = num(at(d, "sz")) / 100;
            if (at(d, "b") !== null) rp.b = flag(at(d, "b"));
            if (at(d, "i") !== null) rp.i = flag(at(d, "i"));
            if (at(d, "u") !== null) rp.u = at(d, "u") !== "none";
            if (at(d, "strike") !== null) rp.s = at(d, "strike") !== "noStrike";
            if (at(d, "baseline") !== null) rp.base = num(at(d, "baseline"));
            if (at(d, "cap") !== null) rp.cap = at(d, "cap") === "all";
            const sf = c(d, "solidFill");
            if (sf) rp.color = colorOf(sf, sctx, null);
            const lat = c(d, "latin");
            if (lat && at(lat, "typeface")) rp.font = at(lat, "typeface");
            const hl = c(d, "hlinkClick");
            if (hl) {
              const rel = rels.get(rattr(hl, "id"));
              if (rel && rel.external && /^(https?:|mailto:|tel:)/i.test(rel.target)) rp.href = rel.target;
            }
          }
          if (r.localName === "fld" && /slidenum/i.test(at(r, "type") || "")) rp.t = String(number);
          runs.push(rp);
          text += rp.t;
        }
        const endSz = at(c(p, "endParaRPr"), "sz") ? num(at(c(p, "endParaRPr"), "sz")) / 100 : null;

        // numbering
        let bullet = null;
        if (pp.bu && text.trim()) {
          if (pp.bu.auto) {
            nums[lvl] = nums[lvl] === undefined ? pp.bu.start : nums[lvl] + 1;
            nums.length = lvl + 1;
            bullet = autoLabel(pp.bu.auto, nums[lvl]);
          } else {
            nums.length = Math.min(nums.length, lvl);
            bullet = bulletGlyph(pp.bu.ch, pp.bu.font);
          }
        } else nums.length = Math.min(nums.length, lvl);

        paras.push({ lvl, algn: pp.algn, marL: pp.marL, indent: pp.indent, bullet, buClr: pp.buClr, spcBef: pp.spcBef, spcAft: pp.spcAft, lnSpc: pp.lnSpc, rtl: pp.rtl, runs, text, endSz });
      }

      const vert = at(bodyPr, "vert");
      const fit = c(bodyPr, "normAutofit");
      return {
        paras,
        anchor: at(bodyPr, "anchor") || null,
        ins: [at(bodyPr, "lIns"), at(bodyPr, "tIns"), at(bodyPr, "rIns"), at(bodyPr, "bIns")].map((v, i) => (v === null ? null : px(v))),
        wrap: at(bodyPr, "wrap") !== "none",
        vert: vert && vert !== "horz" ? vert : null,
        fit: !!fit,
        fontScale: fit && at(fit, "fontScale") ? num(at(fit, "fontScale")) / 100000 : 1,
        shapeColor,
      };
    }

    /* ----- walking the shape tree ----- */
    const items = [];
    let count = 0;
    const idTf = { ax: 0, ay: 0, sx: 1, sy: 1 };

    async function walk(tree, tf, layer, rl) {
      for (const el of kids(tree)) {
        if (count > MAX_ITEMS) return;
        try {
          switch (el.localName) {
            case "sp":
            case "cxnSp":
              await shape(el, tf, layer, rl);
              break;
            case "pic":
              await picture(el, tf, layer, rl);
              break;
            case "grpSp": {
              const gx = c(c(el, "grpSpPr"), "xfrm");
              if (!gx) {
                await walk(el, tf, layer, rl);
                break;
              }
              const off = c(gx, "off"), ext = c(gx, "ext"), choff = c(gx, "chOff"), chext = c(gx, "chExt");
              const cx = num(at(ext, "cx"), 1), cy = num(at(ext, "cy"), 1);
              const chcx = num(at(chext, "cx"), cx) || 1, chcy = num(at(chext, "cy"), cy) || 1;
              const kx = (cx / chcx) * tf.sx, ky = (cy / chcy) * tf.sy;
              await walk(
                el,
                {
                  ax: tf.ax + tf.sx * (num(at(off, "x")) - num(at(choff, "x")) * (cx / chcx)),
                  ay: tf.ay + tf.sy * (num(at(off, "y")) - num(at(choff, "y")) * (cy / chcy)),
                  sx: kx,
                  sy: ky,
                },
                layer,
                rl
              );
              break;
            }
            case "graphicFrame":
              await frame(el, tf, layer, rl);
              break;
            case "AlternateContent": {
              const choice = c(el, "Choice") || c(el, "Fallback");
              if (choice) await walk(choice, tf, layer, rl);
              break;
            }
            default:
          }
        } catch (err) {
          console.warn("shape skipped", err);
        }
      }
    }

    const rectOf = (xf, tf) => {
      if (!xf) return null;
      const off = c(xf, "off"), ext = c(xf, "ext");
      if (!off || !ext) return null;
      return {
        x: px(tf.ax + tf.sx * num(at(off, "x"))),
        y: px(tf.ay + tf.sy * num(at(off, "y"))),
        w: px(tf.sx * num(at(ext, "cx"))),
        h: px(tf.sy * num(at(ext, "cy"))),
        rot: num(at(xf, "rot")) / 60000,
        flipH: flag(at(xf, "flipH")),
        flipV: flag(at(xf, "flipV")),
      };
    };

    async function shape(sp, tf, layer, rl) {
      const key = phKey(sp);
      if (layer !== "slide" && key) return; // layouts and masters only contribute their decorations
      const spPr = c(sp, "spPr");
      const style = c(sp, "style");

      // placeholders inherit position and text style from the layout, then the master
      const lSp = key ? findPh(layout && layout.xml, key) : null;
      const mSp = key ? findPh(master && master.xml, key) : null;
      let rect = rectOf(xfrmOf(sp), tf);
      if (!rect && lSp) rect = rectOf(xfrmOf(lSp), idTf);
      if (!rect && mSp) rect = rectOf(xfrmOf(mSp), idTf);
      if (!rect) return;
      if (key && (key.type === "dt" || key.type === "ftr" || key.type === "sldNum") && !c(sp, "txBody")) return;

      const geomEl = c(spPr, "prstGeom");
      const cust = c(spPr, "custGeom");
      const prst = geomEl ? at(geomEl, "prst") : cust ? "custom" : "rect";
      const isLine = sp.localName === "cxnSp" || /^(line|straightConnector1|bentConnector\d|curvedConnector\d)$/.test(prst);

      let fill = null;
      if (spPr) fill = await fillCss(spPr, sctx, null, rl);
      if (!fill && style && !isLine) {
        const fr = c(style, "fillRef");
        if (fr && num(at(fr, "idx")) > 0) {
          const col = colorOf(fr, sctx, null);
          if (col) fill = { css: col };
        }
      }
      if (fill && fill.css === "none") fill = null;
      if (key && !fill && layout) {
        // a placeholder with its own fill in the layout
        const lp = c(lSp, "spPr");
        if (lp) {
          const f = await fillCss(lp, sctx, null, layout.rels);
          if (f && f.css !== "none") fill = f;
        }
      }
      const line = lineOf(spPr, style, sctx);

      if (isLine) {
        items.push({ t: "line", ...rect, line: line || { w: 1.33, color: "#000", dash: "solid" } });
        count++;
        return;
      }

      const adj = geomEl ? num(at(c(c(geomEl, "avLst"), "gd"), "fmla") && at(c(c(geomEl, "avLst"), "gd"), "fmla").replace(/[^0-9-]/g, ""), 0) : 0;
      const geom = { prst, adj: adj || 0, path: cust ? readCustPath(cust) : null };

      const phChain = [mSp, lSp].filter(Boolean);
      const fontRef = c(style, "fontRef");
      const shapeColor = fontRef ? colorOf(fontRef, sctx, null) : null;
      const text = readText(c(sp, "txBody"), key, phChain, shapeColor);
      const hasText = text && text.paras.some((p) => p.text.trim());

      const item = { t: "shape", ...rect, geom, fill, line, text: hasText ? text : null, isTitle: !!(key && (key.type === "title" || key.type === "ctrTitle")), ph: !!key };
      items.push(item);
      count++;
      if (layer === "slide" && hasText) {
        if (item.isTitle && !model.title) model.title = text.paras.map((p) => p.text).join(" ").trim();
        else if (!key || key.type !== "sldNum") model.paras.push({ shape: item, text });
      }
    }

    function readCustPath(cust) {
      const list = c(cust, "pathLst");
      const p = list && c(list, "path");
      if (!p) return null;
      const w = num(at(p, "w")), h = num(at(p, "h"));
      const cmds = [];
      for (const k of kids(p)) {
        const pts = cs(k, "pt").map((q) => [num(at(q, "x")), num(at(q, "y"))]);
        if (k.localName === "moveTo" && pts[0]) cmds.push(["M", pts[0]]);
        else if (k.localName === "lnTo" && pts[0]) cmds.push(["L", pts[0]]);
        else if (k.localName === "cubicBezTo" && pts.length === 3) cmds.push(["C", ...pts]);
        else if (k.localName === "quadBezTo" && pts.length === 2) cmds.push(["Q", ...pts]);
        else if (k.localName === "close") cmds.push(["Z"]);
        if (cmds.length > 4000) break;
      }
      return cmds.length > 1 ? { w, h, cmds } : null;
    }

    async function picture(pic, tf, layer, rl) {
      // a picture dropped into a placeholder has no position of its own: it takes the layout's
      let rect = rectOf(c(c(pic, "spPr"), "xfrm"), tf);
      if (!rect) {
        const key = phKey(pic);
        const lSp = key ? findPh(layout && layout.xml, key) : null;
        const mSp = key ? findPh(master && master.xml, key) : null;
        rect = (lSp && rectOf(xfrmOf(lSp), idTf)) || (mSp && rectOf(xfrmOf(mSp), idTf));
      }
      if (!rect) return;
      const blip = c(c(pic, "blipFill"), "blip");
      const rel = rl && rl.get(rattr(blip, "embed")) || rl && rl.get(rattr(blip, "link"));
      const url = rel && !rel.external ? await imageUrl(rel.target) : null;
      if (!url) {
        // a format we can't draw (EMF, WMF, TIFF...): keep its place so the slide isn't silently empty
        if (layer === "slide") {
          items.push({ t: "note", ...rect, label: rel && rel.target ? `Picture (.${(rel.target.split(".").pop() || "").toLowerCase().slice(0, 5)})` : "Picture" });
          count++;
        }
        return;
      }
      const sr = c(c(pic, "blipFill"), "srcRect");
      const crop = { l: num(at(sr, "l")) / 100000, t: num(at(sr, "t")) / 100000, r: num(at(sr, "r")) / 100000, b: num(at(sr, "b")) / 100000 };
      const alt = at(c(c(pic, "nvPicPr"), "cNvPr"), "descr") || "";
      const geomEl = c(c(pic, "spPr"), "prstGeom");
      items.push({ t: "pic", ...rect, url, crop, alt, round: geomEl && at(geomEl, "prst") === "ellipse" });
      count++;
      if (layer === "slide" && alt) model.paras.push({ alt });
    }

    async function frame(gf, tf, layer, rl) {
      const rect = rectOf(c(gf, "xfrm"), tf);
      if (!rect) return;
      const data = c(c(gf, "graphic"), "graphicData");
      const tbl = data && c(data, "tbl");
      if (tbl) {
        items.push({ t: "table", ...rect, table: readTable(tbl), tf });
        count++;
        if (layer === "slide") model.paras.push({ table: items[items.length - 1].table });
        return;
      }
      const uri = at(data, "uri") || "";
      if (/diagram/i.test(uri) && layer === "slide") {
        // SmartArt: PowerPoint keeps a ready-drawn copy next to the data
        const dr = [...rl.values()].find((r) => r.type === "diagramDrawing");
        if (dr && zip.has(dr.target)) {
          const dxml = await readXml(zip, dr.target);
          const drels = await relsOf(zip, dr.target);
          const tree = c(dxml.documentElement, "spTree");
          const shiftTf = { ax: tf.ax + tf.sx * num(at(c(c(gf, "xfrm"), "off"), "x")), ay: tf.ay + tf.sy * num(at(c(c(gf, "xfrm"), "off"), "y")), sx: tf.sx, sy: tf.sy };
          for (const sp of kids(tree).filter((k) => k.localName === "sp")) {
            await smartShape(sp, shiftTf, drels);
          }
          return;
        }
      }
      if (/chart/i.test(uri)) {
        items.push({ t: "note", ...rect, label: "Chart" });
        count++;
        if (layer === "slide") model.paras.push({ alt: "Chart" });
      }
    }

    async function smartShape(sp, tf, drels) {
      const rect = rectOf(c(sp, "spPr") && c(c(sp, "spPr"), "xfrm"), tf);
      if (!rect) return;
      const spPr = c(sp, "spPr");
      const style = c(sp, "style");
      let fill = await fillCss(spPr, sctx, null, drels);
      if (!fill && style && c(style, "fillRef") && num(at(c(style, "fillRef"), "idx")) > 0) {
        const col = colorOf(c(style, "fillRef"), sctx, null);
        if (col) fill = { css: col };
      }
      if (fill && fill.css === "none") fill = null;
      const geomEl = c(spPr, "prstGeom");
      const text = readText(c(sp, "txBody"), null, [], colorOf(c(style, "fontRef"), sctx, null));
      const hasText = text && text.paras.some((p) => p.text.trim());
      items.push({ t: "shape", ...rect, geom: { prst: geomEl ? at(geomEl, "prst") : "rect", adj: 0, path: null }, fill, line: lineOf(spPr, style, sctx), text: hasText ? text : null, isTitle: false, ph: false });
      count++;
      if (hasText) model.paras.push({ shape: items[items.length - 1], text });
    }

    function readTable(tbl) {
      const cols = cs(c(tbl, "tblGrid"), "gridCol").map((g) => px(at(g, "w")));
      const pr = c(tbl, "tblPr");
      const header = flag(at(pr, "firstRow"));
      const band = flag(at(pr, "bandRow"));
      const rows = cs(tbl, "tr").map((tr, ri) => ({
        h: px(at(tr, "h")),
        header: header && ri === 0,
        band: band && (header ? ri > 0 && ri % 2 === 1 : ri % 2 === 0),
        cells: cs(tr, "tc").map((tc) => {
          const tcPr = c(tc, "tcPr");
          const tx = readText(c(tc, "txBody"), null, [], null);
          let fill = null;
          const sf = c(tcPr, "solidFill");
          if (sf) fill = colorOf(sf, sctx, null);
          return {
            paras: tx ? tx.paras : [],
            fill,
            span: num(at(tc, "gridSpan"), 1),
            rowSpan: num(at(tc, "rowSpan"), 1),
            hMerge: flag(at(tc, "hMerge")),
            vMerge: flag(at(tc, "vMerge")),
            anchor: at(tcPr, "anchor") || "t",
            pad: [at(tcPr, "marL"), at(tcPr, "marT"), at(tcPr, "marR"), at(tcPr, "marB")].map((v, i) => (v === null ? [9.6, 4.8, 9.6, 4.8][i] : px(v))),
          };
        }),
      }));
      return { cols, rows, accent: colorOf({ children: [] }, sctx, null) || null };
    }

    // draw order: master decorations, layout decorations, then the slide itself
    const showMaster = at(sld, "showMasterSp") !== "0";
    if (showMaster && master && layout && at(layout.xml.documentElement, "showMasterSp") !== "0") await walk(spTreeOf(master.xml), idTf, "master", master.rels);
    if (showMaster && layout) await walk(spTreeOf(layout.xml), idTf, "layout", layout.rels);
    await walk(c(cSld, "spTree"), idTf, "slide", rels);
    model.items = items;
    model.accent = ctx.theme.accent1 ? `#${ctx.theme.accent1}` : "#4472C4";
    model.lt1 = ctx.theme.lt1 ? `#${ctx.theme.lt1}` : "#FFFFFF";

    // speaker notes
    const nRel = firstRel(rels, "notesSlide");
    if (nRel && zip.has(nRel.target)) {
      try {
        const nx = await readXml(zip, nRel.target);
        const parts = [];
        for (const sp of nx.getElementsByTagNameNS("*", "sp")) {
          const ph = phKey(sp);
          if (ph && ph.type === "body") for (const p of sp.getElementsByTagNameNS("*", "p")) {
            const t = Array.from(p.getElementsByTagNameNS("*", "t")).map((x) => x.textContent).join("");
            if (t.trim()) parts.push(t.trim());
          }
        }
        model.notes = parts.join("\n");
      } catch {
        /* notes are optional */
      }
    }
    return model;
  }

  return { w: W, h: H, slides, urls };
}

function autoLabel(type, n) {
  const m = /^(arabic|alphaLc|alphaUc|romanLc|romanUc)(Period|ParenR|ParenBoth|Plain)?/.exec(type) || [];
  const roman = (v) => {
    const t = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
    let s = "";
    for (const [k, r] of t) while (v >= k) { s += r; v -= k; }
    return s;
  };
  const letters = (v) => String.fromCharCode(96 + ((v - 1) % 26) + 1);
  const core = { arabic: String(n), alphaLc: letters(n), alphaUc: letters(n).toUpperCase(), romanLc: roman(n), romanUc: roman(n).toUpperCase() }[m[1] || "arabic"];
  const suffix = m[2] || "Period";
  return suffix === "ParenBoth" ? `(${core})` : suffix === "ParenR" ? `${core})` : suffix === "Plain" ? core : `${core}.`;
}

/* ---------- drawing a slide ---------- */

const POLY = {
  triangle: "50% 0,100% 100%,0 100%",
  rtTriangle: "0 0,100% 100%,0 100%",
  diamond: "50% 0,100% 50%,50% 100%,0 50%",
  parallelogram: "25% 0,100% 0,75% 100%,0 100%",
  trapezoid: "20% 0,80% 0,100% 100%,0 100%",
  hexagon: "25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%",
  pentagon: "50% 0,100% 38%,82% 100%,18% 100%,0 38%",
  octagon: "30% 0,70% 0,100% 30%,100% 70%,70% 100%,30% 100%,0 70%,0 30%",
  rightArrow: "0 25%,60% 25%,60% 0,100% 50%,60% 100%,60% 75%,0 75%",
  leftArrow: "100% 25%,40% 25%,40% 0,0 50%,40% 100%,40% 75%,100% 75%",
  upArrow: "25% 100%,25% 40%,0 40%,50% 0,100% 40%,75% 40%,75% 100%",
  downArrow: "25% 0,75% 0,75% 60%,100% 60%,50% 100%,0 60%,25% 60%",
  chevron: "0 0,70% 0,100% 50%,70% 100%,0 100%,30% 50%",
  homePlate: "0 0,75% 0,100% 50%,75% 100%,0 100%",
  star5: "50% 0,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%",
  plus: "35% 0,65% 0,65% 35%,100% 35%,100% 65%,65% 65%,65% 100%,35% 100%,35% 65%,0 65%,0 35%,35% 35%",
  mathPlus: "35% 0,65% 0,65% 35%,100% 35%,100% 65%,65% 65%,65% 100%,35% 100%,35% 65%,0 65%,0 35%,35% 35%",
};

const SVGNS = "http://www.w3.org/2000/svg";
const pxs = (v) => `${(Math.round(v * 100) / 100).toFixed(2)}px`;

function paragraphBox(p, k, baseColor, ctxFonts, defaultSz) {
  const div = document.createElement("div");
  const sizes = p.runs.map((r) => r.sz).filter(Boolean);
  const size = (sizes[0] || p.endSz || defaultSz) * (4 / 3);
  div.dir = p.rtl ? "rtl" : "auto";
  let align = { l: "left", ctr: "center", r: "right", just: "justify", dist: "justify" }[p.algn] || "left";
  if (p.rtl && align === "left") align = "right";
  else if (p.rtl && align === "right") align = "left";
  div.style.textAlign = align;
  div.style.fontSize = `calc(var(--k,1) * ${pxs(size)})`;
  const lh = p.lnSpc ? (p.lnSpc.pct ? p.lnSpc.pct * 1.2 : p.lnSpc.pt ? (p.lnSpc.pt * 4) / 3 / size : 1.2) : 1.2;
  div.style.lineHeight = String(Math.round(lh * 100) / 100);
  const gap = (s) => (!s ? 0 : s.pt ? (s.pt * 4) / 3 : s.pct ? s.pct * size : 0);
  div.style.marginTop = `calc(var(--k,1) * ${pxs(gap(p.spcBef))})`;
  div.style.marginBottom = `calc(var(--k,1) * ${pxs(gap(p.spcAft))})`;
  div.style.whiteSpace = "pre-wrap";
  div.style.overflowWrap = "break-word";
  div.style.minHeight = "1em";
  const ind = p.bullet ? p.indent : p.indent;
  if (p.rtl) div.style.paddingRight = pxs(p.marL);
  else div.style.paddingLeft = pxs(p.marL);
  if (p.bullet) {
    const b = document.createElement("span");
    b.textContent = p.bullet;
    b.style.display = "inline-block";
    b.style.width = pxs(Math.max(size * 0.6, -ind));
    b.style.marginLeft = p.rtl ? "0" : pxs(Math.min(0, ind));
    b.style.textIndent = "0";
    if (p.buClr) b.style.color = p.buClr;
    div.append(b);
    if (-ind < size * 0.6) div.style.paddingLeft = pxs(p.marL + (size * 0.6 + ind));
  } else if (ind) div.style.textIndent = pxs(ind);

  for (const r of p.runs) {
    if (r.br) {
      div.append(document.createElement("br"));
      continue;
    }
    let node = document.createTextNode(r.cap ? r.t.toUpperCase() : r.t);
    const span = document.createElement(r.href ? "a" : "span");
    if (r.href) {
      span.href = r.href;
      span.target = "_blank";
      span.rel = "noopener noreferrer";
    }
    if (r.sz) span.style.fontSize = `calc(var(--k,1) * ${pxs(r.sz * (4 / 3))})`;
    if (r.b) span.style.fontWeight = "700";
    if (r.i) span.style.fontStyle = "italic";
    const deco = [r.u ? "underline" : "", r.s ? "line-through" : ""].filter(Boolean).join(" ");
    if (deco) span.style.textDecoration = deco;
    span.style.color = r.color || baseColor;
    if (r.font) span.style.fontFamily = fontStack(r.font, { fonts: ctxFonts });
    if (r.base) {
      span.style.verticalAlign = r.base > 0 ? "super" : "sub";
      span.style.fontSize = `calc(var(--k,1) * ${pxs((r.sz || defaultSz) * (4 / 3) * 0.65)})`;
    }
    span.append(node);
    div.append(span);
  }
  return div;
}

function textBox(text, rect, deck, defaultColor) {
  const box = document.createElement("div");
  box.className = "tb";
  box.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden;";
  const [l, t, r, b] = [text.ins[0] ?? 9.6, text.ins[1] ?? 4.8, text.ins[2] ?? 9.6, text.ins[3] ?? 4.8];
  box.style.padding = `${pxs(t)} ${pxs(r)} ${pxs(b)} ${pxs(l)}`;
  box.style.justifyContent = text.anchor === "ctr" ? "center" : text.anchor === "b" ? "flex-end" : "flex-start";
  if (!text.wrap) box.style.whiteSpace = "pre";
  if (text.vert) {
    box.style.writingMode = "vertical-rl";
    if (text.vert === "vert270") box.style.transform = "rotate(180deg)";
  }
  const inner = document.createElement("div");
  inner.style.setProperty("--k", String(text.fontScale || 1));
  inner.style.fontFamily = SANS;
  inner.style.flex = "none";
  if (text.fit) inner.dataset.fit = "1";
  const color = text.shapeColor || defaultColor;
  for (const p of text.paras) inner.append(paragraphBox(p, text.fontScale, color, deck.fonts, 18));
  box.append(inner);
  return box;
}

export function drawSlide(slide, deck) {
  deck = { ...deck, fonts: slide.fonts || { major: "", minor: "" } };
  const root = document.createElement("div");
  root.className = "sl";
  root.style.cssText = `position:absolute;left:0;top:0;width:${deck.w}px;height:${deck.h}px;overflow:hidden;transform-origin:0 0;`;
  root.style.background = slide.bg;
  const dark = "#000000";
  for (const it of slide.items) {
    const box = document.createElement("div");
    box.style.cssText = `position:absolute;left:${pxs(it.x)};top:${pxs(it.y)};width:${pxs(Math.max(it.w, 0.5))};height:${pxs(Math.max(it.h, 0.5))};`;
    if (it.rot) box.style.transform = `rotate(${it.rot}deg)`;
    const flip = `scale(${it.flipH ? -1 : 1},${it.flipV ? -1 : 1})`;

    if (it.t === "line") {
      const svg = document.createElementNS(SVGNS, "svg");
      const w = Math.max(it.w, 1), h = Math.max(it.h, 1);
      svg.setAttribute("width", String(w));
      svg.setAttribute("height", String(h));
      svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible;";
      const ln = document.createElementNS(SVGNS, "line");
      ln.setAttribute("x1", it.flipH ? String(w) : "0");
      ln.setAttribute("y1", it.flipV ? String(h) : "0");
      ln.setAttribute("x2", it.flipH ? "0" : String(w));
      ln.setAttribute("y2", it.flipV ? "0" : String(h));
      ln.setAttribute("stroke", it.line.color);
      ln.setAttribute("stroke-width", String(it.line.w));
      if (it.line.dash !== "solid") ln.setAttribute("stroke-dasharray", it.line.dash === "dotted" ? `${it.line.w} ${it.line.w * 2}` : `${it.line.w * 4} ${it.line.w * 2}`);
      svg.append(ln);
      box.append(svg);
    } else if (it.t === "pic") {
      box.style.overflow = "hidden";
      if (it.round) box.style.borderRadius = "50%";
      const img = document.createElement("img");
      img.src = it.url;
      img.alt = it.alt || "";
      img.draggable = false;
      const cw = 1 - it.crop.l - it.crop.r || 1, ch = 1 - it.crop.t - it.crop.b || 1;
      img.style.cssText = `position:absolute;display:block;max-width:none;width:${(100 / cw).toFixed(3)}%;height:${(100 / ch).toFixed(3)}%;left:${((-it.crop.l / cw) * 100).toFixed(3)}%;top:${((-it.crop.t / ch) * 100).toFixed(3)}%;`;
      box.style.transform = `${box.style.transform || ""} ${flip}`.trim();
      box.append(img);
    } else if (it.t === "table") {
      box.append(drawTable(it, slide, deck));
    } else if (it.t === "note") {
      box.style.cssText += "display:grid;place-items:center;border:2px dashed rgba(128,128,128,.6);border-radius:12px;color:rgba(128,128,128,.9);font:600 28px system-ui,sans-serif;";
      box.textContent = it.label;
    } else {
      // shape: geometry layer (flipped) under the text layer (never mirrored)
      const geo = document.createElement("div");
      geo.style.cssText = "position:absolute;inset:0;box-sizing:border-box;";
      geo.style.transform = flip;
      const g = it.geom;
      const min = Math.min(it.w, it.h);
      if (it.fill) {
        if (it.fill.css) geo.style.background = it.fill.css;
        else geo.style.background = `url("${it.fill.img}") center/100% 100% no-repeat`;
      }
      if (it.line) geo.style.border = `${pxs(it.line.w)} ${it.line.dash} ${it.line.color}`;
      if (g.prst === "ellipse") geo.style.borderRadius = "50%";
      else if (g.prst === "roundRect") geo.style.borderRadius = pxs(((g.adj || 16667) / 100000) * min);
      else if (/^(snip|round)/.test(g.prst)) geo.style.borderRadius = pxs(min * 0.16);
      else if (POLY[g.prst]) {
        geo.style.clipPath = `polygon(${POLY[g.prst]})`;
        geo.style.border = "0";
      } else if (g.path) {
        const sx = it.w / (g.path.w || it.w || 1), sy = it.h / (g.path.h || it.h || 1);
        const f = (pt) => `${(pt[0] * sx).toFixed(1)} ${(pt[1] * sy).toFixed(1)}`;
        const d = g.path.cmds.map((cmd) => (cmd[0] === "Z" ? "Z" : `${cmd[0]} ${cmd.slice(1).map(f).join(" ")}`)).join(" ");
        geo.style.clipPath = `path("${d}")`;
        geo.style.border = "0";
      }
      box.append(geo);
      if (it.text) {
        const defaultColor = it.ph || !it.fill ? "#000000" : dark;
        box.append(textBox(it.text, it, deck, defaultColor));
      }
    }
    root.append(box);
  }
  return root;
}

function drawTable(it, slide, deck) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:absolute;inset:0;overflow:hidden;";
  const table = document.createElement("table");
  table.style.cssText = "border-collapse:collapse;table-layout:fixed;";
  const totalW = it.table.cols.reduce((a, b) => a + b, 0) || it.w;
  table.style.width = pxs(totalW);
  const cg = document.createElement("colgroup");
  for (const w of it.table.cols) {
    const col = document.createElement("col");
    col.style.width = pxs(w);
    cg.append(col);
  }
  table.append(cg);
  const accent = slide.accent || "#4472C4";
  for (const row of it.table.rows) {
    const tr = document.createElement("tr");
    tr.style.height = pxs(row.h);
    for (const cell of row.cells) {
      if (cell.hMerge || cell.vMerge) continue;
      const td = document.createElement("td");
      if (cell.span > 1) td.colSpan = cell.span;
      if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
      const bg = cell.fill || (row.header ? accent : row.band ? "rgba(128,128,128,0.15)" : "rgba(128,128,128,0.06)");
      td.style.background = bg;
      td.style.border = "1px solid rgba(128,128,128,0.45)";
      td.style.padding = `${pxs(cell.pad[1])} ${pxs(cell.pad[2])} ${pxs(cell.pad[3])} ${pxs(cell.pad[0])}`;
      td.style.verticalAlign = cell.anchor === "ctr" ? "middle" : cell.anchor === "b" ? "bottom" : "top";
      td.style.overflow = "hidden";
      const color = row.header && !cell.fill ? "#ffffff" : "#000000";
      for (const p of cell.paras) {
        const d = paragraphBox(p, 1, color, deck.fonts, 18);
        if (row.header) d.style.fontWeight = "700";
        td.append(d);
      }
      tr.append(td);
    }
    table.append(tr);
  }
  wrap.append(table);
  return wrap;
}

// Text boxes marked "shrink on overflow" get smaller text until it fits, as PowerPoint does
export function fitSlide(root) {
  for (const inner of root.querySelectorAll("[data-fit]")) {
    const box = inner.parentElement;
    let k = Number(inner.style.getPropertyValue("--k")) || 1;
    for (let i = 0; i < 10 && inner.offsetHeight > box.clientHeight - 1 && k > 0.3; i++) {
      k *= 0.92;
      inner.style.setProperty("--k", k.toFixed(3));
    }
  }
}

/* ---------- Text view: the deck as an outline ---------- */

export function outlineBlocks(deck) {
  const blocks = [];
  deck.slides.forEach((s, i) => {
    if (i) blocks.push({ type: "hr" });
    blocks.push({ type: "h", level: 1, runs: [{ t: `${i + 1}. ${s.title || "Slide " + (i + 1)}` }], align: "" });
    for (const entry of s.paras) {
      if (entry.alt) {
        blocks.push({ type: "p", runs: [{ t: `[${entry.alt}]`, i: true }], align: "", list: null, rtl: false });
      } else if (entry.table) {
        blocks.push({
          type: "table",
          rows: entry.table.rows.map((r) => r.cells.filter((c) => !c.hMerge && !c.vMerge).map((c) => ({ span: c.span, blocks: [{ type: "p", runs: [{ t: c.paras.map((p) => p.text).join("\n") }], align: "", list: null }] }))),
        });
      } else {
        for (const p of entry.text.paras) {
          if (!p.text.trim()) continue;
          blocks.push({
            type: "p",
            runs: p.runs.filter((r) => r.t).map((r) => ({ t: r.t, b: r.b, i: r.i, u: r.u, s: r.s, ...(r.href ? { href: r.href } : {}) })),
            align: "",
            list: p.bullet ? { level: Math.min(p.lvl, 4), label: p.bullet } : null,
            rtl: p.rtl,
          });
        }
      }
    }
    if (s.notes) {
      blocks.push({ type: "p", runs: [{ t: "Notes: ", b: true, i: true }, { t: s.notes, i: true }], align: "", list: null, rtl: false });
    }
  });
  return blocks;
}
