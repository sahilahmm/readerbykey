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

  // 2) group lines into paragraphs: a big gap (or a jump back up, e.g. next column) starts a new one
  const paras = [];
  let cur = "";
  let prev = null;
  for (const line of lines) {
    const text = line.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const gap = prev ? prev.y - line.y : 0;
    if (prev && (gap > Math.max(prev.h, line.h) * 1.8 || gap < 0)) {
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
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function buildDocx(pages) {
  const body = pages
    .flat()
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`)
    .join("");

  const files = {
    "[Content_Types].xml":
      XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
    "_rels/.rels":
      XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
    "word/document.xml":
      XML_HEAD +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      body +
      "</w:body></w:document>",
  };
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
    const data = enc.encode(text);
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

export const shareFile = (blob, filename, mime, title) => shareFiles([{ blob, filename, mime }], title);
