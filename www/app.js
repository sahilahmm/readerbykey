import * as pdfjsLib from "./lib/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./lib/pdf.worker.min.mjs", import.meta.url).href;

/* ------------------------------------------------------------------ *
 *  Setup
 * ------------------------------------------------------------------ */

const MAX_RECENT = 5; // Recent holds five files; the rest move to the Archive by themselves
const MAX_PINS = 3;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 4;
const MAX_PIXELS = 14_000_000; // cap per-page canvas size to protect memory
const PDF_OPTIONS = {
  standardFontDataUrl: new URL("./lib/standard_fonts/", import.meta.url).href,
  iccUrl: new URL("./lib/iccs/", import.meta.url).href,
  wasmUrl: new URL("./lib/wasm/", import.meta.url).href,
  isEvalSupported: false, // never build code from a document
  enableScripting: false, // PDF JavaScript stays off
  stopAtErrors: false,
};

const MAX_OPEN = 250 * 1024 * 1024; // refuse anything bigger than this, it would not fit in memory
const DOC_EXT = /\.(pdf|docx|pptx|ppsx|txt)$/i;
const EXT = { pdf: ".pdf", docx: ".docx", pptx: ".pptx", txt: ".txt" };
const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
};
const KIND_LABEL = { docx: "Word", pptx: "Slides", txt: "Text" };
const paged = (kind) => kind === "pdf" || kind === "pptx"; // read page by page

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries(
  [
    "home", "reader", "shelf", "list", "empty", "hero", "greeting", "viewLabel", "tools", "themeLabel", "archiveChip", "scanChip", "allChip", "groupChip", "dock", "fileInput",
    "bOpen", "bAdd", "bRemove", "bShare", "bRename", "bArchive", "bDelete", "archiveLabel",
    "bPdf", "bWord", "bYes", "bNo", "bBack", "renameInput", "dockMsg",
    "bar", "title", "backBtn", "textBtn", "nightBtn", "zoomIn", "zoomOut",
    "scroller", "pages", "textView", "pill", "sheet", "jumpForm", "jumpInput",
    "loading", "themeBtn", "bUndo", "pwInput",
  ].map((id) => [id, $(id)])
);

const state = {
  // home
  all: [], // every saved file's meta
  live: [], // not archived, newest first
  shown: [], // what the list on screen holds
  view: "recent", // "recent" | "archive"
  group: store("reader.group") === "type" ? "type" : "date", // how the Archive is grouped
  moved: null, // files that were just moved to the Archive automatically
  sel: new Set(), // selected file ids
  mode: "open", // dock mode
  pending: null, // what the confirm button will do
  undo: null, // what the pill's Undo button will do
  // reader
  open: false, // a document (of any kind) is open
  kind: null, // "pdf" | "docx" | "txt"
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
  text: false,
  textPages: null,
  tz: 1, // text size
  scrollY: 0,
  chromeHidden: false,
  chromeShownAt: 0,
};

let exportMod = null;
const loadExport = () => (exportMod ??= import("./export.js"));
let docsMod = null;
const loadDocs = () => (docsMod ??= import("./docs.js"));
let pptxMod = null;
const loadPptx = () => (pptxMod ??= import("./pptx.js"));

/* ------------------------------------------------------------------ *
 *  Storage (IndexedDB): small "meta" rows + the file blobs
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

// How far you are through a file, 0 to 1 (pages for a PDF, scroll position for Word and text)
function progressOf(m) {
  if (paged(kindOf(m))) return m.total > 1 ? clamp(((m.page || 1) - 1) / (m.total - 1), 0, 1) : 0;
  return clamp(m.pct || 0, 0, 1);
}
// Recent, top to bottom: the most-read files first, new and unread ones at the bottom (newest last).
// Pinned files follow the same pattern but sit below everything else.
const byPattern = (a, b) => progressOf(b) - progressOf(a) || a.openedAt - b.openedAt;
const recentOrder = (list) => [...list.filter((m) => !m.pinned).sort(byPattern), ...list.filter((m) => m.pinned).sort(byPattern)];

// Recent never holds more than MAX_RECENT files. When it would, the most-read unpinned files
// (never the one just opened or restored) move to the Archive. Returns the originals, for Undo.
async function autoArchive(keep = []) {
  const live = (await getAllMeta()).filter((m) => !m.archived);
  const extra = live.length - MAX_RECENT;
  if (extra <= 0) return [];
  const pool = live.filter((m) => !m.pinned && !keep.includes(m.id)).sort((a, b) => progressOf(b) - progressOf(a) || a.openedAt - b.openedAt);
  const moved = [];
  for (const m of pool.slice(0, extra)) {
    await putMeta({ ...m, archived: true, archivedAt: Date.now(), pinned: false });
    moved.push(m);
  }
  return moved;
}

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const stripExt = (name) => name.replace(DOC_EXT, "");
const kindOf = (m) => m.kind || "pdf"; // files saved before Word/text support are PDFs
const extOf = (m) => (m.name.match(DOC_EXT) || [EXT[kindOf(m)]])[0];
// a name with no extension at all gets the right one; ".md" and friends are left alone
const withExt = (name, kind) => (/\.[A-Za-z0-9]{1,5}$/.test(name) ? name : name + EXT[kind]);
// Haptics with some character: each kind of action has its own feel, built from short pulses.
// Uses Capacitor's Haptics plugin (Android and iOS), else the browser's vibrate.
const FEEL = {
  tap: [["i", "LIGHT"]], // buttons, cards
  soft: [["i", "LIGHT"], 28, ["i", "LIGHT"]], // opening the page jump
  medium: [["i", "MEDIUM"]], // theme and night toggles
  heavy: [["i", "HEAVY"]],
  select: [["s"]], // ticking through a selection, zoom steps
  tick: [["s"]], // page changes while scrolling
  double: [["i", "MEDIUM"], 55, ["i", "LIGHT"]], // pin, zoom jump
  ok: [["n", "SUCCESS"]], // done
  warn: [["n", "WARNING"]], // confirm a removal
};
const FALLBACK = { tap: [8], soft: [8, 30, 8], medium: [14], heavy: [24], select: [5], tick: [4], double: [14, 40, 8], ok: [10, 40, 16], warn: [18, 50, 18] };
let lastBuzz = 0;
function buzz(kind = "tap") {
  const now = Date.now();
  if (now - lastBuzz < (kind === "tick" ? 90 : 35)) return;
  lastBuzz = now;
  try {
    const h = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    if (!h) {
      if (navigator.vibrate) navigator.vibrate(FALLBACK[kind] || FALLBACK.tap);
      return;
    }
    let delay = 0;
    for (const step of FEEL[kind] || FEEL.tap) {
      if (typeof step === "number") {
        delay += step;
        continue;
      }
      const run = () => (step[0] === "i" ? h.impact({ style: step[1] }) : step[0] === "n" ? h.notification({ type: step[1] }) : h.selectionChanged());
      if (delay) setTimeout(run, delay);
      else run();
    }
  } catch {
    /* haptics are a nicety */
  }
}
// every button, checkbox dot, pin and card answers a touch, each with the feel that suits it
document.addEventListener(
  "click",
  (e) => {
    const t = e.target.closest && e.target.closest("button, .dot, .pin, .card");
    if (!t) return;
    if (t.matches("#themeBtn, #nightBtn, #textBtn")) buzz("medium");
    else if (t.matches(".pin")) buzz("double");
    else if (t.matches("#zoomIn, #zoomOut, .dot")) buzz("select");
    else if (t.matches("#pill")) buzz("soft");
    else if (t.matches("#bArchive, #bShare, #bRename, #bOpen, #bAdd")) buzz("ok");
    else buzz("tap");
  },
  true
);

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const selMetas = () => state.all.filter((m) => state.sel.has(m.id));

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

