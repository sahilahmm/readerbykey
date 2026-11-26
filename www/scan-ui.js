// The scanner, built into the bottom pill: tap Scan, the phone's own camera takes the photo, Reader straightens and cleans it.
import { findPage } from "./dq.js";
import { warp, enhance, toJpeg, makePdf } from "./scan.js";

const LONG = 450; // ms held still on a thumbnail to adjust its corners

const $ = (id) => document.getElementById(id);
const MAX_PAGES = 30;
const SAVE_PX = 1800;
const TRIM = 0.035; // how far the auto-crop is pulled in from the detected page edge
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));

export function createScanner({ openBlob, toast, buzz, loadExport, store, setMode, defaultMode, say }) {
  const input = $("scanCapture");
  const strip = $("scanThumbs");
  let pages = []; // { canvas, url }
  let active = false;
  let busy = false;
  let queue = Promise.resolve(); // photos are looked at one after another, in the background

  const look = () => store("reader.scanLook") || "doc";

  function paint() {
    strip.replaceChildren();
    for (const p of pages) {
      const t = document.createElement("div");
      t.className = p.unsure ? "t warn" : "t";
      const img = document.createElement("img");
      img.src = p.url;
      p.img = img;
      img.alt = `Page ${pages.indexOf(p) + 1}`;
      img.draggable = false;
      const x = document.createElement("button");
      x.type = "button";
      x.setAttribute("aria-label", "Remove page");
      x.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><use href="#i-x"/></svg>';
      x.addEventListener("click", () => {
        URL.revokeObjectURL(p.url);
        pages.splice(pages.indexOf(p), 1);
        buzz("warn");
        draft();
        if (pages.length) paint();
        else end();
      });
      x.addEventListener("pointerdown", (e) => e.stopPropagation());
      grab(t, p);
      t.append(img, x);
      strip.append(t);
    }
    if (pages.length < MAX_PAGES) {
      const plus = document.createElement("button");
      plus.type = "button";
      plus.className = "plus";
      plus.setAttribute("aria-label", "Scan another page");
      plus.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><use href="#i-plus"/></svg>';
      plus.addEventListener("click", shoot);
      strip.append(plus);
    }
    strip.scrollLeft = strip.scrollWidth;
    active = true;
    setMode("scan");
  }

  // hold a thumbnail still to adjust it; drag it sideways to move it in the order
  function grab(t, p) {
    let down = null, timer = 0, dragging = false;
    t.addEventListener("pointerdown", (e) => {
      down = { x: e.clientX, y: e.clientY, id: e.pointerId };
      dragging = false;
      timer = setTimeout(() => {
        if (down && !dragging) {
          const was = down;
          down = null;
          openEdit(p);
          t.releasePointerCapture && was && t.hasPointerCapture(was.id) && t.releasePointerCapture(was.id);
        }
      }, LONG);
    });
    t.addEventListener("pointermove", (e) => {
      if (!down || e.pointerId !== down.id) return;
      if (!dragging && Math.abs(e.clientX - down.x) > 8) {
        dragging = true;
        clearTimeout(timer);
        t.setPointerCapture(e.pointerId);
        t.classList.add("lift");
        buzz("select");
      }
      if (!dragging) return;
      const mid = e.clientX;
      for (const o of [...strip.querySelectorAll(".t")]) {
        if (o === t) continue;
        const r = o.getBoundingClientRect();
        if (mid > r.left && mid < r.right) {
          const before = o.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING; // t is after o
          strip.insertBefore(t, before ? o : o.nextSibling);
          buzz("tick");
          break;
        }
      }
    });
    const up = () => {
      clearTimeout(timer);
      if (dragging) {
        const order = [...strip.querySelectorAll(".t")].map((n) => n.__p);
        pages = order.filter(Boolean);
        draft();
        t.classList.remove("lift");
        paint();
      }
      down = null;
      dragging = false;
    };
    t.__p = p;
    t.addEventListener("pointerup", up);
    t.addEventListener("pointercancel", up);
  }

  function end() {
    editing = null;
    E.root.hidden = true;
    for (const p of pages) URL.revokeObjectURL(p.url);
    pages = [];
    active = false;
    busy = false;
    strip.replaceChildren();
    draft();
    setMode(defaultMode());
  }

  const blobOf = (canvas, q = 0.9) => new Promise((r) => canvas.toBlob(r, "image/jpeg", q));
  // a small picture of the page for the strip; the full-size work waits until Save
  async function render(p, known) {
    const src = known || (await decode(p.src));
    let th;
    if (p.corners) th = enhance(warp(src, p.corners, 360), look());
    else {
      th = document.createElement("canvas");
      const k = 160 / Math.max(src.width, src.height);
      th.width = Math.round(src.width * k);
      th.height = Math.round(src.height * k);
      th.getContext("2d").drawImage(src, 0, 0, th.width, th.height);
    }
    if (p.url) URL.revokeObjectURL(p.url);
    p.url = URL.createObjectURL(await blobOf(th, 0.8));
  }
  // trim the page's outline in a little, so the edge of the table or the page's shadow stays out
  const tighten = (q) => {
    const cx = q.reduce((t, c) => t + c[0], 0) / 4, cy = q.reduce((t, c) => t + c[1], 0) / 4;
    const o = q.map(([x, y]) => [x + (cx - x) * TRIM, y + (cy - y) * TRIM]);
    o.sure = q.sure;
    return o;
  };
  // progress is a lighter fill that grows across the pill itself
  const dock = $("dock");
  function ring(f) {
    if (f == null) {
      dock.classList.remove("busy");
      dock.style.removeProperty("--p");
      return;
    }
    dock.classList.add("busy");
    dock.style.setProperty("--p", String(Math.round(Math.max(0.02, Math.min(1, f)) * 1000) / 10));
  }
  async function decode(blob) {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    return c;
  }

  // find the page edges in the background, one photo at a time, then swap the small picture in place
  function locate(p, src) {
    p.ready = queue = queue.then(async () => {
      let sure = true;
      await frame();
      try {
        const c = await findPage(src || (await decode(p.src)));
        sure = c.sure;
        p.corners = tighten(c);
      } catch {
        p.corners = [[0.04, 0.04], [0.96, 0.04], [0.96, 0.96], [0.04, 0.96]];
        sure = false;
      }
      p.unsure = !sure;
      await render(p);
      if (pages.includes(p)) {
        if (p.img) {
          p.img.src = p.url; // swap the picture in place: the strip is not rebuilt under a finger
          p.img.parentNode.classList.toggle("warn", p.unsure);
        }
        if (!sure && !editing && !busy) toast("Hold the page to check its corners");
      }
      draft();
    });
  }

  // a new photo is kept at once; finding the page and everything else happens later, out of the way
  async function take(file) {
    busy = true;
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 3200 / Math.max(bmp.width, bmp.height));
      const src = document.createElement("canvas");
      src.width = Math.round(bmp.width * k);
      src.height = Math.round(bmp.height * k);
      src.getContext("2d").drawImage(bmp, 0, 0, src.width, src.height);
      bmp.close && bmp.close();
      const p = { src: await blobOf(src), corners: null, url: "", ready: null }; // the photo is kept as a small JPEG so a page can be adjusted later
      await render(p, src);
      pages.push(p);
      buzz("ok");
      locate(p, null);
      draft();
    } catch {
      toast("That photo couldn't be read");
    }
    busy = false;
    if (pages.length) paint();
    else end();
  }

  /* ----- adjusting one page: its corners, and a turn ----- */
  const E = { root: $("scanEdit"), stage: $("seStage"), canvas: $("seCanvas"), poly: $("sePoly"), quad: $("seQuad"), handles: $("seHandles") };
  let editing = null; // { p, src, corners }
  const shown = () => {
    const r = E.stage.getBoundingClientRect();
    const { width: w, height: h } = editing.src;
    const k = Math.min(r.width / w, r.height / h);
    return { x: (r.width - w * k) / 2, y: (r.height - h * k) / 2, w: w * k, h: h * k, W: r.width, H: r.height };
  };
  function drawEdit() {
    const s = shown();
    E.quad.setAttribute("viewBox", `0 0 ${s.W} ${s.H}`);
    E.poly.setAttribute("points", editing.corners.map((c) => `${s.x + c[0] * s.w},${s.y + c[1] * s.h}`).join(" "));
    [...E.handles.children].forEach((h, i) => {
      h.style.left = `${s.x + editing.corners[i][0] * s.w}px`;
      h.style.top = `${s.y + editing.corners[i][1] * s.h}px`;
    });
  }
  async function openEdit(p) {
    if (busy || editing) return;
    await p.ready;
    buzz("medium");
    const src = await decode(p.src);
    editing = { p, src, corners: p.corners.map((c) => [...c]) };
    E.canvas.width = src.width;
    E.canvas.height = src.height;
    E.canvas.getContext("2d").drawImage(src, 0, 0);
    E.root.hidden = false;
    E.handles.replaceChildren();
    for (let i = 0; i < 4; i++) {
      const h = document.createElement("div");
      h.className = "se-handle";
      h.addEventListener("pointerdown", (e) => {
        h.setPointerCapture(e.pointerId);
        buzz("tap");
      });
      h.addEventListener("pointermove", (e) => {
        if (!h.hasPointerCapture(e.pointerId)) return;
        const r = E.stage.getBoundingClientRect();
        const s = shown();
        editing.corners[i] = [Math.min(1, Math.max(0, (e.clientX - r.left - s.x) / s.w)), Math.min(1, Math.max(0, (e.clientY - r.top - s.y) / s.h))];
        drawEdit();
      });
      E.handles.append(h);
    }
    setMode("scanedit");
    drawEdit();
  }
  function closeEdit() {
    editing = null;
    E.root.hidden = true;
    setMode("scan");
  }
  function turn() {
    const { src, corners } = editing;
    const c = document.createElement("canvas");
    c.width = src.height;
    c.height = src.width;
    const x = c.getContext("2d");
    x.translate(c.width, 0);
    x.rotate(Math.PI / 2);
    x.drawImage(src, 0, 0);
    editing.src = c;
    editing.corners = corners.map(([u, v]) => [1 - v, u]); // a quarter turn clockwise
    E.canvas.width = c.width;
    E.canvas.height = c.height;
    E.canvas.getContext("2d").drawImage(c, 0, 0);
    buzz("select");
    drawEdit();
  }
  async function applyEdit() {
    const { p, src, corners } = editing;
    busy = true;
    editing = null;
    E.root.hidden = true;
    say("Processing…");
    await frame();
    p.src = await blobOf(src);
    p.corners = corners;
    p.unsure = false;
    await render(p);
    draft();
    busy = false;
    buzz("ok");
    paint();
  }
  $("eCancel").addEventListener("click", closeEdit);
  $("eRot").addEventListener("click", turn);
  $("eApply").addEventListener("click", applyEdit);
  window.addEventListener("resize", () => editing && drawEdit());

  async function save(kind) {
    if (!pages.length || busy) return;
    busy = true;
    buzz("ok");
    const n = pages.length;
    say("Processing…");
    ring(0);
    await frame();
    const d = new Date();
    const pad = (x) => String(x).padStart(2, "0");
    const name = `Scan ${d.getDate()} ${d.toLocaleString("en", { month: "short" })} ${pad(d.getHours())}${pad(d.getMinutes())}`;
    const ocr = kind === "word" || store("reader.scanOcr") !== "off"; // Word is only text, so it always reads
    try {
      let ocrMod = null;
      if (ocr) {
        try {
          ocrMod = await import("./ocr.js");
        } catch {
          toast("Text recognition isn't available here");
        }
      }
      const imgs = [];
      const texts = ocrMod ? [] : null;
      for (let i = 0; i < n; i++) {
        const p = pages[i];
        await p.ready;
        const src = await decode(p.src);
        const base = i / n, share = 1 / n;
        say(`Page ${i + 1} of ${n}…`);
        ring(base);
        await frame();
        let r = null, big = null;
        if (ocrMod) {
          big = enhance(warp(src, p.corners, 2600), look());
          r = await ocrMod.readPage(big, (f) => ring(base + share * (0.1 + 0.8 * f)));
          texts.push(r);
        }
        if (kind !== "word" || !ocrMod) {
          const cv = enhance(warp(src, p.corners, SAVE_PX), look());
          const k = r ? cv.width / big.width : 1;
          imgs.push({ jpeg: await toJpeg(cv, 0.85), w: cv.width, h: cv.height, words: r && r.words.map((w) => ({ t: w.t, x0: w.x0 * k, y0: w.y0 * k, x1: w.x1 * k, y1: w.y1 * k })) });
        }
        ring(base + share);
      }
      if (ocrMod) await ocrMod.stopOcr();
      say("Saving…");
      await frame();
      let blob, filename;
      if (kind === "word") {
        const x = await loadExport();
        blob = texts
          ? x.buildDocx(
              texts.map((t) => (t.blocks && t.blocks.length ? t.blocks.map((b) => (b.kind === "p" ? { runs: b.runs } : { h: b.kind === "h1" ? 1 : 2, t: b.text })) : [""])),
              name
            )
          : x.buildImageDocx(imgs, name);
        filename = `${name}.docx`;
      } else {
        blob = makePdf(imgs, name);
        filename = `${name}.pdf`;
      }
      ring(null);
      end();
      await openBlob(blob, filename, `scan|${Date.now()}`);
    } catch {
      busy = false;
      ring(null);
      toast("Couldn't save the scan");
      paint();
    }
  }

  // the phone's own camera app, opened directly (no file chooser); the file input is only the fallback
  async function shoot() {
    const cap = window.Capacitor;
    let cam = cap && cap.Plugins && cap.Plugins.Camera;
    if (!cam && cap && cap.registerPlugin && cap.isNativePlatform && cap.isNativePlatform()) cam = cap.registerPlugin("Camera");
    if (!cam) return input.click();
    try {
      const r = await cam.getPhoto({ source: "CAMERA", resultType: "uri", quality: 95, correctOrientation: true, saveToGallery: false });
      const blob = await (await fetch(r.webPath)).blob();
      take(blob);
    } catch (e) {
      const m = String((e && e.message) || e);
      if (/cancel/i.test(m)) return; // closing the camera without a photo is not an error
      toast(`Camera: ${m.slice(0, 60)}`);
      setTimeout(() => input.click(), 1200);
    }
  }

  input.addEventListener("change", () => {
    const f = [...input.files].find((x) => x.type.startsWith("image/"));
    input.value = "";
    if (f) take(f);
  });
  $("sOk").addEventListener("click", () => {
    buzz("tap");
    setMode("scansave");
  });
  $("sX").addEventListener("click", () => {
    buzz("warn");
    end();
  });
  const ocrBtn = $("sOcr");
  ocrBtn.setAttribute("aria-checked", String(store("reader.scanOcr") !== "off"));
  ocrBtn.addEventListener("click", () => {
    const on = ocrBtn.getAttribute("aria-checked") !== "true";
    ocrBtn.setAttribute("aria-checked", String(on));
    store("reader.scanOcr", on ? "on" : "off");
    buzz("select");
  });
  $("sPdf").addEventListener("click", () => save("pdf"));
  $("sWord").addEventListener("click", () => save("word"));

  /* ----- keep the work safe: if the phone closes the app while the camera is open, the pages come back ----- */
  const DB = () =>
    new Promise((res, rej) => {
      const q = indexedDB.open("reader-scan", 1);
      q.onupgradeneeded = () => q.result.createObjectStore("d");
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  let saving = Promise.resolve();
  function draft() {
    saving = saving.then(async () => {
      try {
        const db = await DB();
        const tx = db.transaction("d", "readwrite");
        const st = tx.objectStore("d");
        if (pages.length) st.put({ pages: pages.map((p) => ({ src: p.src, corners: p.corners ? p.corners.map((c) => [...c]) : null, unsure: !!p.unsure })) }, "draft");
        else st.delete("draft");
        await new Promise((r) => (tx.oncomplete = tx.onerror = tx.onabort = r));
        db.close();
      } catch {
        /* storage unavailable: the scan simply isn't kept across a restart */
      }
    });
  }
  async function restore() {
    try {
      const db = await DB();
      const d = await new Promise((r) => {
        const q = db.transaction("d").objectStore("d").get("draft");
        q.onsuccess = () => r(q.result);
        q.onerror = () => r(null);
      });
      db.close();
      if (!d || !d.pages || !d.pages.length || pages.length || busy) return;
      for (const x of d.pages) {
        const p = { src: x.src, corners: x.corners, url: "", ready: Promise.resolve(), unsure: x.unsure };
        await render(p);
        if (!p.corners) locate(p, null);
        pages.push(p);
      }
      paint();
      toast("Your scan was restored");
    } catch {
      /* nothing to restore */
    }
  }
  restore();
  const capApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (capApp && capApp.addListener)
    capApp.addListener("appRestoredResult", async (r) => {
      try {
        if (r && r.pluginId === "Camera" && r.success && r.data && r.data.webPath) take(await (await fetch(r.data.webPath)).blob());
      } catch {
        /* the photo is gone: nothing to add */
      }
    });

  return {
    open: () => (pages.length ? paint() : shoot()),
    isOpen: () => active || busy,
    back: () => (busy ? null : editing ? closeEdit() : end()),
  };
}
