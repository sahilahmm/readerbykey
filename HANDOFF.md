# Reader by Key: handoff notes (for the next Claude)

Read this first. It says what the app is, how it is built and released, what was done in 1.4.5, and what 1.5 should do. Sah (the owner, HSC student in Dhaka) works by sending short feature lists; reply with working, tested, released builds and short plain updates.

## The app in one paragraph
Offline document reader (PDF, Word .docx, PowerPoint .pptx/.ppsx, text). Capacitor 8 wraps a plain ES-module web app in `www/` (no bundler). Phone label "Reader", repo `sahilahmm/readerbykey` (public). Design: creamy latte `#F3E9D7` / mocha `#7A553A`, blue accent in light mode, true black + cream in dark mode. One-hand UI: a morphing bottom pill on the home screen ("dynamic pill action") and a theme button ("dynamic pill necessity").

## Files that matter
- `www/app.js` home screen, reader, zoom, haptics, progress, share. `www/index.html`, `www/style.css`, `www/theme.js`.
- `www/docs.js` Word reader (`readDocx`, `renderBlocks`) plus the zip reader `openZip` / `readXml` reused by pptx.
- `www/pptx.js` PowerPoint reader (lazy-loaded): `readPptx`, `drawSlide`, `fitSlide`, `outlineBlocks`. Pictures load lazily through `deck.image(path)`.
- `www/emf.js` draws EMF pictures to a canvas (`renderEmf`), extracts WMF bitmaps.
- `www/export.js` PDF to Word/text export. `scripts/patch-android.mjs` and `scripts/patch-ios.mjs` patch the generated native projects (Open with filters, permissions, plist). `scripts/prepare-web.mjs` copies PDF.js into `www/lib` (generated, git-ignored).
- `.github/workflows/build-apk.yml`: jobs build (APK+AAB, signed with the permanent keystore secrets), release, ios (unsigned IPA).
- Docs to keep in step with each release: `VERSION`, `RELEASE_NOTES.md` (rewritten each release), `docs/privacy.html` version line, `README.md`, `SECURITY.md`, `store/*.md`.

## How to release
1. Edit code, run `node --check` on changed js, test with Playwright (chrome at `/usr/bin/google-chrome`, viewport 390x800, `python3 -m http.server -d www`, input `#fileInput` via `set_input_files`).
2. Set `VERSION`, rewrite `RELEASE_NOTES.md`, update the privacy-page version.
3. `git commit` (end with the attribution lines the session gives) and `git push origin HEAD:main`.
4. CI builds and publishes tag `v$VERSION`. Poll `gh api repos/sahilahmm/readerbykey/actions/runs?head_sha=<sha>` and `gh api repos/sahilahmm/readerbykey/releases/tags/v<version>`.

## House rules (security)
No `innerHTML` for document content; sanitise links (http/https/mailto/tel only); cap sizes; refuse XML with `<!ENTITY`; no INTERNET permission; no backups. Documents are untrusted input.

## Done in 1.4.5
1. Double-tap zoom: `watchDoubleTap` in `app.js`. Double tap zooms to 2.2x at the tapped spot, again returns to fit width; in Text view it switches text size normal/large. Toolbar toggling on tap is delayed 260 ms so a double tap does not flicker it.
2. Haptics: `@capacitor/haptics`; `buzz(kind)` in `app.js` has a `FEEL` table of multi-pulse patterns per kind (tap, soft, medium, heavy, select, tick, double, ok, warn) with a `navigator.vibrate` fallback; a capture-phase click listener picks the feel by element, page changes tick, double tap and pins use the two-step feel.
3. Toolbar moved to the bottom (`.bar` uses `bottom`), page indicator `.pill` sits above it and drops down when the toolbar hides. Page and text padding adjusted; jump/resume offsets no longer depend on bar height.
4. Word dark mode: `.textdoc.night .textview` now inverts the whole page like PDF night mode (Word files carry their own colours), images and links re-corrected.
5. PowerPoint languages: paragraphs get explicit `dir` (rtl flag from the file), `lang` from run properties, physical l/r alignment (RTL with no alignment sits right), taller line height for Bengali/Arabic/Indic scripts, bullet side follows direction.
6. Lighter app: `quickjs-eval.wasm` and the `*_nowasm_fallback.js` decoders are no longer copied into `www/lib` (scripting is off, WebAssembly is universal): about 1.3 MB less. Removed unused constants.