// Messages live inside the pill (home) or in the top bar (reader). There is no separate toast.
// With an `undo`, the pill shows the message plus an Undo button for a few seconds.
let noteTimer = 0;
function hideToast() {
  clearTimeout(noteTimer);
  state.undo = null; // lets go of anything the undo was holding on to
}
function toast(msg, undo) {
  hideToast();
  if (els.home.hidden) {
    // reader: borrow the title for a moment
    els.title.textContent = msg;
    els.title.classList.add("note");
    noteTimer = setTimeout(() => {
      els.title.classList.remove("note");
      if (state.meta) els.title.textContent = stripExt(state.meta.name);
    }, 2600);
    return;
  }
  els.dockMsg.textContent = msg;
  state.undo = undo || null;
  setMode(undo ? "undo" : "msg");
  noteTimer = setTimeout(() => {
    state.undo = null;
    setMode(defaultMode());
  }, undo ? 6000 : 2200);
}
els.bUndo.addEventListener("click", async () => {
  const fn = state.undo;
  hideToast();
  setMode(defaultMode());
  if (!fn) return;
  try {
    await fn();
  } catch (err) {
    console.warn("undo failed", err);
    toast("Couldn't undo that");
  }
});

// the password for a protected PDF is typed into the pill, not a system dialog
let pwReply = null;
function askPassword(wrong, reply) {
  pwReply = reply;
  els.loading.hidden = true;
  els.reader.hidden = true;
  els.home.hidden = false;
  els.pwInput.value = "";
  els.pwInput.placeholder = wrong ? "Wrong password, try again" : "PDF password";
  setMode("pw");
  setTimeout(() => els.pwInput.focus(), 300);
}
function answerPassword(value) {
  const reply = pwReply;
  pwReply = null;
  els.pwInput.blur();
  els.pwInput.value = "";
  setMode(defaultMode());
  if (value !== null) busy("Opening…");
  if (reply) reply(value);
}
els.pwInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    answerPassword(els.pwInput.value);
  }
});

function busy(text) {
  els.loading.textContent = text;
  els.loading.hidden = false;
}

