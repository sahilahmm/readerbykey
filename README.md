# Reader by Key

A simple PDF reader for Android. Open a PDF, read it, and it remembers where you stopped.

On your phone the app is called **Reader**. "Reader by Key" is only the project name (this repo, the release page, the APK file).

## Download

Every push to `main` builds the APK and publishes it as a GitHub Release named after the number in `VERSION`:

`https://github.com/sahilahmm/readerbykey/releases/latest/download/Reader-by-Key.apk`

Open that link on your phone, then install the file. Android asks you to allow installs from your browser or file manager the first time (Settings > Install unknown apps).

## What it does

- **One pill, one hand.** The button at the bottom is "Open a PDF" until you have files, then it splits into **+** and **×**. Select a file and it becomes **Share / Rename / Archive**. Confirmations and "done" messages appear inside the same pill.
- Recent files sit right above the pill, newest closest to your thumb. Long-press a file (or tap its circle) to select it.
- **Share** as PDF, or as Word (text only, no pictures or layout).
- **Archive** keeps a file without crowding Recent. Open the Archive chip at the top to find or restore it.
- **Text view** (the lines icon in the reader) shows the same document as plain text that reflows to your screen. The − and + buttons change the text size there.
- Smooth scrolling, pinch zoom, go to page, night pages, password-protected PDFs.
- Appears in Android's **Open with** list for PDFs (WhatsApp, Files, browsers).
- Remembers the page and zoom for each file.
- Works fully offline. Your files never leave your phone unless you share them.
- Look: Creamy Latte and Mocha Bean, blue accent in light mode, true black with cream in dark mode.

Text view and Word sharing need a PDF with real text. A scanned PDF (photos of pages) has none, and Reader says so.

## How it is built

- `www/` is the whole app: plain HTML, CSS and JavaScript with [PDF.js](https://mozilla.github.io/pdf.js/). `www/export.js` (Word and text) only loads when you use it.
- [Capacitor](https://capacitorjs.com) wraps it as an Android app. Share uses Capacitor's Share and Filesystem plugins.
- `.github/workflows/build-apk.yml` generates the Android project, applies the icon, "Open with" and version, builds, signs, and publishes the release.
- `android/` is generated on every build, so it is not stored in the repo.

### Releasing a new version

1. Edit `www/`, and change the number in `VERSION` (for example `1.0.2.6`).
2. Write what changed in `RELEASE_NOTES.md`.
3. Commit and push to `main`. A few minutes later the release `v<VERSION>` is up with the APK.

The Android build number comes from the workflow run number, so it always goes up by itself.

### Try it on a computer first

```bash
npm install
npm run prepare:web
python3 -m http.server -d www
```

Open the address it prints, then pick a PDF with the button.

## Permanent signing (so updates install over the old version)

Without this, builds use a temporary debug key and Android will not let a new build replace the old one. You have to uninstall first, which also clears your Recent list.

One time setup:

1. Create a key (needs Java's `keytool`):
   ```bash
   keytool -genkeypair -alias reader -keyalg RSA -keysize 2048 -validity 36500 \
     -keystore reader-release.jks -storetype PKCS12
   ```
   Use the same password for the keystore and the key. The alias must be `reader`.
2. Convert it to text: `base64 -w0 reader-release.jks` (PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("reader-release.jks"))`).
3. In the repo, open Settings > Secrets and variables > Actions and add:
   - `KEYSTORE_BASE64` (the text from step 2)
   - `KEYSTORE_PASSWORD` (the password you chose)
4. Push any change. From then on every build is signed with your key.

Keep `reader-release.jks` safe and never commit it. If you lose it you cannot update installed copies.

## Names

- Name on the phone: `appName` in `capacitor.config.json` (`Reader`).
- App id: `com.keybysah.reader`. Changing it later makes Android treat it as a different app.
