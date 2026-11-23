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

## Next: 1.5 Scanner (not started)
Goal: scan any paper document with the camera, tidy it, and save it as PDF or Word. Plan:
- Camera: `getUserMedia` inside the WebView (needs `CAMERA` permission in `patch-android.mjs` and `NSCameraUsageDescription` in `patch-ios.mjs`), or `@capacitor/camera`. Prefer one with no network and no extra dependencies.
- Pipeline in a new lazy module `www/scan.js`: capture frame, find the page edges (simple edge/contour detection on a downscaled canvas, let the user drag four corners), perspective-correct onto a canvas, enhance (grayscale/contrast "document" mode, colour mode), multiple pages per scan.
- PDF output: write a small PDF generator (JPEG per page, A4/auto size) so no library is needed. Word output: reuse `export.js` docx builder and embed page images (add image support there), optional OCR is out of scope offline unless a small WASM OCR is added.
- Save into the same library (IndexedDB `meta`/`blobs`) so scans appear on the home screen, kind `pdf` or `docx`.
- Paperwork when camera is added: update `store/DATA_SAFETY.md` (camera used on device only, nothing collected), `PRIVACY.md`, `docs/privacy.html`, `COMPLIANCE.md`, `store/APPLE.md`.
- UI: a scan entry in the home pill ("Scan"), full-screen camera with capture button at the bottom (thumb zone), page strip, crop screen, Save as PDF / Word.