function timeAgo(ts) {
  const day = (t) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((day(Date.now()) - day(ts)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/* ------------------------------------------------------------------ *
 *  The pill: one shape that morphs between what you can do right now
 * ------------------------------------------------------------------ */

const seg = {};
els.dock.querySelectorAll(".seg").forEach((e) => (seg[e.dataset.s] = e));

const MODES = {
  open: ["open"], //                          nothing saved yet
  home: ["add", "remove"], //                 something is in Recent
  select: ["share", "rename", "archive"], //  one file is selected
  multi: ["share", "archive", "delete"], //   two or more are selected
  share: ["pdf", "word", "no"],
  rename: ["input", "yes"],
  confirm: ["msg", "yes", "no"],
  undo: ["msg", "undo"],
  pw: ["pw", "yes", "no"],
  msg: ["msg"], //                            a short status, then back to normal
  archive: ["back"],
};

let flashTimer = 0;

function setMode(name) {
  clearTimeout(flashTimer);
  if (name !== "undo") clearTimeout(noteTimer);
  state.mode = name;
  const on = MODES[name];
  for (const [key, el] of Object.entries(seg)) el.classList.toggle("on", on.includes(key));
}

function defaultMode() {
  if (state.sel.size > 1) return "multi";
  if (state.sel.size) return "select";
  if (state.view === "archive") return "archive";
  return state.live.length ? "home" : "open";
}

// show a short message in the pill, then settle back
function flash(text, ms = 1600) {
  els.dockMsg.textContent = text;
  setMode("msg");
  flashTimer = setTimeout(() => setMode(defaultMode()), ms);
}

/* ------------------------------------------------------------------ *
 *  Home
 * ------------------------------------------------------------------ */

// The greeting only shows when there is nothing saved yet, in the middle of the screen
const GREETINGS = ["Your reading, right here.", "Your reading, your pace.", "Your next page awaits."];

function setGreeting() {
  const empty = !state.shown.length;
  const wasHidden = els.hero.hidden;
  els.hero.hidden = !empty;
  els.home.classList.toggle("is-empty", empty);
  if (empty && (wasHidden || !els.greeting.textContent)) {
    els.greeting.textContent = pick(GREETINGS);
    els.hero.style.animation = "none";
    void els.hero.offsetWidth;
    els.hero.style.animation = "";
  }
}

const CHECK = '<svg class="ic" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';

function cardFor(m) {
  const li = document.createElement("li");
  li.className = "card";
  li.dataset.id = m.id;

  const main = document.createElement("button");
  main.type = "button";
  main.className = "card-main";

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = stripExt(m.name);

  // PDFs count pages; Word and text files show how far you have read
  const kind = kindOf(m);
  const pct = Math.round((m.pct || 0) * 100);
  let progress = 0;
  let line = timeAgo(m.openedAt);
  if (paged(kind)) {
    if (m.total) {
      progress = Math.round(((m.page || 1) / m.total) * 100);
      line = `${kind === "pptx" ? "Slides · Slide" : "Page"} ${m.page || 1} of ${m.total} · ${line}`;
    }
  } else {
    progress = pct;
    line = `${KIND_LABEL[kind]} · ${pct > 0 ? `${pct}% · ` : ""}${line}`;
  }

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.textContent = line;

  const bar = document.createElement("div");
  bar.className = "card-bar";
  const fill = document.createElement("i");
  fill.style.width = `${progress}%`;
  bar.append(fill);

  main.append(title, meta, bar);

  const dot = document.createElement("button");
  dot.type = "button";
  dot.className = "dot";
  dot.setAttribute("aria-label", "Select");
  dot.innerHTML = CHECK;

  if (!m.archived) {
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "pin";
    pin.setAttribute("aria-label", m.pinned ? "Unpin" : "Pin to the bottom");
    pin.setAttribute("aria-pressed", String(!!m.pinned));
    pin.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7"/></svg>';
    li.append(main, pin, dot);
    li.classList.toggle("pinned", !!m.pinned);
  } else li.append(main, dot);
  return li;
}

const startOfDay = (t) => new Date(t).setHours(0, 0, 0, 0);
const TYPE_LABEL = { pdf: "PDF", docx: "Word", pptx: "Slides", txt: "Text" };
const TYPE_ORDER = ["PDF", "Word", "Slides", "Text"];
function groupOf(m) {
  if (state.group === "type") return { label: TYPE_LABEL[kindOf(m)], rank: TYPE_ORDER.indexOf(TYPE_LABEL[kindOf(m)]) };
  const t = m.archivedAt || m.openedAt;
  const days = Math.round((startOfDay(Date.now()) - startOfDay(t)) / 86_400_000);
  const d = new Date(t);
  const now = new Date();
  if (days <= 0) return { label: "Today", rank: 0 };
  if (days < 7) return { label: "This week", rank: 1 };
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return { label: "Earlier this month", rank: 2 };
  return { label: d.toLocaleDateString(undefined, { month: "long", year: "numeric" }), rank: 3 + (now.getFullYear() * 12 + now.getMonth() - (d.getFullYear() * 12 + d.getMonth())) };
}

async function refreshHome(settle = true) {
  let all = [];
  try {
    all = (await getAllMeta()).sort((a, b) => b.openedAt - a.openedAt);
  } catch {
    /* storage unavailable: behave as empty */
  }
  state.all = all;
  state.live = recentOrder(all.filter((m) => !m.archived));
  // like Recent, the newest sits at the bottom, closest to the thumb; files are grouped
  const when = (m) => m.archivedAt || m.openedAt;
  const byType = state.group === "type";
  const archived = all
    .filter((m) => m.archived)
    .map((m) => ({ m, g: groupOf(m) }))
    .sort((x, y) => (byType ? x.g.rank - y.g.rank : y.g.rank - x.g.rank) || when(x.m) - when(y.m));
  state.archivedCount = archived.length;
  if (state.view === "archive" && !archived.length) state.view = "recent";

  const inArchive = state.view === "archive";
  state.shown = inArchive ? archived.map((x) => x.m) : state.live;
  for (const id of [...state.sel]) if (!state.shown.some((m) => m.id === id)) state.sel.delete(id);

  const rows = [];
  if (inArchive) {
    let last = null;
    for (const { m, g } of archived) {
      if (g.label !== last) {
        const head = document.createElement("li");
        head.className = "group-head";
        head.textContent = g.label;
        rows.push(head);
        last = g.label;
      }
      rows.push(cardFor(m));
    }
  } else rows.push(...state.live.map(cardFor));
  els.shelf.classList.toggle("archive", inArchive);
  // the last Recent file just left: fade the list out first so the logo and greeting arrive smoothly
  const nowEmpty = !state.shown.length;
  const fading = state.homeWasEmpty === false && nowEmpty && !els.home.hidden && state.view !== "archive";
  if (fading) {
    els.shelf.classList.add("leaving");
    await new Promise((r) => setTimeout(r, 170));
  }
  state.homeWasEmpty = nowEmpty;
  els.list.replaceChildren(...rows);
  // both lists start at the bottom, the thumb end
  els.list.scrollTop = els.list.scrollHeight;
  markSel();

  els.archiveChip.textContent = `Archive · ${archived.length}`;
  els.viewLabel.textContent = `Archive · ${archived.length}`;
  els.groupChip.textContent = state.group === "type" ? "Group: Type" : "Group: Date";

  setGreeting();
  if (fading) {
    els.shelf.classList.remove("leaving");
    els.shelf.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "ease-out", delay: 120, fill: "backwards" });
  }
  resetThemeMorph();
  if (settle) setMode(defaultMode());
  maybeNudge();
}

// the tools row above the files: the theme button turns into Select all / Clear while you select
function paintTools() {
  const n = state.sel.size;
  const canAll = n > 0 && state.shown.length > 1;
  els.allChip.hidden = !canAll;
  els.themeBtn.hidden = canAll;
  els.allChip.textContent = n >= state.shown.length ? "Clear" : "Select all";
  // no Archive button until you swipe: the theme button wears a thin blue line when there is one
  els.archiveChip.hidden = true;
  els.themeBtn.classList.toggle("has-archive", !!state.archivedCount && state.view !== "archive");
  els.themeLabel.textContent = `Archive · ${state.archivedCount}`;
  els.groupChip.hidden = n > 0 || state.view !== "archive";
  els.scanChip.hidden = !SCAN_READY || n > 0 || state.view === "archive";
  els.viewLabel.hidden = state.view !== "archive";
}

function markSel() {
  for (const li of els.list.children) if (li.dataset.id) li.classList.toggle("sel", state.sel.has(li.dataset.id));
  const ms = selMetas();
  els.archiveLabel.textContent = ms.length && ms.every((m) => m.archived) ? "Restore" : "Archive";
  paintTools();
}

function toggleSelect(id, on) {
  const want = on ?? !state.sel.has(id);
  if (want) state.sel.add(id);
  else state.sel.delete(id);
  markSel();
  setMode(defaultMode());
}

function clearSel() {
  state.sel.clear();
  markSel();
  setMode(defaultMode());
}

els.allChip.addEventListener("click", () => {
  const everyone = state.shown.length > 0 && state.shown.every((m) => state.sel.has(m.id));
  if (everyone) state.sel.clear();
  else for (const m of state.shown) state.sel.add(m.id);
  markSel();
  setMode(defaultMode());
});

// told once, on the way back home, when files were moved to the Archive by themselves
function announceMoved() {
  const moved = state.moved;
  state.moved = null;
  if (!moved || !moved.length) return;
  toast(`Moved ${moved.length} to Archive`, async () => {
    for (const m of moved) await putMeta(m);
    await refreshHome();
  });
}

function showHome() {
  els.reader.hidden = true;
  els.home.hidden = false;
  state.sel.clear();
  return refreshHome().then(() => {
    announceMoved();
  });
}

/* --- tapping, selecting, long-press, drag to select --- */

let press = null;
let drag = null; // { want, last, moved }: sliding a finger over files selects (or unselects) them
let suppressClick = false;

function dragTo(e) {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const card = hit && hit.closest && hit.closest(".card");
  if (!card || !els.list.contains(card) || card.dataset.id === drag.last) return;
  const cards = [...els.list.querySelectorAll(".card")];
  const i0 = cards.findIndex((c) => c.dataset.id === drag.last);
  const i1 = cards.indexOf(card);
  if (i0 < 0 || i1 < 0) return;
  for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) {
    if (drag.want) state.sel.add(cards[i].dataset.id);
    else state.sel.delete(cards[i].dataset.id);
  }
  drag.last = card.dataset.id;
  drag.moved = true;
  buzz("select");
  markSel();
  setMode(defaultMode());
}