## Done earlier (1.4 to 1.4.1.5)
PowerPoint viewing (shapes, text, tables, pictures, SmartArt, notes outline), Open with for pptx/ppsx, files with no name are sniffed by content, pictures in layout placeholders, EMF/WMF pictures, lazy picture loading for huge scanned decks.

## Known limits
Charts show as a labelled box; animations/transitions/media not played; old binary `.ppt` unsupported; fonts approximated; iOS builds untested on a real device.

## UI in 1.6
1.6.2: swipe left anywhere on home (`swipeHome`, document-level pointer events, shelf follows the finger; right in the Archive to return), rename = pen on each card (`startRename`, inline field), bin is the `delete` seg in the pill, `#allChip` sits under the list.
Settings menu (`#setBtn`, `#menu`: Vibration `reader.haptics`, Dark mode). Pill: open/add + camera (`#bScan`). Selecting shows `#delChip` (bin) + `#allChip` (Select all/Clear) in the tools row. Archive = swipe the dock left (`swipePill` in app.js; right to return), list slides via `.out-left/.out-right`. CI minifies www js/css with esbuild (`prepare-web.mjs`, only when `CI` is set; do not run it locally with CI=1 without committing first, it rewrites files).

1.7 OCR: `www/ocr.js` (tesseract.js 7, assets copied to `www/lib/ocr` by prepare-web: relaxedsimd+simd lstm cores, eng+ben best_int data, `cacheMethod:"none"`), `readOne()` in scan-ui renders 2600px for reading, searchable PDF = invisible text layer with ToUnicode CMap (`textLayer` in scan.js), Word = `buildDocx` with the paragraphs, `#sOcr` switch (`reader.scanOcr`). Not tested with Bangla scans (no Bengali font here); old WebViews without SIMD cannot run OCR (falls back to picture-only with a message).
1.6.5: hold a thumbnail (450ms) to adjust corners + rotate (`openEdit`, dock mode `scanedit`, overlay `#scanEdit`); drag a thumbnail sideways to reorder (`grab`). Pages keep `src` (JPEG blob) + `corners` and are re-rendered by `render()`.

## Done in 1.5 / 1.5.1: Scanner
- 1.5.1 moved the scanner into the dock pill (no full-screen UI). Tap `#scanChip` -> `scanner.open()` clicks hidden `#scanCapture` (`capture="environment"`) so the phone's native camera app takes the photo. `www/scan-ui.js` `createScanner({..., setMode, defaultMode, say})`: photo -> "Processing…" -> `detectCorners`/`warp`/`enhance` automatically -> thumbnail in `#scanThumbs` (each with remove x, trailing + for another page). Dock modes `scan` (sthumbs, sok, sx) and `scansave` (spdf, sword, sx) in `MODES` in `app.js`; `defaultMode()` returns `scan` while a session is active. Save builds PDF (`makePdf`) or Word (`buildImageDocx`), then `openBlob` with id `scan|<time>`. Max 30 pages. Android back = discard.
- `www/scan.js`: `detectCorners`, `warp`, `rotate`, `enhance` (orig/color/doc/bw, default doc via `reader.scanLook`), `toJpeg`, `makePdf`. No manual corner editing or look chips any more (removed with the old screen); the engine still supports them.
- Word output = page pictures, no OCR. No CAMERA permission on Android (native camera app); iOS has `NSCameraUsageDescription`/`NSPhotoLibraryUsageDescription` in `patch-ios.mjs`.
- 1.5.1.1: `shoot()` in scan-ui.js uses `@capacitor/camera` (`Camera.getPhoto`, source CAMERA, uri) so the native camera opens directly; the hidden file input is only the fallback (browser or plugin error). No CAMERA permission declared (plugin uses the camera intent).
- Not tested on a real phone (Android capture intent / FileProvider, iOS). Ideas: OCR, corner adjust via long-press, look picker, gallery import.

