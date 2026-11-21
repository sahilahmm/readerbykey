import * as pdfjsLib from "./lib/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./lib/pdf.worker.min.mjs", import.meta.url).href;

/* ------------------------------------------------------------------ *
 *  Constants + element refs
 * ------------------------------------------------------------------ */

const MAX_RECENT = 10;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 4;
const MAX_PIXELS = 14_000_000; // cap per-page canvas size to protect memory
const PDF_OPTIONS = {
  cMapUrl: new URL("./lib/cmaps/", import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL("./lib/standard_fonts/", import.meta.url).href,
  iccUrl: new URL("./lib/iccs/", import.meta.url).href,
  wasmUrl: new URL("./lib/wasm/", import.meta.url).href,
};

const $ = (id) => document.getElementById(id);
const els = {
  home: $("home"),
  reader: $("reader"),
  openBtn: $("openBtn"),
  fileInput: $("fileInput"),
  recent: $("recent"),
  recentList: $("recentList"),
  empty: $("empty"),
  bar: $("bar"),
  title: $("title"),
  backBtn: $("backBtn"),
  nightBtn: $("nightBtn"),
  zoomIn: $("zoomIn"),
  zoomOut: $("zoomOut"),
  scroller: $("scroller"),
  pages: $("pages"),
  pill: $("pill"),
  sheet: $("sheet"),
  jumpForm: $("jumpForm"),
  jumpInput: $("jumpInput"),
  loading: $("loading"),
  toast: $("toast"),
};

const state = {
  pdf: null,
  id: null,
  meta: null,
  pages: [], // { n, el, ratio, w, h, top, canvas, task, busy, wanted, zgen }
  zoom: 1,
  gen: 0, // bumps whenever a document is opened or closed
  zgen: 0, // bumps whenever page size changes (zoom / rotate / resize)
  queue: [],
  pumping: false,
  raf: 0,
  current: 0,
  night: false,
  chromeHidden: false,
  chromeShownAt: 0,
};

/* ------------------------------------------------------------------ *
 *  Storage (IndexedDB): small "meta" rows + the PDF blobs
 * ------------------------------------------------------------------ */

const META = "meta";
const BLOBS = "blobs";
let dbPromise = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("reader-by-key", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(META, { keyPath: "id" });
      req.result.createObjectStore(BLOBS, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(stores, mode, work) {
  dbPromise ??= openDB();
  return dbPromise.then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        const result = work(...stores.map((s) => t.objectStore(s)));
        t.oncomplete = () => resolve(result && "result" in result ? result.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const getAllMeta = () => tx([META], "readonly", (m) => m.getAll());
const getBlob = (id) => tx([BLOBS], "readonly", (b) => b.get(id));
const putMeta = (meta) => tx([META], "readwrite", (m) => m.put(meta));
const putBoth = (meta, blob) =>
  tx([META, BLOBS], "readwrite", (m, b) => {
    m.put(meta);
    b.put({ id: meta.id, blob });
  });
const deleteBoth = (id) =>
  tx([META, BLOBS], "readwrite", (m, b) => {
    m.delete(id);
    b.delete(id);
  });

async function trimRecent() {
  const all = (await getAllMeta()).sort((a, b) => b.openedAt - a.openedAt);
  for (const old of all.slice(MAX_RECENT)) await deleteBoth(old.id);
}

/* ------------------------------------------------------------------ *
 *  Small helpers
 * ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const stripExt = (name) => name.replace(/\.pdf$/i, "");

let toastTimer = 0;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 2800);
}

function timeAgo(ts) {
  const days = Math.floor((startOfDay(Date.now()) - startOfDay(ts)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 *  Home screen
 * ------------------------------------------------------------------ */

const X_ICON = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

async function renderRecent() {
  let items = [];
  try {
    items = (await getAllMeta()).sort((a, b) => b.openedAt - a.openedAt);
  } catch {
    /* storage unavailable: just show an empty list */
  }

  els.recentList.replaceChildren(
    ...items.map((m) => {
      const li = document.createElement("li");

      const card = document.createElement("button");
      card.type = "button";
      card.className = "card";
      card.addEventListener("click", () => openFromLibrary(m.id));

      const title = document.createElement("div");
      title.className = "card-title";
      title.textContent = stripExt(m.name);

      const meta = document.createElement("div");
      meta.className = "card-meta";
      meta.textContent = m.total
        ? `Page ${m.page || 1} of ${m.total} · ${timeAgo(m.openedAt)}`
        : timeAgo(m.openedAt);

      const bar = document.createElement("div");
      bar.className = "card-bar";
      const fill = document.createElement("i");
      fill.style.width = m.total ? `${Math.round(((m.page || 1) / m.total) * 100)}%` : "0%";
      bar.append(fill);

      card.append(title, meta, bar);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "card-remove";
      remove.setAttribute("aria-label", "Remove from recent");
      remove.innerHTML = X_ICON;
      remove.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove “${stripExt(m.name)}” from Recent?`)) return;
        await deleteBoth(m.id);
        renderRecent();
      });

      li.append(card, remove);
      return li;
    })
  );

  els.recent.hidden = items.length === 0;
  els.empty.hidden = items.length > 0;
}

function showHome() {
  els.reader.hidden = true;
  els.home.hidden = false;
  renderRecent();
}

// Opens a PDF we just received (file picker or "Open with"), resuming progress if we've seen it before.
async function openBlob(blob, name, id) {
  let meta = null;
  try {
    meta = (await getAllMeta()).find((m) => m.id === id) || null;
  } catch {
    /* ignore */
  }
  openDocument({
    id,
    name,
    size: blob.size,
    blob,
    meta: meta || { id, name, size: blob.size, page: 1, idx: 0, frac: 0, zoom: 1, total: 0 },
    persist: true,
  });
}

els.openBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", async () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  els.fileInput.value = "";
  if (!file) return;
  openBlob(file, file.name, `${file.name}|${file.size}|${file.lastModified}`);
});

/* ------------------------------------------------------------------ *
 *  "Open with": a PDF handed to the app by Android (WhatsApp, Files, browser...)
 * ------------------------------------------------------------------ */

function nameFromUri(uri) {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    /* keep raw */
  }
  const last = decoded.split("?")[0].split("/").pop() || "";
  if (/\.pdf$/i.test(last)) return last;
  // content links from some apps carry no file name
  const d = new Date();
  return `PDF ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

let lastExternal = { url: "", at: 0 };
async function openFromUrl(url) {
  if (!/^(content|file):\/\//i.test(url || "")) return;
  // Android can deliver the same intent twice (launch + resume); ignore the echo
  if (url === lastExternal.url && Date.now() - lastExternal.at < 3000) return;
  lastExternal = { url, at: Date.now() };

  els.loading.hidden = false;
  try {
    const res = await fetch(window.Capacitor.convertFileSrc(url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.size) throw new Error("empty");
    await openBlob(blob, nameFromUri(url), `${url}|${blob.size}`);
  } catch (err) {
    console.warn("open-with failed", err);
    els.loading.hidden = true;
    toast("Couldn't open that file.");
  }
}

async function openFromLibrary(id) {
  try {
    const metas = await getAllMeta();
    const meta = metas.find((m) => m.id === id);
    const rec = await getBlob(id);
    if (!meta || !rec) throw new Error("missing");
    openDocument({ id, name: meta.name, size: meta.size, blob: rec.blob, meta, persist: false });
  } catch {
    toast("Couldn't open that file. Try opening it again.");
    renderRecent();
  }
}

/* ------------------------------------------------------------------ *
 *  Opening + closing a document
 * ------------------------------------------------------------------ */

async function openDocument({ id, name, blob, meta, persist }) {
  els.loading.hidden = false;
  closeDocument();
  const gen = ++state.gen;

  try {
    const data = new Uint8Array(await blob.arrayBuffer());
    const task = pdfjsLib.getDocument({ data, ...PDF_OPTIONS });
    task.onPassword = (update, reason) => {
      const pw = window.prompt(
        reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
          ? "Wrong password. Try again:"
          : "This PDF is protected. Enter the password:"
      );
      if (pw === null) task.destroy();
      else update(pw);
    };
    const pdf = await task.promise;
    if (gen !== state.gen) {
      pdf.destroy();
      return;
    }

    const first = await pdf.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    const ratio = vp.height / vp.width;

    state.pdf = pdf;
    state.id = id;
    state.meta = { ...meta, id, name, total: pdf.numPages, openedAt: Date.now() };
    state.zoom = clamp(meta.zoom || 1, MIN_ZOOM, MAX_ZOOM);
    state.zgen++;

    const frag = document.createDocumentFragment();
    state.pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const el = document.createElement("div");
      el.className = "page";
      frag.append(el);
      state.pages.push({ n, el, ratio, w: 0, h: 0, top: 0, canvas: null, task: null, busy: false, wanted: false, zgen: -1 });
    }
    els.pages.replaceChildren(frag);
    els.title.textContent = stripExt(name);

    els.home.hidden = true;
    els.reader.hidden = false;
    applyNight(state.night);

    layout();
    // resume where the reader left off, leaving room so nothing hides under the top bar
    const start = { idx: clamp(meta.idx || 0, 0, pdf.numPages - 1), frac: meta.frac || 0 };
    if (start.idx === 0 && start.frac <= 0) els.scroller.scrollTop = 0;
    else scrollToAnchor(start, els.bar.offsetHeight + 4);
    setChrome(true);
    updateVisible();
    loadSizes(gen);

    if (persist) {
      await putBoth(state.meta, blob);
      await trimRecent();
    } else {
      await putMeta(state.meta);
    }
  } catch (err) {
    if (gen === state.gen) {
      closeDocument();
      showHome();
      if (!(err && err.name === "PasswordException")) toast("Couldn't open this PDF.");
    }
  } finally {
    els.loading.hidden = true;
  }
}

function closeDocument() {
  if (state.pdf) saveProgress(true);
  state.gen++;
  state.queue = [];
  for (const p of state.pages) if (p.task) p.task.cancel();
  if (state.pdf) state.pdf.destroy();
  state.pdf = null;
  state.pages = [];
  state.id = null;
  els.pages.replaceChildren();
}

els.backBtn.addEventListener("click", goHome);
function goHome() {
  closeDocument();
  showHome();
}

/* ------------------------------------------------------------------ *
 *  Layout: every page gets a fixed-size box up front, canvases come later
 * ------------------------------------------------------------------ */

function layout() {
  const base = Math.max(200, els.scroller.clientWidth - 24);
  const w = base * state.zoom;
  for (const p of state.pages) {
    p.w = w;
    p.h = w * p.ratio;
    p.el.style.width = `${p.w}px`;
    p.el.style.height = `${p.h}px`;
  }
  measureTops();
}

function measureTops() {
  const sc = els.scroller;
  const scTop = sc.getBoundingClientRect().top - sc.scrollTop;
  for (const p of state.pages) p.top = p.el.getBoundingClientRect().top - scTop;
}

function findPage(y) {
  const pages = state.pages;
  let lo = 0;
  let hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pages[mid].top <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// An anchor is "page idx, this fraction of the way down it", so a position
// survives zoom, rotation and late page-size corrections.
function getAnchor(cy) {
  const y = els.scroller.scrollTop + cy;
  const idx = findPage(y);
  const p = state.pages[idx];
  return { idx, frac: p && p.h ? (y - p.top) / p.h : 0 };
}

function scrollToAnchor(a, cy) {
  const p = state.pages[a.idx];
  if (p) els.scroller.scrollTop = Math.max(0, p.top + a.frac * p.h - cy);
}

// Real page sizes are read in the background (most PDFs have one size, some mix).
async function loadSizes(gen) {
  const total = state.pdf.numPages;
  const STEP = 20;
  for (let start = 2; start <= total; start += STEP) {
    const nums = [];
    for (let n = start; n < Math.min(total + 1, start + STEP); n++) nums.push(n);

    let ratios;
    try {
      ratios = await Promise.all(
        nums.map(async (n) => {
          const page = await state.pdf.getPage(n);
          const vp = page.getViewport({ scale: 1 });
          return vp.height / vp.width;
        })
      );
    } catch {
      return;
    }
    if (gen !== state.gen) return;

    const changed = [];
    nums.forEach((n, i) => {
      const p = state.pages[n - 1];
      if (p && Math.abs(p.ratio - ratios[i]) > 0.001) changed.push([p, ratios[i]]);
    });
    if (!changed.length) continue;

    // keep what the reader is looking at in place while pages above it resize
    const topIdx = findPage(els.scroller.scrollTop);
    let delta = 0;
    for (const [p, r] of changed) {
      const oldH = p.h;
      p.ratio = r;
      p.h = p.w * r;
      p.el.style.height = `${p.h}px`;
      if (p.n - 1 < topIdx) delta += p.h - oldH;
      if (p.canvas) p.zgen = -1; // re-render with the right shape
    }
    measureTops();
    if (delta) els.scroller.scrollTop += delta;
    schedule();
  }
}

/* ------------------------------------------------------------------ *
 *  Rendering: only pages near the screen get a canvas
 * ------------------------------------------------------------------ */

function schedule() {
  if (state.raf) return;
  state.raf = requestAnimationFrame(() => {
    state.raf = 0;
    updateVisible();
  });
}

function updateVisible() {
  if (!state.pdf) return;
  const sc = els.scroller;
  const y = sc.scrollTop;
  const h = sc.clientHeight;

  const lo = findPage(Math.max(0, y - h * 1.2));
  const hi = findPage(y + h * 2.2);
  const cur = findPage(y + h * 0.35);

  const want = [];
  state.pages.forEach((p, i) => {
    if (i >= lo && i <= hi) {
      p.wanted = true;
      if (!p.busy && (!p.canvas || p.zgen !== state.zgen)) want.push(i);
    } else {
      p.wanted = false;
      if (p.canvas && (i < lo - 5 || i > hi + 5)) release(p);
    }
  });
  want.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur));
  state.queue = want;
  pump();

  if (cur !== state.current || !els.pill.dataset.ready) {
    state.current = cur;
    els.pill.dataset.ready = "1";
    els.pill.textContent = `${cur + 1} / ${state.pages.length}`;
  }
}

async function pump() {
  if (state.pumping) return;
  state.pumping = true;
  try {
    while (state.queue.length) {
      const p = state.pages[state.queue.shift()];
      if (p && p.wanted && !p.busy && (!p.canvas || p.zgen !== state.zgen)) await renderPage(p);
    }
  } finally {
    state.pumping = false;
  }
}

async function renderPage(p) {
  const gen = state.gen;
  const zgen = state.zgen;
  p.busy = true;
  try {
    const page = await state.pdf.getPage(p.n);
    if (gen !== state.gen || zgen !== state.zgen) return;

    const base = page.getViewport({ scale: 1 });
    let scale = (p.w / base.width) * Math.min(window.devicePixelRatio || 1, 2.5);
    const pixels = base.width * scale * (base.height * scale);
    if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext("2d", { alpha: false });

    p.task = page.render({ canvasContext: ctx, viewport });
    await p.task.promise;

    if (gen !== state.gen || zgen !== state.zgen) return;
    if (p.canvas) p.canvas.remove();
    p.el.append(canvas);
    p.canvas = canvas;
    p.zgen = zgen;
    page.cleanup();
  } catch (err) {
    if (!(err && err.name === "RenderingCancelledException")) console.warn("render failed", p.n, err);
  } finally {
    p.task = null;
    p.busy = false;
    if (gen === state.gen && zgen !== state.zgen) schedule();
  }
}

function release(p) {
  if (p.task) p.task.cancel();
  if (p.canvas) {
    p.canvas.width = 0;
    p.canvas.height = 0;
    p.canvas.remove();
    p.canvas = null;
  }
}

// After a size change: keep old canvases (stretched, a little soft) until the
// sharp ones arrive, so the screen never flashes blank.
function sizeChanged() {
  state.zgen++;
  for (const p of state.pages) if (p.task) p.task.cancel();
}

/* ------------------------------------------------------------------ *
 *  Scrolling, progress, toolbars
 * ------------------------------------------------------------------ */

let saveTimer = 0;
els.scroller.addEventListener(
  "scroll",
  () => {
    schedule();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveProgress(false), 500);
    if (!state.chromeHidden && Math.abs(els.scroller.scrollTop - state.chromeShownAt) > 80) setChrome(false);
  },
  { passive: true }
);

function saveProgress(now) {
  if (!state.pdf || !state.meta || !state.pages.length) return;
  const a = getAnchor(0);
  Object.assign(state.meta, {
    idx: a.idx,
    frac: clamp(a.frac, 0, 1),
    page: findPage(els.scroller.scrollTop + els.scroller.clientHeight * 0.35) + 1,
    zoom: state.zoom,
    openedAt: Date.now(),
  });
  const p = putMeta({ ...state.meta });
  if (!now) p.catch(() => {});
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) saveProgress(true);
});

function setChrome(visible) {
  state.chromeHidden = !visible;
  els.reader.classList.toggle("chrome-hidden", !visible);
  if (visible) state.chromeShownAt = els.scroller.scrollTop;
}
els.scroller.addEventListener("click", () => {
  if (window.getSelection && String(window.getSelection())) return;
  setChrome(state.chromeHidden);
});

/* ------------------------------------------------------------------ *
 *  Zoom: buttons and pinch
 * ------------------------------------------------------------------ */

function zoomAt(newZoom, cx, cy) {
  const z = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);
  if (!state.pdf || Math.abs(z - state.zoom) < 0.001) return;

  const sc = els.scroller;
  const a = getAnchor(cy);
  const fx = (sc.scrollLeft + cx) / sc.scrollWidth;

  state.zoom = z;
  sizeChanged();
  layout();
  scrollToAnchor(a, cy);
  sc.scrollLeft = fx * sc.scrollWidth - cx;
  updateVisible();
  saveProgress(false);
}

const center = () => ({ x: els.scroller.clientWidth / 2, y: els.scroller.clientHeight / 2 });
els.zoomIn.addEventListener("click", () => {
  const c = center();
  zoomAt(state.zoom * 1.25, c.x, c.y);
});
els.zoomOut.addEventListener("click", () => {
  const c = center();
  zoomAt(state.zoom / 1.25, c.x, c.y);
});

// pinch: scale the pages with CSS while fingers are down, re-render on release
let pinch = null;
const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

els.scroller.addEventListener(
  "touchstart",
  (e) => {
    if (e.touches.length === 2 && state.pdf) {
      const r = els.scroller.getBoundingClientRect();
      pinch = {
        d0: dist(e.touches),
        z0: state.zoom,
        cx: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left,
        cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top,
        ratio: 1,
      };
      els.pages.style.transformOrigin = `${els.scroller.scrollLeft + pinch.cx}px ${els.scroller.scrollTop + pinch.cy}px`;
    }
  },
  { passive: true }
);

els.scroller.addEventListener(
  "touchmove",
  (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    pinch.ratio = clamp(dist(e.touches) / pinch.d0, MIN_ZOOM / pinch.z0, MAX_ZOOM / pinch.z0);
    els.pages.style.transform = `scale(${pinch.ratio})`;
  },
  { passive: false }
);

function endPinch() {
  if (!pinch) return;
  const p = pinch;
  pinch = null;
  els.pages.style.transform = "";
  els.pages.style.transformOrigin = "";
  zoomAt(p.z0 * p.ratio, p.cx, p.cy);
}
els.scroller.addEventListener("touchend", (e) => {
  if (pinch && e.touches.length < 2) endPinch();
});
els.scroller.addEventListener("touchcancel", endPinch);

/* ------------------------------------------------------------------ *
 *  Rotation / resize
 * ------------------------------------------------------------------ */

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.pdf) return;
    const a = getAnchor(0);
    sizeChanged();
    layout();
    scrollToAnchor(a, 0);
    updateVisible();
  }, 150);
});