els.list.addEventListener("pointerdown", (e) => {
  const card = e.target.closest(".card");
  press = null;
  drag = null;
  suppressClick = false;
  if (!card) return;
  if (e.target.closest(".pin")) return;
  if (e.target.closest(".dot")) {
    drag = { want: !state.sel.has(card.dataset.id), last: card.dataset.id, moved: false };
    return;
  }
  press = { x: e.clientX, y: e.clientY, fired: false };
  press.timer = setTimeout(() => {
    press.fired = true;
    if (navigator.vibrate) navigator.vibrate(12);
    toggleSelect(card.dataset.id, true);
    drag = { want: true, last: card.dataset.id, moved: false };
  }, 450);
});
const cancelPress = () => press && clearTimeout(press.timer);
els.list.addEventListener("pointermove", (e) => {
  if (drag && (press ? press.fired : true)) return dragTo(e);
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
});
// once a drag-select has started, the page must not scroll under the finger
els.list.addEventListener(
  "touchmove",
  (e) => {
    if (drag && (press ? press.fired : true) && e.cancelable) e.preventDefault();
  },
  { passive: false }
);
const endPointer = () => {
  cancelPress();
  if (drag && drag.moved) suppressClick = true;
  drag = null;
};
els.list.addEventListener("pointerup", endPointer);
els.list.addEventListener("pointercancel", endPointer);
els.list.addEventListener("contextmenu", (e) => e.preventDefault());

els.list.addEventListener("click", (e) => {
  if (suppressClick) {
    suppressClick = false; // this click is just the end of a drag
    return;
  }
  if (press && press.fired) {
    press = null; // this click is just the end of a long-press
    return;
  }
  const pin = e.target.closest(".pin");
  if (pin) return togglePin(pin.closest(".card").dataset.id);
  const card = e.target.closest(".card");
  if (!card) {
    if (state.sel.size) clearSel();
    return;
  }
  const id = card.dataset.id;
  // once something is selected, a tap on any card adds it or takes it away
  if (e.target.closest(".dot") || state.sel.size) toggleSelect(id);
  else openFromLibrary(id);
});

/* --- pill buttons --- */

const pickFile = () => els.fileInput.click();
els.bOpen.addEventListener("click", pickFile);
els.bAdd.addEventListener("click", pickFile);

els.bRemove.addEventListener("click", () => {
  const last = state.live[state.live.length - 1];
  if (!last) return;
  state.pending = { type: "remove", ids: [last.id] };
  els.dockMsg.textContent = `Remove “${stripExt(last.name)}”?`;
  setMode("confirm");
});

els.bDelete.addEventListener("click", () => {
  const ids = [...state.sel];
  if (!ids.length) return;
  buzz("warn");
  state.pending = { type: "remove", ids };
  els.dockMsg.textContent = ids.length > 1 ? `Remove ${ids.length} files?` : "Remove this file?";
  setMode("confirm");
});

els.bNo.addEventListener("click", () => {
  if (state.mode === "pw") return answerPassword(null);
  setMode(defaultMode());
});

els.bYes.addEventListener("click", async () => {
  if (state.mode === "rename") return commitRename();
  if (state.mode === "pw") return answerPassword(els.pwInput.value);
  if (state.mode !== "confirm" || !state.pending) return;
  const { type, ids } = state.pending;
  state.pending = null;
  if (type === "remove") await removeFiles(ids);
});

// Deleting keeps the files in memory for a few seconds so the toast can bring them back.
async function removeFiles(ids) {
  const saved = [];
  for (const id of ids) {
    const meta = state.all.find((m) => m.id === id);
    const rec = await getBlob(id).catch(() => null);
    if (meta && rec) saved.push({ meta, blob: rec.blob });
    await deleteBoth(id).catch(() => {});
  }
  state.sel.clear();
  await refreshHome();
  toast(
    ids.length > 1 ? `Removed ${ids.length} files` : "Removed",
    saved.length
      ? async () => {
          for (const s of saved) await putBoth(s.meta, s.blob);
          await refreshHome();
        }
      : null
  );
}

els.bArchive.addEventListener("click", async () => {
  const ms = selMetas();
  if (!ms.length) return;
  const archiving = !ms[0].archived;
  for (const m of ms) await putMeta(archiving ? { ...m, archived: true, archivedAt: Date.now(), pinned: false } : { ...m, archived: false });
  // restoring can overfill Recent: the most-read files then move over by themselves
  const moved = archiving ? [] : await autoArchive(ms.map((m) => m.id));
  state.sel.clear();
  await refreshHome();
  const word = archiving ? "Archived" : "Restored";
  const base = ms.length > 1 ? `${word} ${ms.length} files` : word;
  toast(moved.length ? `${base} · ${moved.length} moved over` : base, async () => {
    for (const m of [...ms, ...moved]) await putMeta(m);
    await refreshHome();
  });
});

async function togglePin(id) {
  const m = state.all.find((x) => x.id === id);
  if (!m) return;
  if (!m.pinned && state.live.filter((x) => x.pinned).length >= MAX_PINS) {
    toast(`You can pin up to ${MAX_PINS} files`);
    return;
  }
  await putMeta({ ...m, pinned: !m.pinned });
  await refreshHome();
  toast(m.pinned ? "Unpinned" : "Pinned to the bottom", async () => {
    await putMeta(m);
    await refreshHome();
  });
}

els.groupChip.addEventListener("click", () => {
  state.group = state.group === "type" ? "date" : "type";
  store("reader.group", state.group);
  refreshHome(false);
});

els.bRename.addEventListener("click", () => {
  const m = selMetas()[0];
  if (!m) return;
  els.renameInput.value = stripExt(m.name);
  setMode("rename");
  setTimeout(() => {
    els.renameInput.focus();
    els.renameInput.select();
  }, 300);
});
els.renameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commitRename();
  }
});