## Added in 1.4.5.1 to 1.4.5.5
- 1.4.5.1 premium haptics (`FEEL` table in `app.js`).
- 1.4.5.5 logo: hand-drawn Barebone mark traced to `logo.svg` (OpenCV contours + Catmull-Rom curves, single path, `currentColor`), inlined in `index.html` as `.logo` inside `#hero`, above `#greeting`.
- 1.4.5.6 reworked the swipe: no Archive chip is shown (`#archiveChip` stays hidden); `#themeBtn` gets class `has-archive` (thin blue line via `::after`) when archived files exist; dragging it right morphs it into the Archive button (`--p` progress, `#themeLabel`), opens at >55% of 150 px. A tap right after a drag is ignored for 450 ms through `themeDragUntil` (an earlier once-only click listener broke the button).
- 1.4.5.5 swipe (superseded): `swipeToArchive()` in `app.js`: pointer-drag on `#themeBtn` (>60 px right = `switchView("archive")`, click after a drag is swallowed); swipe left on `#tools` in the Archive returns to Recent.
- `#scanChip` and `SCAN_READY` (false) in `app.js` are the slot for the 1.5 scanner chip beside Archive. Sah wants Scan first in the empty state, and Scan beside Archive once files exist. Not shipped yet.

- 1.4.5.7: one-time swipe hint (`maybeNudge`, localStorage `reader.swipeHint`), `showHome` no longer resets the view (the Archive survives closing a document), swipe disabled while `state.view === "archive"`, `resetThemeMorph()` runs on every `refreshHome`, and `refreshHome` fades the shelf out before the list empties (`state.homeWasEmpty`) so the logo and greeting arrive smoothly.

## 1.8 scanner/OCR improvements
- `detectCorners` now has a third candidate map (`backdropGap`: colour distance from a plane fitted to the photo border) and scores candidates with `edgeSupport`. Synthetic benchmark (8 scenes): mean corner error 0.196 -> 0.023.
- `ocr.js`: English worker first; reruns with eng+ben when confidence < 72; enlarges small pages (up to 2x) before recognition. Blurry test page: 87.5% -> 93.6% words.
- Release build shrinks with R8 (patch-android step 7).

## 1.8.1
- `lineQuad` (Hough lines -> best page-shaped quad) is a fallback in `detectCorners`; result array carries `.sure`. `scan-ui.js` opens `openEdit` when `!sure`.
- Known limit: busy patterned backgrounds still defeat classical detection. Real fix = small neural corner model (candidates: DocAligner 2.3MB, MakeACopy DocQuadNet Apache-2.0) + onnxruntime-web; check weight licences and app-size cost first.

## 1.9 neural page finder
- `www/dq.js` `findPage(src)`: DocQuadNet (Apache-2.0, from egdels/makeacopy, `vendor/docquad/`) via onnxruntime-web 1.22.0 (wasm, 1 thread). 256px letterbox, RGB/255 NCHW, outputs corner_heatmaps 4x64x64 (argmax) . Tries rotations 0,±25,±45 until confidence >= 0.6. Falls back to `detectCorners`/`lineQuad` in scan.js; `.sure=false` opens the corner editor.
- Files copied by prepare-web.mjs to www/lib/dq (renamed .js/.wasm/.ort so every WebView serves them with a valid type). Not yet verified on a real phone: wasm loading inside Capacitor WebView.
