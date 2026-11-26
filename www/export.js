// Loaded only when you share a file or switch to Text view, so the app starts fast.

/* ---------- Text out of a PDF ---------- */

// Returns one array of paragraphs per page.
export async function extractText(pdf, isCancelled = () => false) {
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    if (isCancelled()) return pages;
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    pages.push(toParagraphs(content.items));
    page.cleanup();
  }
  return pages;
}

export async function textOfBlob(pdfjsLib, blob) {
  const data = new Uint8Array(await blob.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  try {
    return await extractText(pdf);
  } finally {
    pdf.destroy();
  }
}

function toParagraphs(items) {
  // 1) glue items that sit on the same line
  const lines = [];
  for (const it of items) {
    if (!it.str) continue;
    const y = it.transform[5];
    const h = it.height || 10;
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - y) <= h * 0.5) last.text += it.str;
    else lines.push({ y, h, text: it.str });
  }

  // typical line height on this page; clearly bigger, short lines are headings
  const hs = lines.map((l) => l.h).filter((h) => h > 0).sort((a, b) => a - b);
  const median = hs.length ? hs[Math.floor(hs.length / 2)] : 10;
  const headingOf = (l) => {
    const t = l.text.replace(/\s+/g, " ").trim();
    if (!t || t.length > 120 || l.h < median * 1.25) return 0;
    return l.h >= median * 1.6 ? 1 : 2;
  };

  // 2) group lines into paragraphs: a big gap (or a jump back up, e.g. next column) starts a new one
  const paras = [];
  let cur = "";
  let prev = null;
  for (const line of lines) {
    const text = line.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const hl = headingOf(line);
    if (hl || prev?.heading) {
      if (cur) paras.push(cur);
      cur = "";
      if (hl) {
        const last = paras[paras.length - 1];
        if (last && typeof last === "object" && last.h === hl && prev?.heading) last.t += " " + text; // wrapped title
        else paras.push({ h: hl, t: text });
        prev = { ...line, heading: true };
        continue;
      }
    }
    const gap = prev ? prev.y - line.y : 0;
    if (prev && cur && (gap > Math.max(prev.h, line.h) * 1.8 || gap < 0)) {
      paras.push(cur);
      cur = text;
    } else if (!cur) {
      cur = text;
    } else if (/[a-z]-$/.test(cur) && /^[a-z]/.test(text)) {
      cur = cur.slice(0, -1) + text; // re-join a word split across lines
    } else {
      cur += " " + text;
    }
    prev = line;
  }
  if (cur) paras.push(cur);
  return paras;
}

/* ---------- Word (.docx), text only ---------- */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const esc = (s) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uE000-\uF8FF\uFFF9-\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const STYLES =
  XML_HEAD +
  `<w:styles ${NS}>` +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Nirmala UI"/><w:sz w:val="22"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:bidi="bn-BD"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>' +
  "</w:styles>";

// pages: one array of paragraphs per page; a paragraph is a string or { h: 1|2, t }
export function buildDocx(pages, title = "Document") {
  const body = pages
    .flat()
    .map((p) =>
      typeof p === "object" && p.runs
        ? `<w:p>${p.runs.map((r) => `<w:r>${r.b ? "<w:rPr><w:b/><w:bCs/></w:rPr>" : ""}<w:t xml:space="preserve">${esc(r.t)}${" "}</w:t></w:r>`).join("")}</w:p>`
        : typeof p === "object"
          ? `<w:p><w:pPr><w:pStyle w:val="Heading${p.h === 1 ? 1 : 2}"/></w:pPr><w:r><w:t xml:space="preserve">${esc(p.t)}</w:t></w:r></w:p>`
          : `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`
    )
    .join("");
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const files = {
    "[Content_Types].xml":
      XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      "</Types>",
    "_rels/.rels":
      XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      "</Relationships>",
    "word/_rels/document.xml.rels":
      XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      "</Relationships>",
    "word/styles.xml": STYLES,
    "word/document.xml":
      XML_HEAD +
      `<w:document ${NS}><w:body>` +
      body +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
      "</w:body></w:document>",
    "docProps/core.xml":
      XML_HEAD +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${esc(title)}</dc:title><dc:creator>Reader by Key</dc:creator>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
      "</cp:coreProperties>",
    "docProps/app.xml":
      XML_HEAD + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Reader by Key</Application></Properties>',
  };
  return zip(files);
}