async function commitRename() {
  const m = selMetas()[0];
  const name = els.renameInput.value.trim().replace(DOC_EXT, "");
  els.renameInput.blur();
  if (!m || !name || name === stripExt(m.name)) {
    setMode(defaultMode());
    return;
  }
  await putMeta({ ...m, name: `${name}${extOf(m)}` });
  state.sel.clear();
  await refreshHome();
  toast("Renamed", async () => {
    const cur = state.all.find((x) => x.id === m.id);
    if (cur) await putMeta({ ...cur, name: m.name });
    await refreshHome();
  });
}

// PDFs can go out as PDF or Word; Word and text files go out as they are
els.bShare.addEventListener("click", () => {
  const ms = selMetas();
  if (!ms.length) return;
  if (ms.every((m) => kindOf(m) === "pdf")) setMode("share");
  else shareSelected("original");
});
els.bPdf.addEventListener("click", () => shareSelected("original"));
els.bWord.addEventListener("click", () => shareSelected("word"));

async function shareSelected(how) {
  const ms = selMetas();
  if (!ms.length) return;
  const word = how === "word";
  flash(word ? "Making your Word file…" : "Preparing…", 120000);
  try {
    const x = await loadExport();
    const items = [];
    let skipped = 0;
    for (const m of ms) {
      const rec = await getBlob(m.id);
      if (!rec) throw new Error("missing file");
      const base = x.safeName(stripExt(m.name));
      if (word) {
        const pages = await x.textOfBlob(pdfjsLib, rec.blob);
        if (!pages.some((p) => p.length)) {
          skipped++;
          continue;
        }
        items.push({ blob: x.buildDocx(pages, stripExt(m.name)), filename: `${base}.docx`, mime: x.DOCX_MIME });
      } else {
        const kind = kindOf(m);
        items.push({ blob: rec.blob, filename: `${base}${EXT[kind]}`, mime: MIME[kind] });
      }
    }
    if (!items.length) {
      flash(ms.length > 1 ? "No text found in these PDFs" : "No text found in this PDF", 2600);
      return;
    }
    const title = items.length === 1 ? items[0].filename.replace(/\.\w+$/, "") : "Documents";
    const result = await x.shareFiles(items, title);
    if (result === "shared") state.sel.clear();
    markSel();
    flash(result === "shared" ? (skipped ? `Shared · ${skipped} had no text` : "Shared") : "Cancelled");
  } catch (err) {
    console.warn("share failed", err);
    flash("Couldn't share that", 2400);
  }
}

// moving between Recent and the Archive: the shelf fades down, swaps, and rises back in
async function switchView(view) {
  if (state.view === view) return;
  els.shelf.classList.add("leaving");
  await new Promise((r) => setTimeout(r, 140));
  state.view = view;
  state.sel.clear();
  await refreshHome();
  els.shelf.classList.remove("leaving");
  els.shelf.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "ease-out" });
}
els.archiveChip.addEventListener("click", () => switchView("archive"));

// Swipe the theme button to the right: it stretches into the Archive button under your thumb.
// Let go past the halfway point to open the Archive, otherwise it shrinks back into the theme button.
const SCAN_READY = true;
let scanner = null;
async function openScanner() {
  if (!scanner) {
    const { createScanner } = await import("./scan-ui.js");
    scanner = createScanner({ openBlob, toast, buzz, loadExport, store });
  }
  await scanner.open();
}
els.scanChip.addEventListener("click", openScanner);
let themeDragUntil = 0; // a tap right after a drag is part of the drag, not a theme toggle
const swipe = (function swipeToArchive() {
  const btn = els.themeBtn;
  const FULL = 150; // px of drag for the button to become the full Archive button
  let start = null, dx = 0, moved = false;
  const paint = (p) => {
    btn.style.setProperty("--p", p.toFixed(3));
    btn.style.width = `${48 + p * 120}px`;
  };
  const reset = () => {
    btn.classList.remove("dragging", "morphed");
    btn.classList.add("snap");
    btn.style.removeProperty("--p");
    btn.style.width = "";
    delete btn.dataset.armed;
  };
  btn.addEventListener("pointerdown", (e) => {
    if (state.view === "archive") return; // the swipe only opens the Archive; inside it the button is just the theme button
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    dx = 0;
    moved = false;
    btn.classList.remove("snap");
  });
  btn.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.id) return;
    dx = e.clientX - start.x;
    if (!moved && dx > 8 && dx > Math.abs(e.clientY - start.y)) {
      moved = true;
      btn.setPointerCapture(e.pointerId);
      btn.classList.add("dragging", "morphed");
    }
    if (!moved) return;
    const p = Math.max(0, Math.min(dx / FULL, 1));
    paint(p);
    if (p > 0.55 && !btn.dataset.armed) {
      btn.dataset.armed = "1";
      buzz("select"); // you can feel the point where letting go opens it
    } else if (p <= 0.55) delete btn.dataset.armed;
  });
  const end = () => {
    if (!start) return;
    const open = moved && dx / FULL > 0.55;
    const wasMoved = moved;
    start = null;
    if (wasMoved) {
      themeDragUntil = Date.now() + 450;
      store("reader.swipeHint", "1");
    }
    reset();
    if (open) {
      if (state.archivedCount && state.view !== "archive") {
        buzz("double");
        switchView("archive");
      } else flash("Archive is empty");
    }
  };
  btn.addEventListener("pointerup", end);
  btn.addEventListener("pointercancel", end);
  btn.addEventListener("lostpointercapture", end);
  return { paint, reset };
})();
els.bBack.addEventListener("click", () => switchView("recent"));

function resetThemeMorph() {
  els.themeBtn.classList.remove("dragging", "morphed", "snap");
  els.themeBtn.style.removeProperty("--p");
  els.themeBtn.style.width = "";
}

// The first time something is archived, the theme button stretches a little and springs back,
// with a line in the pill, so the swipe gets discovered. It only ever plays once.
let nudgeTimer = 0;
function maybeNudge() {
  if (store("reader.swipeHint") || !state.archivedCount || state.view !== "recent" || els.home.hidden || state.sel.size) return;
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => {
    if (store("reader.swipeHint") || state.view !== "recent" || els.home.hidden || state.sel.size) return;
    store("reader.swipeHint", "1");
    toast("Swipe the moon right to open your Archive");
    const btn = els.themeBtn;
    btn.classList.remove("snap");
    btn.classList.add("morphed", "dragging");
    const t0 = performance.now(), D = 1500;
    const step = (now) => {
      const x = Math.min((now - t0) / D, 1);
      const p = 0.62 * Math.sin(Math.PI * x) ** 0.6; // out, hold a moment, back
      swipe.paint(p);
      if (x < 1) requestAnimationFrame(step);
      else resetThemeMorph();
    };
    buzz("select");
    requestAnimationFrame(step);
  }, 900);
}

