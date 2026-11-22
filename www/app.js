import * as pdfjsLib from "./lib/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./lib/pdf.worker.min.mjs", import.meta.url).href;

/* ------------------------------------------------------------------ *
 *  Setup
 * ------------------------------------------------------------------ */

const MAX_RECENT = 10;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 4;
const MAX_PIXELS = 14_000_000; // cap per-page canvas size to protect memory
const PDF_OPTIONS = {
  standardFontDataUrl: new URL("./lib/standard_fonts/", import.meta.url).href,
  iccUrl: new URL("./lib/iccs/", import.meta.url).href,
  wasmUrl: new URL("./lib/wasm/", import.meta.url).href,
};

const DOC_EXT = /\.(pdf|docx|txt)$/i;
const EXT = { pdf: ".pdf", docx: ".docx", txt: ".txt" };
const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
};
const KIND_LABEL = { docx: "Word", txt: "Text" };

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries(
  [
    "home", "reader", "list", "empty", "greeting", "archiveChip", "allChip", "dock", "fileInput",
    "bOpen", "bAdd", "bRemove", "bShare", "bRename", "bArchive", "bDelete", "archiveLabel",
    "bPdf", "bWord", "bYes", "bNo", "bBack", "renameInput", "dockMsg",
    "bar", "title", "backBtn", "textBtn", "nightBtn", "zoomIn", "zoomOut",
    "scroller", "pages", "textView", "pill", "sheet", "jumpForm", "jumpInput",
    "loading", "toast", "toastMsg", "toastUndo",
  ].map((id) => [id, $(id)])
);

