// The scanner, built into the bottom pill: tap Scan, the phone's own camera takes the photo, Reader straightens and cleans it.
import { detectCorners, warp, enhance, toJpeg, makePdf } from "./scan.js";

const LONG = 450; // ms held still on a thumbnail to adjust its corners

const $ = (id) => document.getElementById(id);
const MAX_PAGES = 30;
const SAVE_PX = 1800;
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));

export function createScanner({ openBlob, toast, buzz, loadExport, store, setMode, defaultMode, say }) {
  const input = $("scanCapture");
  const strip = $("scanThumbs");
  let pages = []; // { canvas, url }
  let active = false;
  let busy = false;

  const look = () => store("reader.scanLook") || "doc";

  function paint() {
    strip.replaceChildren();
    for (const p of pages) {
      const t = document.createElement("div");
      t.className = "t";
      const img = document.createElement("img");
      img.src = p.url;
      img.alt = `Page ${pages.indexOf(p) + 1}`;
      const x = document.createElement("button");
      x.type = "button";
      x.setAttribute("aria-label", "Remove page");
      x.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><use href="#i-x"/></svg>';
      x.addEventListener("click", () => {
        URL.revokeObjectURL(p.url);
        pages.splice(pages.indexOf(p), 1);
        buzz("warn");
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
    setMode(defaultMode());
  }

  const blobOf = (canvas, q = 0.9) => new Promise((r) => canvas.toBlob(r, "image/jpeg", q));
  async function render(p) {
    const src = await decode(p.src);
    p.canvas = enhance(warp(src, p.corners, SAVE_PX), look());
    const th = document.createElement("canvas");
    const s = 160 / Math.max(p.canvas.width, p.canvas.height);
    th.width = Math.round(p.canvas.width * s);
    th.height = Math.round(p.canvas.height * s);
    th.getContext("2d").drawImage(p.canvas, 0, 0, th.width, th.height);
    if (p.url) URL.revokeObjectURL(p.url);
    p.url = URL.createObjectURL(await blobOf(th, 0.8));
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

  async function take(file) {
    busy = true;
    say("Processing…");
    await frame();
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 3200 / Math.max(bmp.width, bmp.height));
      const src = document.createElement("canvas");
      src.width = Math.round(bmp.width * k);
      src.height = Math.round(bmp.height * k);
      src.getContext("2d").drawImage(bmp, 0, 0, src.width, src.height);
      bmp.close && bmp.close();
      await frame();
      const p = { src: await blobOf(src), corners: detectCorners(src), canvas: null, url: "" }; // the photo is kept as a small JPEG so a page can be adjusted later
      await render(p);
      pages.push(p);
      buzz("ok");
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
    await render(p);
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
    say("Processing…");
    await frame();
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const name = `Scan ${d.getDate()} ${d.toLocaleString("en", { month: "short" })} ${pad(d.getHours())}${pad(d.getMinutes())}`;
    try {
      const imgs = [];
      for (const p of pages) imgs.push({ jpeg: await toJpeg(p.canvas, 0.85), w: p.canvas.width, h: p.canvas.height });
      let blob, filename;
      if (kind === "word") {
        blob = (await loadExport()).buildImageDocx(imgs, name);
        filename = `${name}.docx`;
      } else {
        blob = makePdf(imgs, name);
        filename = `${name}.pdf`;
      }
      end();
      await openBlob(blob, filename, `scan|${Date.now()}`);
    } catch {
      busy = false;
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
  $("sPdf").addEventListener("click", () => save("pdf"));
  $("sWord").addEventListener("click", () => save("word"));

  return {
    open: () => (pages.length ? paint() : shoot()),
    isOpen: () => active || busy,
    back: () => (busy ? null : editing ? closeEdit() : end()),
  };
}