// lift the pill above the keyboard if the page isn't resized for it
if (window.visualViewport) {
  const vv = window.visualViewport;
  const fit = () => els.dock.style.setProperty("--kb", `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`);
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
}

/* ------------------------------------------------------------------ *
 *  Getting a document in: file picker, library, "Open with"
 * ------------------------------------------------------------------ */

async function openBlob(blob, name, id) {
  if (blob.size > MAX_OPEN) {
    els.loading.hidden = true;
    toast("That file is too large for Reader.");
    return;
  }
  let meta = null;
  try {
    meta = (await getAllMeta()).find((m) => m.id === id) || null;
  } catch {
    /* ignore */
  }
  openDocument({
    id,
    name,
    blob,
    meta: { ...(meta || { page: 1, idx: 0, frac: 0, zoom: 1, total: 0, pct: 0 }), id, name, size: blob.size, archived: false },
    persist: true,
  });
}

els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  els.fileInput.value = "";
  if (file) openBlob(file, file.name, `${file.name}|${file.size}|${file.lastModified}`);
});

async function openFromLibrary(id) {
  try {
    const meta = (await getAllMeta()).find((m) => m.id === id);
    const rec = await getBlob(id);
    if (!meta || !rec) throw new Error("missing");
    openDocument({ id, name: meta.name, blob: rec.blob, meta, persist: false });
  } catch {
    await refreshHome();
    toast("Couldn't open that file. Try opening it again.");
  }
}

function nameFromUri(uri) {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    /* keep raw */
  }
  const last = (decoded.split("?")[0].split("/").pop() || "").split(":").pop();
  if (/\.[A-Za-z0-9]{1,5}$/.test(last)) return last;
  // some apps share a link with no file name in it
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `Document ${d.getDate()} ${d.toLocaleDateString("en", { month: "short" })} ${hh}${mm}`;
}

let lastExternal = { url: "", at: 0 };
async function openFromUrl(url) {
  if (!/^(content|file):\/\//i.test(url || "")) return;
  // Android can deliver the same intent twice (launch + resume); ignore the echo
  if (url === lastExternal.url && Date.now() - lastExternal.at < 3000) return;
  lastExternal = { url, at: Date.now() };

  busy("Opening…");
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

// Apps often hand over a file with no useful name or type, so look at the bytes.
async function detectKind(blob, name, known) {
  if (known) return known;
  const unsupported = () => Object.assign(new Error("unsupported"), { name: "Unsupported" });
  const head = new Uint8Array(await blob.slice(0, 1100).arrayBuffer());
  const at = String.fromCharCode(...head).indexOf("%PDF-");
  if (at === 0 || (at > 0 && /\.pdf$/i.test(name))) return "pdf";
  if (head[0] === 0x50 && head[1] === 0x4b) {
    // a zip: go by the name, else by what the package holds; the readers check the rest
    if (/\.(pptx|ppsx)$/i.test(name)) return "pptx";
    if (/\.docx$/i.test(name)) return "docx";
    // no useful name (WhatsApp says "Document 23 Nov"): look inside the package
    try {
      const zip = await (await loadDocs()).openZip(blob);
      if (zip.has("ppt/presentation.xml")) return "pptx";
    } catch {
      /* the Word reader will say what is wrong */
    }
    return "docx";
  }
  if (head[0] === 0xd0 && head[1] === 0xcf) throw unsupported(); // old .doc
  if (/\.pdf$/i.test(name)) return "pdf"; // let PDF.js say what is wrong with it
  const utf16 = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
  if (!utf16 && head.includes(0)) throw unsupported(); // binary of some other kind
  return "txt";
}

/* ------------------------------------------------------------------ *
 *  Opening + closing a document
 * ------------------------------------------------------------------ */

async function openDocument({ id, name, blob, meta, persist }) {
  busy("Opening…");
  hideToast();
  closeDocument();
  const gen = ++state.gen;

  try {
    const kind = await detectKind(blob, name, meta.kind);
    name = withExt(name, kind);
    const ok = kind === "pdf" ? await showPdf(gen, id, name, blob, meta) : kind === "pptx" ? await showDeck(gen, id, name, blob, meta) : await showTextDoc(gen, kind, id, name, blob, meta);
    if (!ok || gen !== state.gen) return;

    if (persist) {
      await putBoth(state.meta, blob);
      state.moved = await autoArchive([id]);
    } else {
      await putMeta(state.meta);
    }
  } catch (err) {
    if (gen === state.gen) {
      closeDocument();
      await showHome();
      if (err && err.name === "PasswordException") return; // they cancelled the password box
      toast(err && err.name === "Unsupported" ? "Reader opens PDF, Word, PowerPoint and text files." : "Couldn't open this file.");
    }
  } finally {
    els.loading.hidden = true;
  }
}

async function showPdf(gen, id, name, blob, meta) {
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = pdfjsLib.getDocument({ data, ...PDF_OPTIONS });
  task.onPassword = (update, reason) => {
    askPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD, (pw) => {
      if (pw === null) task.destroy();
      else update(pw);
    });
  };
  const pdf = await task.promise;
  if (gen !== state.gen) {
    pdf.destroy();
    return false;
  }

  const first = await pdf.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  const ratio = vp.height / vp.width;

  state.pdf = pdf;
  state.open = true;
  state.kind = "pdf";
  state.id = id;
  state.meta = { ...meta, id, name, kind: "pdf", total: pdf.numPages, openedAt: Date.now() };
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
  else scrollToAnchor(start, 8);
  setChrome(true);
  updateVisible();
  loadSizes(gen);
  return true;
}

// A presentation is laid out like a PDF: one box per slide, drawn when it scrolls into view.
async function showDeck(gen, id, name, blob, meta) {
  const x = await loadPptx();
  const deck = await x.readPptx(blob);
  if (gen !== state.gen) {
    deck.urls.forEach((u) => URL.revokeObjectURL(u));
    return false;
  }
  state.deck = deck;
  state.deckMod = x;
  state.docUrls = deck.urls;
  state.pdf = { numPages: deck.slides.length, destroy() {} };
  state.open = true;
  state.kind = "pptx";
  state.id = id;
  state.meta = { ...meta, id, name, kind: "pptx", total: deck.slides.length, openedAt: Date.now() };
  state.zoom = clamp(meta.zoom || 1, MIN_ZOOM, MAX_ZOOM);
  state.zgen++;

  const ratio = deck.h / deck.w;
  const frag = document.createDocumentFragment();
  state.pages = [];
  for (let n = 1; n <= deck.slides.length; n++) {
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
  const start = { idx: clamp(meta.idx || 0, 0, deck.slides.length - 1), frac: meta.frac || 0 };
  if (start.idx === 0 && start.frac <= 0) els.scroller.scrollTop = 0;
  else scrollToAnchor(start, 8);
  setChrome(true);
  updateVisible();
  return true;
}

// Word and text files open straight into the reflowing text view.
async function showTextDoc(gen, kind, id, name, blob, meta) {
  const x = await loadDocs();
  let paras = null;
  let doc = null;
  if (kind === "docx") doc = await x.readDocx(blob);
  else paras = await x.readText(blob);
  if (gen !== state.gen) {
    if (doc) doc.urls.forEach((u) => URL.revokeObjectURL(u));
    return false;
  }
  state.docUrls = doc ? doc.urls : [];

  state.open = true;
  state.kind = kind;
  state.id = id;
  state.meta = { ...meta, id, name, kind, total: 0, openedAt: Date.now() };
  if (doc) {
    state.textPages = null;
    els.textView.replaceChildren();
    if (doc.blocks.length) x.renderBlocks(doc.blocks, els.textView);
    else {
      const p = document.createElement("p");
      p.textContent = "This Word document has no text.";
      els.textView.append(p);
    }
  } else {
    state.textPages = [paras];
    renderText(state.textPages, "This file is empty.");
  }
  els.title.textContent = stripExt(name);

  els.home.hidden = true;
  els.reader.hidden = false;
  els.reader.classList.add("textdoc");
  applyNight(state.night);
  setTextView(true);

  const max = els.textView.scrollHeight - els.textView.clientHeight;
  els.textView.scrollTop = max > 0 ? clamp(meta.pct || 0, 0, 1) * max : 0;
  setChrome(true);
  return true;
}

function closeDocument() {
  if (state.open) saveProgress(true);
  state.gen++;
  state.queue = [];
  for (const p of state.pages) if (p.task) p.task.cancel();
  if (state.pdf) state.pdf.destroy();
  state.pdf = null;
  state.deck = null;
  state.pages = [];
  state.id = null;
  state.open = false;
  state.kind = null;
  state.textPages = null;
  if (state.docUrls) state.docUrls.forEach((u) => URL.revokeObjectURL(u));
  state.docUrls = null;
  els.reader.classList.remove("textdoc");
  setTextView(false);
  els.textView.replaceChildren();
  els.pages.replaceChildren();
}

function goHome() {
  closeDocument();
  showHome();
}
els.backBtn.addEventListener("click", goHome);

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
    if (els.pill.dataset.ready) buzz("tick");
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
  if (state.kind === "pptx") {
    try {
      const deck = state.deck;
      const el = state.deckMod.drawSlide(deck.slides[p.n - 1], deck);
      el.style.transform = `scale(${p.w / deck.w})`;
      if (p.canvas) p.canvas.remove();
      p.el.append(el);
      p.canvas = el;
      p.zgen = zgen;
      state.deckMod.fitSlide(el);
    } catch (err) {
      console.warn("slide failed", p.n, err);
    } finally {
      p.busy = false;
    }
    return;
  }
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
    if (p.canvas.tagName === "CANVAS") {
      p.canvas.width = 0;
      p.canvas.height = 0;
    }
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
 *  Scrolling, progress, toolbar
 * ------------------------------------------------------------------ */

const scrollPos = () => (state.text ? els.textView.scrollTop : els.scroller.scrollTop);

let saveTimer = 0;
function onReadScroll() {
  if (!state.chromeHidden && Math.abs(scrollPos() - state.chromeShownAt) > 80) setChrome(false);
}
els.scroller.addEventListener(
  "scroll",
  () => {
    schedule();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveProgress(false), 500);
    onReadScroll();
  },
  { passive: true }
);
els.textView.addEventListener(
  "scroll",
  () => {
    onReadScroll();
    // Word and text files remember how far you read; PDFs in Text view do not
    if (state.open && !paged(state.kind)) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveProgress(false), 500);
    }
  },
  { passive: true }
);

