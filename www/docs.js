// Loaded only when a Word (.docx) or text (.txt) file is opened, so the app starts fast.
// Both come back as a list of paragraphs: a string, or { h, t } for a heading.

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/* ---------- Tiny zip reader (stored + deflate) ---------- */

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") throw new Error("no DecompressionStream");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Returns the bytes of one file inside a zip, or null if it isn't there.
async function unzipOne(blob, wanted) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // end of central directory sits within the last 64 KB
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();

  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name !== wanted) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = buf.subarray(start, start + csize);
    if (method === 0) return data;
    if (method === 8) return inflateRaw(data);
    throw new Error(`unsupported zip method ${method}`);
  }
  return null;
}

/* ---------- Word (.docx) ---------- */

const kids = (el) => Array.from(el.children);
const child = (el, name) => kids(el).find((c) => c.namespaceURI === W && c.localName === name);
const val = (el) => (el ? el.getAttributeNS(W, "val") || el.getAttribute("w:val") || "" : "");

function textOf(node) {
  let s = "";
  for (const el of kids(node)) {
    if (el.namespaceURI === W) {
      switch (el.localName) {
        case "t":
          s += el.textContent;
          continue;
        case "tab":
          s += " ";
          continue;
        case "br":
        case "cr":
          s += "\n";
          continue;
        case "noBreakHyphen":
          s += "-";
          continue;
        case "pPr":
        case "rPr":
        case "delText":
        case "instrText":
          continue;
      }
    } else if (el.localName === "Fallback") {
      continue; // text boxes are stored twice; read only one copy
    }
    s += textOf(el);
  }
  return s;
}

function collect(node, out) {
  for (const el of kids(node)) {
    if (el.namespaceURI !== W) continue;
    if (el.localName !== "p") {
      collect(el, out); // tables, rows, cells, content controls
      continue;
    }
    const text = textOf(el)
      .replace(/[ \u00a0]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .trim();
    if (!text) continue;

    const pPr = child(el, "pPr");
    const style = pPr ? val(child(pPr, "pStyle")) : "";
    const m = /^Heading([1-9])$/i.exec(style);
    if (m) out.push({ h: Number(m[1]) === 1 ? 1 : 2, t: text });
    else if (/^(Title|Subtitle)$/i.test(style)) out.push({ h: 1, t: text });
    else if (pPr && child(pPr, "numPr")) out.push(`• ${text}`);
    else out.push(text);
  }
}

export async function readDocx(blob) {
  const bytes = await unzipOne(blob, "word/document.xml");
  if (!bytes) throw Object.assign(new Error("no document.xml"), { name: "Unsupported" });

  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("bad xml");

  const body = doc.getElementsByTagNameNS(W, "body")[0];
  const out = [];
  if (body) collect(body, out);
  return out;
}

/* ---------- Plain text (.txt) ---------- */

export async function readText(blob) {
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
  text = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

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
