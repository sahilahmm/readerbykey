// The scanner screen: camera, page corners, pages, save as PDF or Word. Loaded the first time Scan is tapped.
import { detectCorners, warp, rotate, enhance, toJpeg, makePdf } from "./scan.js";

const $ = (id) => document.getElementById(id);
const MAX_PAGES = 30;
const SAVE_PX = 1800; // long edge of a saved page

export function createScanner({ openBlob, toast, buzz, loadExport, store }) {
  const el = {
    root: $("scan"), video: $("scanVideo"), canvas: $("scanCanvas"), quad: $("scanQuad"), poly: $("scanPoly"),
    handles: $("scanHandles"), msg: $("scanMsg"), pages: $("scanPages"), looks: $("scanLooks"), count: $("scanCount"),
    title: $("scanTitle"), stage: $("scanStage"), done: $("scanDone"), file: $("scanFile"), capture: $("scanCapture"),
  };
  const bars = {};
  for (const b of el.root.querySelectorAll(".scan-bar")) bars[b.dataset.s] = b;

  let stream = null;
  let mode = "camera"; // camera | edit | pages
  let src = null; // the photo being edited (canvas)
  let corners = null; // 4 points, fractions of src
  let pages = []; // { canvas, url }
  let queue = []; // photos waiting from the gallery
  let look = store("reader.scanLook") || "doc";
  let cameraOk = false;
  let closeArmed = 0;

  const setMode = (m) => {
    mode = m;
    for (const [k, b] of Object.entries(bars)) b.hidden = k !== m;
    const editing = m === "edit";
    el.canvas.hidden = !editing;
    el.quad.hidden = !editing;
    el.handles.hidden = !editing;
    el.looks.hidden = !editing;
    el.pages.hidden = m !== "pages";
    el.video.hidden = m !== "camera" || !cameraOk;
    el.msg.hidden = !(m === "camera" && !cameraOk);
    el.title.textContent = m === "edit" ? "Adjust the corners" : m === "pages" ? "Your pages" : "Scan";
    el.count.hidden = !pages.length;
    el.count.textContent = `${pages.length} ${pages.length === 1 ? "page" : "pages"}`;
    el.done.hidden = !pages.length;
    el.done.textContent = `Done · ${pages.length}`;
    for (const b of el.looks.children) b.classList.toggle("on", b.dataset.look === look);
  };

  /* ----- camera ----- */
  async function startCamera() {
    cameraOk = false;
    el.msg.textContent = "Starting the camera…";
    setMode("camera");
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("no camera api");
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      el.video.srcObject = stream;
      await el.video.play();
      cameraOk = true;
    } catch {
      el.msg.textContent = "The camera isn't available here. Tap the shutter to use your camera app, or choose a photo.";
    }
    if (mode === "camera") setMode("camera");
  }
  function stopCamera() {
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null;
    el.video.srcObject = null;
    cameraOk = false;
  }

  /* ----- editing one photo ----- */
  function toCanvas(source) {
    const w = source.videoWidth || source.naturalWidth || source.width;
    const h = source.videoHeight || source.naturalHeight || source.height;
    const k = Math.min(1, 3200 / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
    return c;
  }
  function edit(canvas) {
    src = canvas;
    corners = detectCorners(src);
    el.canvas.width = src.width;
    el.canvas.height = src.height;
    el.canvas.getContext("2d").drawImage(src, 0, 0);
    setMode("edit");
    layoutHandles();
  }

  // where the photo sits inside the stage (it is shown "contain")
  function shown() {
    const r = el.stage.getBoundingClientRect();
    const k = Math.min(r.width / src.width, r.height / src.height);
    const w = src.width * k, h = src.height * k;
    return { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h, W: r.width, H: r.height };
  }
  function layoutHandles() {
    if (!src) return;
    const s = shown();
    el.handles.replaceChildren();
    el.quad.setAttribute("viewBox", `0 0 ${s.W} ${s.H}`);
    corners.forEach((c, i) => {
      const h = document.createElement("div");
      h.className = "scan-handle";
      h.dataset.i = i;
      h.style.left = `${s.x + c[0] * s.w}px`;
      h.style.top = `${s.y + c[1] * s.h}px`;
      h.addEventListener("pointerdown", (e) => {
        h.setPointerCapture(e.pointerId);
        buzz("tap");
      });
      h.addEventListener("pointermove", (e) => {
        if (!h.hasPointerCapture(e.pointerId)) return;
        const r = el.stage.getBoundingClientRect();
        const sh = shown();
        corners[i] = [Math.min(1, Math.max(0, (e.clientX - r.left - sh.x) / sh.w)), Math.min(1, Math.max(0, (e.clientY - r.top - sh.y) / sh.h))];
        h.style.left = `${sh.x + corners[i][0] * sh.w}px`;
        h.style.top = `${sh.y + corners[i][1] * sh.h}px`;
        paintPoly();
      });
      el.handles.append(h);
    });
    paintPoly();
  }
  function paintPoly() {
    const s = shown();
    el.poly.setAttribute("points", corners.map((c) => `${s.x + c[0] * s.w},${s.y + c[1] * s.h}`).join(" "));
  }

  /* ----- pages ----- */
  async function addPage() {
    buzz("ok");
    const flat = warp(src, corners, SAVE_PX);
    const canvas = enhance(flat, look);
    const thumb = document.createElement("canvas");
    const k = 420 / Math.max(canvas.width, canvas.height);
    thumb.width = Math.round(canvas.width * k);
    thumb.height = Math.round(canvas.height * k);
    thumb.getContext("2d").drawImage(canvas, 0, 0, thumb.width, thumb.height);
    const url = await new Promise((r) => thumb.toBlob((b) => r(URL.createObjectURL(b)), "image/jpeg", 0.8));
    pages.push({ canvas, url });
    src = null;
    if (queue.length) return next();
    await startCamera();
  }
  function next() {
    const c = queue.shift();
    if (c) edit(c);
    else startCamera();
  }
  function showPages() {
    el.pages.replaceChildren();
    pages.forEach((p, i) => {
      const li = document.createElement("li");
      const img = document.createElement("img");
      img.src = p.url;
      img.alt = `Page ${i + 1}`;
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(i + 1);
      const x = document.createElement("button");
      x.type = "button";
      x.className = "x";
      x.setAttribute("aria-label", `Remove page ${i + 1}`);
      x.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><use href="#i-x"/></svg>';
      x.addEventListener("click", () => {
        URL.revokeObjectURL(p.url);
        pages.splice(i, 1);
        buzz("warn");
        if (!pages.length) startCamera();
        else showPages();
      });
      li.append(img, n, x);
      el.pages.append(li);
    });
    setMode("pages");
  }

  async function save(kind) {
    if (!pages.length) return;
    buzz("ok");
    const stamp = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const name = `Scan ${stamp.getDate()} ${stamp.toLocaleString("en", { month: "short" })} ${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
    const imgs = [];
    for (const p of pages) imgs.push({ jpeg: await toJpeg(p.canvas, 0.85), w: p.canvas.width, h: p.canvas.height });
    let blob, filename;
    if (kind === "word") {
      const x = await loadExport();
      blob = x.buildImageDocx(imgs, name);
      filename = `${name}.docx`;
    } else {
      blob = makePdf(imgs, name);
      filename = `${name}.pdf`;
    }
    close(true);
    await openBlob(blob, filename, `scan|${Date.now()}`);
  }

  /* ----- opening and closing ----- */
  async function open() {
    pages = [];
    queue = [];
    src = null;
    el.root.hidden = false;
    await startCamera();
  }
  function close(force) {
    if (!force && pages.length && Date.now() - closeArmed > 2500) {
      closeArmed = Date.now();
      toast(`Press back again to drop ${pages.length} ${pages.length === 1 ? "page" : "pages"}`);
      return false;
    }
    stopCamera();
    for (const p of pages) URL.revokeObjectURL(p.url);
    pages = [];
    src = null;
    el.root.hidden = true;
    return true;
  }

  async function takeFiles(list) {
    const files = [...list].filter((f) => f.type.startsWith("image/")).slice(0, MAX_PAGES - pages.length);
    for (const f of files) {
      try {
        const bmp = await createImageBitmap(f);
        queue.push(toCanvas(bmp));
        bmp.close && bmp.close();
      } catch {
        toast("That photo couldn't be read");
      }
    }
    if (queue.length) {
      stopCamera();
      next();
    }
  }

  /* ----- wiring ----- */
  $("scanClose").addEventListener("click", () => close(false));
  $("scanGallery").addEventListener("click", () => el.file.click());
  el.file.addEventListener("change", () => {
    const l = [...el.file.files];
    el.file.value = "";
    if (l && l.length) takeFiles(l);
  });
  el.capture.addEventListener("change", () => {
    const l = [...el.capture.files];
    el.capture.value = "";
    if (l && l.length) takeFiles(l);
  });
  $("scanShutter").addEventListener("click", () => {
    if (pages.length >= MAX_PAGES) return toast(`${MAX_PAGES} pages is the most for one scan`);
    buzz("medium");
    if (!cameraOk) return el.capture.click(); // no live camera: the phone's own camera app takes the photo
    edit(toCanvas(el.video));
    stopCamera();
  });
  el.done.addEventListener("click", showPages);
  $("scanRetake").addEventListener("click", () => {
    queue = [];
    src = null;
    startCamera();
  });
  $("scanRotate").addEventListener("click", () => {
    src = rotate(src, 1);
    corners = detectCorners(src);
    el.canvas.width = src.width;
    el.canvas.height = src.height;
    el.canvas.getContext("2d").drawImage(src, 0, 0);
    layoutHandles();
  });
  $("scanAdd").addEventListener("click", addPage);
  $("scanMore").addEventListener("click", startCamera);
  $("scanPdf").addEventListener("click", () => save("pdf"));
  $("scanWord").addEventListener("click", () => save("word"));
  for (const b of el.looks.children)
    b.addEventListener("click", () => {
      look = b.dataset.look;
      store("reader.scanLook", look);
      for (const x of el.looks.children) x.classList.toggle("on", x === b);
      buzz("select");
    });
  window.addEventListener("resize", () => mode === "edit" && layoutHandles());

  return { open, close, isOpen: () => !el.root.hidden, back: () => (mode === "pages" ? startCamera() : mode === "edit" ? (queue = [], startCamera()) : close(false)) };
}