function saveProgress(now) {
  if (!state.open || !state.meta) return;
  if (paged(state.kind)) {
    if (!state.pdf || !state.pages.length || state.text) return;
    const a = getAnchor(0);
    Object.assign(state.meta, {
      idx: a.idx,
      frac: clamp(a.frac, 0, 1),
      page: findPage(els.scroller.scrollTop + els.scroller.clientHeight * 0.35) + 1,
      zoom: state.zoom,
      openedAt: Date.now(),
    });
  } else {
    const tv = els.textView;
    const max = tv.scrollHeight - tv.clientHeight;
    Object.assign(state.meta, { pct: max > 0 ? clamp(tv.scrollTop / max, 0, 1) : 0, openedAt: Date.now() });
  }
  const p = putMeta({ ...state.meta });
  if (!now) p.catch(() => {});
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) saveProgress(true);
});

function setChrome(visible) {
  state.chromeHidden = !visible;
  els.reader.classList.toggle("chrome-hidden", !visible);
  if (visible) state.chromeShownAt = scrollPos();
}
let chromeTimer = 0;
function tapToggleChrome() {
  if (window.getSelection && String(window.getSelection())) return;
  // wait a beat: a second tap means "zoom", not "show or hide the toolbar"
  clearTimeout(chromeTimer);
  chromeTimer = setTimeout(() => setChrome(state.chromeHidden), 260);
}
els.scroller.addEventListener("click", tapToggleChrome);
els.textView.addEventListener("click", tapToggleChrome);