/* ------------------------------------------------------------------ *
 *  Night pages
 * ------------------------------------------------------------------ */

function applyNight(on) {
  state.night = on;
  els.reader.classList.toggle("night", on);
  els.nightBtn.setAttribute("aria-pressed", String(on));
}
{
  const saved = store("reader.night");
  state.night = saved === null ? matchMedia("(prefers-color-scheme: dark)").matches : saved === "1";
}
els.nightBtn.addEventListener("click", () => {
  applyNight(!state.night);
  store("reader.night", state.night ? "1" : "0");
});

/* ------------------------------------------------------------------ *
 *  Go to page
 * ------------------------------------------------------------------ */

els.pill.addEventListener("click", (e) => {
  e.stopPropagation();
  els.jumpInput.max = String(state.pages.length);
  els.jumpInput.value = "";
  els.jumpInput.placeholder = `1 – ${state.pages.length}`;
  els.sheet.hidden = false;
  setTimeout(() => els.jumpInput.focus(), 50);
});
els.sheet.addEventListener("click", (e) => {
  if (e.target === els.sheet) closeSheet();
});
els.jumpForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const n = clamp(parseInt(els.jumpInput.value, 10) || 1, 1, state.pages.length);
  closeSheet();
  scrollToAnchor({ idx: n - 1, frac: 0 }, state.chromeHidden ? 12 : els.bar.offsetHeight + 8);
  updateVisible();
});
function closeSheet() {
  els.sheet.hidden = true;
  els.jumpInput.blur();
}

/* ------------------------------------------------------------------ *
 *  Android back button
 * ------------------------------------------------------------------ */

const capApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
if (capApp && capApp.addListener) {
  capApp.addListener("backButton", () => {
    if (!els.sheet.hidden) closeSheet();
    else if (state.pdf) goHome();
    else capApp.exitApp();
  });

  // app already running when a PDF is opened with Reader
  capApp.addListener("appUrlOpen", (e) => openFromUrl(e && e.url));
  // app was closed: it was started by the PDF itself
  if (capApp.getLaunchUrl) {
    capApp
      .getLaunchUrl()
      .then((r) => r && openFromUrl(r.url))
      .catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 *  Start
 * ------------------------------------------------------------------ */

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
renderRecent();