const state = {
  // home
  all: [], // every saved file's meta
  live: [], // not archived, newest first
  shown: [], // what the list on screen holds
  view: "recent", // "recent" | "archive"
  sel: new Set(), // selected file ids
  mode: "open", // dock mode
  pending: null, // what the confirm button will do
  gcat: "", // greeting category
  undo: null, // what the toast's Undo button will do
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

// keep the newest MAX_RECENT files; archived files are never trimmed
async function trimRecent() {
  const live = (await getAllMeta()).filter((m) => !m.archived).sort((a, b) => b.openedAt - a.openedAt);
  for (const old of live.slice(MAX_RECENT)) await deleteBoth(old.id);
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

// A toast with an Undo button (when `undo` is given) stays a little longer.
let toastTimer = 0;
function hideToast() {
  clearTimeout(toastTimer);
  els.toast.hidden = true;
  state.undo = null; // lets go of anything the undo was holding on to
}
function toast(msg, undo) {
  els.toastMsg.textContent = msg;
  els.toastUndo.hidden = !undo;
  state.undo = undo || null;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undo ? 6000 : 2800);
}
els.toastUndo.addEventListener("click", async () => {
  const fn = state.undo;
  hideToast();
  if (!fn) return;
  try {
    await fn();
  } catch (err) {
    console.warn("undo failed", err);
    toast("Couldn't undo that");
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
  msg: ["msg"], //                            a short status, then back to normal
  archive: ["back"],
};

let flashTimer = 0;

function setMode(name) {
  clearTimeout(flashTimer);
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

const GREETINGS = {
  empty: ["Your reading, right here.", "Your reading, your pace."],
  recent: ["Back to your page?", "Your next page awaits.", "Pick up where you left off.", "Your reading, your pace."],
  archive: ["Saved for later.", "Your quiet shelf."],
};

function setGreeting(force) {
  const cat = state.view === "archive" ? "archive" : state.live.length ? "recent" : "empty";
  if (!force && cat === state.gcat) return;
  state.gcat = cat;
  els.greeting.textContent = pick(GREETINGS[cat]);
  els.greeting.style.animation = "none";
  void els.greeting.offsetWidth;
  els.greeting.style.animation = "";
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
  if (kind === "pdf") {
    if (m.total) {
      progress = Math.round(((m.page || 1) / m.total) * 100);
      line = `Page ${m.page || 1} of ${m.total} · ${line}`;
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

  li.append(main, dot);
  return li;
}

async function refreshHome(settle = true) {
  let all = [];
  try {
    all = (await getAllMeta()).sort((a, b) => b.openedAt - a.openedAt);
  } catch {
    /* storage unavailable: behave as empty */
  }
  state.all = all;
  state.live = all.filter((m) => !m.archived);
  const archived = all.filter((m) => m.archived);
  if (state.view === "archive" && !archived.length) state.view = "recent";

  const shown = state.view === "archive" ? archived : state.live;
  state.shown = shown;
  for (const id of [...state.sel]) if (!shown.some((m) => m.id === id)) state.sel.delete(id);

  els.list.replaceChildren(...shown.map(cardFor));
  markSel();

  els.empty.hidden = shown.length > 0;
  els.archiveChip.hidden = state.view === "archive" || !archived.length;
  els.archiveChip.textContent = `Archive · ${archived.length}`;

  setGreeting(false);
  if (settle) setMode(defaultMode());
}

function markSel() {
  for (const li of els.list.children) li.classList.toggle("sel", state.sel.has(li.dataset.id));
  const ms = selMetas();
  els.archiveLabel.textContent = ms.length && ms.every((m) => m.archived) ? "Restore" : "Archive";

  // "Select all" shows up once you are selecting and there is more than one file
  const n = state.sel.size;
  els.allChip.hidden = !(n > 0 && state.shown.length > 1);
  els.allChip.textContent = n >= state.shown.length ? "Clear" : "Select all";
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

function showHome() {
  els.reader.hidden = true;
  els.home.hidden = false;
  state.sel.clear();
  state.view = "recent";
  refreshHome().then(() => setGreeting(true));
}

/* --- tapping, selecting, long-press --- */

let press = null;
els.list.addEventListener("pointerdown", (e) => {
  const card = e.target.closest(".card");
  press = null;
  if (!card || e.target.closest(".dot")) return;
  press = { x: e.clientX, y: e.clientY, fired: false };
  press.timer = setTimeout(() => {
    press.fired = true;
    if (navigator.vibrate) navigator.vibrate(12);
    toggleSelect(card.dataset.id, true);
  }, 450);
});
const cancelPress = () => press && clearTimeout(press.timer);
els.list.addEventListener("pointermove", (e) => {
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
});
els.list.addEventListener("pointerup", cancelPress);
els.list.addEventListener("pointercancel", cancelPress);
els.list.addEventListener("contextmenu", (e) => e.preventDefault());

els.list.addEventListener("click", (e) => {
  if (press && press.fired) {
    press = null; // this click is just the end of a long-press
    return;
  }
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
  const last = state.live[0];
  if (!last) return;
  state.pending = { type: "remove", ids: [last.id] };
  els.dockMsg.textContent = `Remove “${stripExt(last.name)}”?`;
  setMode("confirm");
});

els.bDelete.addEventListener("click", () => {
  const ids = [...state.sel];
  if (!ids.length) return;
  state.pending = { type: "remove", ids };
  els.dockMsg.textContent = ids.length > 1 ? `Remove ${ids.length} files?` : "Remove this file?";
  setMode("confirm");
});

els.bNo.addEventListener("click", () => setMode(defaultMode()));

els.bYes.addEventListener("click", async () => {
  if (state.mode === "rename") return commitRename();
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
  for (const m of ms) await putMeta({ ...m, archived: archiving });
  state.sel.clear();
  await refreshHome();
  const word = archiving ? "Archived" : "Restored";
  toast(ms.length > 1 ? `${word} ${ms.length} files` : word, async () => {
    for (const m of ms) {
      const cur = state.all.find((x) => x.id === m.id);
      if (cur) await putMeta({ ...cur, archived: !archiving });
    }
    await refreshHome();
  });
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
        items.push({ blob: x.buildDocx(pages), filename: `${base}.docx`, mime: x.DOCX_MIME });
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

els.archiveChip.addEventListener("click", () => {
  state.view = "archive";
  state.sel.clear();
  refreshHome();
});
els.bBack.addEventListener("click", () => {
  state.view = "recent";
  state.sel.clear();
  refreshHome();
});

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
    toast("Couldn't open that file. Try opening it again.");
    refreshHome();
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
  if (head[0] === 0x50 && head[1] === 0x4b) return "docx"; // a zip; the Word reader checks it
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
    const ok = kind === "pdf" ? await showPdf(gen, id, name, blob, meta) : await showTextDoc(gen, kind, id, name, blob, meta);
    if (!ok || gen !== state.gen) return;

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
      if (err && err.name === "PasswordException") return; // they cancelled the password box
      toast(err && err.name === "Unsupported" ? "Reader opens PDF, Word (.docx) and text files." : "Couldn't open this file.");
    }
  } finally {
    els.loading.hidden = true;
  }
}

async function showPdf(gen, id, name, blob, meta) {
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
  else scrollToAnchor(start, els.bar.offsetHeight + 4);
  setChrome(true);
  updateVisible();
  loadSizes(gen);
  return true;
}

// Word and text files open straight into the reflowing text view.
async function showTextDoc(gen, kind, id, name, blob, meta) {
  const x = await loadDocs();
  const paras = kind === "docx" ? await x.readDocx(blob) : await x.readText(blob);
  if (gen !== state.gen) return false;

  state.open = true;
  state.kind = kind;
  state.id = id;
  state.meta = { ...meta, id, name, kind, total: 0, openedAt: Date.now() };
  state.textPages = [paras];
  renderText(state.textPages, kind === "docx" ? "This Word document has no text." : "This file is empty.");
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
  state.pages = [];
  state.id = null;
  state.open = false;
  state.kind = null;
  state.textPages = null;
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
    if (state.open && state.kind !== "pdf") {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveProgress(false), 500);
    }
  },
  { passive: true }
);

function saveProgress(now) {
  if (!state.open || !state.meta) return;
  if (state.kind === "pdf") {
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
function tapToggleChrome() {
  if (window.getSelection && String(window.getSelection())) return;
  setChrome(state.chromeHidden);
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
  scrollToAnchor({ idx: n - 1, frac: 0 }, state.chromeHidden ? 12 : els.bar.offsetHeight + 8);
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
    if (!els.sheet.hidden) closeSheet();
    else if (state.open) goHome();
    else if (["share", "rename", "confirm"].includes(state.mode)) setMode(defaultMode());
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
refreshHome();