// Scanned pages as a Word file: one picture per page. images: [{ jpeg: Uint8Array, w, h }] (pixels)
export function buildImageDocx(images, title = "Scan") {
  const MAXW = 6645910, MAXH = 9777730; // text area of an A4 page with 0.5 inch margins, in EMU
  const body = images
    .map((im, i) => {
      const k = Math.min(MAXW / im.w, MAXH / im.h);
      const cx = Math.round(im.w * k), cy = Math.round(im.h * k);
      const n = i + 1;
      return (
        '<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr><w:r><w:drawing>' +
        `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Page ${n}" descr="Scanned page ${n}"/>` +
        '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="page${n}.jpg"/><pic:cNvPicPr/></pic:nvPicPr>` +
        `<pic:blipFill><a:blip r:embed="rIdImg${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
        `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
        "</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>" +
        (i < images.length - 1 ? '<w:r><w:br w:type="page"/></w:r>' : "") +
        "</w:p>"
      );
    })
    .join("");
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const rels = images
    .map((_, i) => `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/page${i + 1}.jpg"/>`)
    .join("");
  const files = {
    "[Content_Types].xml":
      XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      "</Types>",
    "_rels/.rels":
      XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      "</Relationships>",
    "word/_rels/document.xml.rels":
      XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      rels +
      "</Relationships>",
    "word/styles.xml": STYLES,
    "word/document.xml":
      XML_HEAD +
      `<w:document ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>` +
      body +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr>' +
      "</w:body></w:document>",
    "docProps/core.xml":
      XML_HEAD +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${esc(title)}</dc:title><dc:creator>Reader by Key</dc:creator>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
      "</cp:coreProperties>",
  };
  images.forEach((im, i) => (files[`word/media/page${i + 1}.jpg`] = im.jpeg));
  return zip(files);
}

/* ---------- Tiny zip writer (no compression) ---------- */

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = typeof text === "string" ? enc.encode(text) : text; // text or raw bytes (pictures)
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(12, 0x21, true); // date: 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(local.buffer, nameBytes, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(14, 0x21, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(entry.buffer, nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end.buffer], { type: DOCX_MIME });
}

/* ---------- Sharing ---------- */

export const safeName = (s) => (s.replace(/[\\/:*?"<>|\u0000-\u001F]+/g, "").trim().slice(0, 80) || "Document");

const toBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const isCancel = (err) => /cancel|abort/i.test(`${err && err.name} ${err && err.message}`);

// two files can have the same name; the second becomes "Name (2).pdf"
function uniqueNames(items) {
  const used = new Set();
  return items.map((it) => {
    let name = it.filename;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
    used.add(name.toLowerCase());
    return { ...it, filename: name };
  });
}

// items: [{ blob, filename, mime }]. Resolves "shared" or "cancelled"; throws if sharing really failed.
export async function shareFiles(items, title) {
  const cap = window.Capacitor;
  const plugins = cap && cap.Plugins;
  const files = uniqueNames(items);

  try {
    if (plugins && plugins.Share && plugins.Filesystem && cap.isNativePlatform && cap.isNativePlatform()) {
      try {
        await plugins.Filesystem.rmdir({ path: "shared", directory: "CACHE", recursive: true });
      } catch {
        /* nothing to clean */
      }
      const uris = [];
      for (const f of files) {
        const { uri } = await plugins.Filesystem.writeFile({
          path: `shared/${f.filename}`,
          data: await toBase64(f.blob),
          directory: "CACHE",
          recursive: true,
        });
        uris.push(uri);
      }
      await plugins.Share.share({ title, files: uris, dialogTitle: title });
      return "shared";
    }

    const webFiles = files.map((f) => new File([f.blob], f.filename, { type: f.mime }));
    if (navigator.canShare && navigator.canShare({ files: webFiles })) {
      await navigator.share({ files: webFiles, title });
      return "shared";
    }

    // no share sheet available (desktop browser): save the files instead
    webFiles.forEach((file, i) =>
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(file);
        a.download = file.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }, i * 300)
    );
    return "shared";
  } catch (err) {
    if (isCancel(err)) return "cancelled";
    throw err;
  }
}

