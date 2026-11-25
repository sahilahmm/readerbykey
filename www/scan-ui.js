// The scanner, built into the bottom pill: tap Scan, the phone's own camera takes the photo, Reader straightens and cleans it.
import { detectCorners, warp, enhance, toJpeg, makePdf } from "./scan.js";

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
    pages.forEach((p, i) => {
      const t = document.createElement("div");
      t.className = "t";
      const img = document.createElement("img");
      img.src = p.url;
      img.alt = `Page ${i + 1}`;
      const x = document.createElement("button");
      x.type = "button";
      x.setAttribute("aria-label", `Remove page ${i + 1}`);
      x.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><use href="#i-x"/></svg>';
      x.addEventListener("click", () => {
        URL.revokeObjectURL(p.url);
        pages.splice(i, 1);
        buzz("warn");
        if (pages.length) paint();
        else end();
      });
      t.append(img, x);
      strip.append(t);
    });
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

  function end() {
    for (const p of pages) URL.revokeObjectURL(p.url);
    pages = [];
    active = false;
    busy = false;
    strip.replaceChildren();
    setMode(defaultMode());
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
      const canvas = enhance(warp(src, detectCorners(src), SAVE_PX), look());
      const th = document.createElement("canvas");
      const s = 160 / Math.max(canvas.width, canvas.height);
      th.width = Math.round(canvas.width * s);
      th.height = Math.round(canvas.height * s);
      th.getContext("2d").drawImage(canvas, 0, 0, th.width, th.height);
      const url = await new Promise((r) => th.toBlob((b) => r(URL.createObjectURL(b)), "image/jpeg", 0.8));
      pages.push({ canvas, url });
      buzz("ok");
    } catch {
      toast("That photo couldn't be read");
    }
    busy = false;
    if (pages.length) paint();
    else end();
  }

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
    back: () => (busy ? null : end()),
  };
}