/* ------------------------------------------------------------------ *
 *  Zoom: buttons and pinch (in Text view the same buttons change text size)
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

function zoomBy(factor) {
  if (state.text) {
    state.tz = clamp(state.tz * factor, 0.8, 2.4);
    els.textView.style.setProperty("--tz", state.tz);
    store("reader.tz", String(state.tz));
    return;
  }
  zoomAt(state.zoom * factor, els.scroller.clientWidth / 2, els.scroller.clientHeight / 2);
}
els.zoomIn.addEventListener("click", () => zoomBy(1.25));
els.zoomOut.addEventListener("click", () => zoomBy(1 / 1.25));

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

// Double tap: zoom in on the spot you tapped, double tap again to go back to fit-width.
// In Text view it switches the text between normal and large.
let lastTap = null;
let tapStart = null;
function watchDoubleTap(el, onDouble) {
  el.addEventListener(
    "touchstart",
    (e) => {
      tapStart = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
      if (e.touches.length > 1) lastTap = null;
    },
    { passive: true }
  );
  el.addEventListener("touchend", (e) => {
    if (!tapStart || e.touches.length || e.changedTouches.length !== 1 || pinch) return;
    const t = e.changedTouches[0];
    const moved = Math.hypot(t.clientX - tapStart.x, t.clientY - tapStart.y);
    const quick = Date.now() - tapStart.t < 300;
    tapStart = null;
    if (moved > 12 || !quick) {
      lastTap = null;
      return;
    }
    const now = Date.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 40) {
      lastTap = null;
      clearTimeout(chromeTimer);
      e.preventDefault(); // no click, so the toolbar doesn't flicker
      onDouble(t.clientX, t.clientY);
    } else lastTap = { x: t.clientX, y: t.clientY, t: now };
  });
}
watchDoubleTap(els.scroller, (x, y) => {
  if (!state.pdf) return;
  const r = els.scroller.getBoundingClientRect();
  buzz("double");
  zoomAt(state.zoom > 1.08 ? 1 : Math.min(MAX_ZOOM, 2.2), x - r.left, y - r.top);
});
watchDoubleTap(els.textView, () => {
  state.tz = state.tz > 1.2 ? 1 : 1.6;
  els.textView.style.setProperty("--tz", state.tz);
  store("reader.tz", String(state.tz));
  buzz("double");
});

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

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}
function paintTheme(save) {
  const dark = currentTheme() === "dark";
  els.themeBtn.querySelector("use").setAttribute("href", dark ? "#i-sun" : "#i-moon");
  els.themeBtn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  try {
    const bars = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SystemBars;
    // DARK = light icons for a dark screen
    if (bars && bars.setStyle) bars.setStyle({ style: dark ? "DARK" : "LIGHT" }).catch(() => {});
  } catch {
    /* web preview: nothing to do */
  }
  if (save) store("reader.theme", dark ? "dark" : "light");
}
els.themeBtn.addEventListener("click", () => {
  if (Date.now() < themeDragUntil) return;
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  paintTheme(true);
  // pages follow the theme until the person picks Night pages themselves
  if (store("reader.night") === null) state.night = next === "dark";
});
paintTheme(false);

function applyNight(on) {
  state.night = on;
  els.reader.classList.toggle("night", on);
  els.nightBtn.setAttribute("aria-pressed", String(on));
}
{
  const saved = store("reader.night");
  state.night = saved === null ? currentTheme() === "dark" : saved === "1";
  state.tz = clamp(parseFloat(store("reader.tz")) || 1, 0.8, 2.4);
  els.textView.style.setProperty("--tz", state.tz);
}
els.nightBtn.addEventListener("click", () => {
  applyNight(!state.night);
  store("reader.night", state.night ? "1" : "0");
});

/* ------------------------------------------------------------------ *
 *  Text view: the same document as plain, reflowing text
 * ------------------------------------------------------------------ */

function setTextView(on) {
  state.text = on;
  els.reader.classList.toggle("as-text", on);
  els.textView.hidden = !on;
  els.textBtn.setAttribute("aria-pressed", String(on));
}

// pages: one list of paragraphs per page. A paragraph is a string, or { h, t } for a heading.
function renderText(pages, emptyMsg) {
  const frag = document.createDocumentFragment();
  let first = true;
  pages.forEach((paras, i) => {
    if (!paras.length) return;
    if (!first) {
      const d = document.createElement("div");
      d.className = "pg";
      d.textContent = `${i + 1}`;
      frag.append(d);
    }
    first = false;
    for (const t of paras) {
      const heading = typeof t === "object";
      const p = document.createElement(heading ? (t.h === 1 ? "h2" : "h3") : "p");
      p.textContent = heading ? t.t : t;
      frag.append(p);
    }
  });
  if (first) {
    const p = document.createElement("p");
    p.textContent = emptyMsg;
    frag.append(p);
  }
  els.textView.replaceChildren(frag);
}

els.textBtn.addEventListener("click", async () => {
  if (!state.pdf) return;

  if (state.text) {
    setTextView(false);
    els.scroller.scrollTop = state.scrollY;
    setChrome(true);
    return;
  }

  state.scrollY = els.scroller.scrollTop;
  const gen = state.gen;
  if (!state.textPages && state.kind === "pptx") {
    const x = await loadDocs();
    els.textView.replaceChildren();
    x.renderBlocks(state.deckMod.outlineBlocks(state.deck), els.textView);
    state.textPages = [[]];
    state.textFromDeck = true;
  }
  if (!state.textPages) {
    busy("Reading the text…");
    try {
      const x = await loadExport();
      const pages = await x.extractText(state.pdf, () => gen !== state.gen);
      if (gen !== state.gen) return;
      state.textPages = pages;
      renderText(pages, "No selectable text in this PDF. It may be a scan.");
    } catch (err) {
      console.warn("text view failed", err);
      if (gen === state.gen) toast("Couldn't read the text.");
      return;
    } finally {
      if (gen === state.gen) els.loading.hidden = true;
    }
  }
  setTextView(true);
  els.textView.scrollTop = 0;
  setChrome(true);
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
  scrollToAnchor({ idx: n - 1, frac: 0 }, 12);
  updateVisible();
});
function closeSheet() {
  els.sheet.hidden = true;
  els.jumpInput.blur();
}

/* ------------------------------------------------------------------ *
 *  Android back button + files opened from other apps
 * ------------------------------------------------------------------ */

const capApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
if (capApp && capApp.addListener) {
  capApp.addListener("backButton", () => {
    if (scanner && scanner.isOpen()) scanner.back();
    else if (!els.sheet.hidden) closeSheet();
    else if (state.open) goHome();
    else if (state.mode === "pw") answerPassword(null);
    else if (["share", "rename", "confirm", "undo"].includes(state.mode)) setMode(defaultMode());
    else if (state.sel.size) clearSel();
    else if (state.view === "archive") els.bBack.click();
    else capApp.exitApp();
  });

  // app already running when a file is opened with Reader
  capApp.addListener("appUrlOpen", (e) => openFromUrl(e && e.url));
  // app was closed: it was started by the file itself
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
refreshHome()
  .then(async () => {
    // older versions kept up to ten files in Recent: tidy that up once
    state.moved = await autoArchive();
    if (state.moved.length) await refreshHome();
    announceMoved();
  })
  .catch(() => {});
