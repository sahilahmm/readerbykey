# Reader by Key

A simple PDF reader for Android and iOS. Open a PDF, read it, and it remembers where you stopped.

On your phone the app is called **Reader**. "Reader by Key" is only the project name (this repo, the release page, the APK file).

## Download

Every push to `main` builds the APK and publishes it as a GitHub Release named after the number in `VERSION`:

`https://github.com/sahilahmm/readerbykey/releases/latest/download/Reader-by-Key.apk`

Open that link on your phone, then install the file. Android asks you to allow installs from your browser or file manager the first time (Settings > Install unknown apps).

## What it does

- **One pill, one hand.** The button at the bottom is "Open Document" until you have files, then it splits into **+** and **×**. Select a file and it becomes **Share / Rename / Archive**. Confirmations, "done" messages, Undo and password entry all appear inside the same pill.
- Recent holds five files above the pill: most-read on top, new ones at the bottom, pinned ones (up to 3) closest to your thumb. A sixth file moves the most-read one to the Archive for you, with Undo. The theme button and Archive chip sit just above the list; select a file and the theme button turns into Select all.
- Long-press a file or tap its circle to select it, then slide your finger over more files to select them too.
- **Open Document** takes PDF, Word (.docx) and text (.txt) files. Word and text files open straight into the reflowing text view and remember how far you read.
- **Select several files** (tap the circles, or Select all) to share, archive or remove them together. **Undo** appears after archive, restore, remove and rename.
- **Share** a PDF as PDF or as Word (text only, no pictures or layout). Word and text files are shared as they are.
- **Archive** keeps files without crowding Recent. It scrolls and groups by date or type. Open the Archive chip above the list to find or restore a file.
- **Text view** (the lines icon in the reader) shows the same document as plain text that reflows to your screen. The − and + buttons change the text size there.
- Smooth scrolling, pinch zoom, go to page, night pages, password-protected PDFs (the password is typed into the pill).
- **Word files** keep their look: bold/italic/underline, colours, headings, lists, tables, pictures and links. A PDF shared as Word gets real headings and an A4 page.
- **Dark mode is your choice**: the moon/sun button at the top left. It ignores the phone's setting.
- Appears in Android's **Open with** list for PDF, Word and text files (WhatsApp, Files, browsers).
- Remembers the page and zoom for each file.
- Works fully offline with no internet permission. Your files never leave your phone unless you share them. See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).
- Look: Creamy Latte and Mocha Bean, blue accent in light mode, true black with cream in dark mode.

Text view and sharing a PDF as Word need a PDF with real text. A scanned PDF (photos of pages) has none, and Reader says so.

## How it is built

- `www/` is the whole app: plain HTML, CSS and JavaScript with [PDF.js](https://mozilla.github.io/pdf.js/). `www/export.js` (Word and text) only loads when you use it.
- [Capacitor](https://capacitorjs.com) wraps it as an Android app. Share uses Capacitor's Share and Filesystem plugins.
- `.github/workflows/build-apk.yml` generates the Android project, applies the icon, "Open with" and version, builds, signs, and publishes the release.
- `android/` is generated on every build, so it is not stored in the repo.

### Releasing a new version

1. Edit `www/`, and change the number in `VERSION` (for example `1.3`).
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

Without this, each build is signed with a one-time key and Android will not let a new build replace the old one. You have to uninstall first, which also clears your Recent list.

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

## iPhone and iPad

Every release also gets `Reader-by-Key-unsigned.ipa`, built on a macOS runner from the same web code (Capacitor iOS, bundle id `com.keybysah.reader`, shows as **Reader**). It is **unsigned**, because Apple only allows installing signed apps:

- **Free, on your own iPhone:** sideload it with a tool such as AltStore or Sideloadly and your Apple ID. The certificate lasts 7 days, then you re-sign.
- **Properly:** join the Apple Developer Program (paid), sign it in Xcode, and ship through TestFlight or the App Store. Answers for the forms are in `store/APPLE.md`.

The iOS version number keeps three parts (`1.3.5`) because Apple does not allow a fourth. This build has not been run on a real iPhone yet, so treat it as a first test.

## Google Play and EU

See [COMPLIANCE.md](COMPLIANCE.md) for what is done in code and what only you can do in Play Console, plus ready-to-paste answers in `store/`. With the permanent key set up, each release also carries `Reader-by-Key.aab` (the file Google Play takes) and an SBOM.

## Why Android may say "scan app" when you install

That message comes from Google Play Protect, and Chrome may also warn about downloading an APK. It appears for any app installed from outside a store, and the app itself cannot turn it off. What helps:

1. **Add the permanent key** (above). The publisher shown on the certificate is `Key by Sah`, the same on every release.
2. Releases are release-mode builds, target the current Android version, and ask for no permissions.
3. Check the SHA-256 and attestation on the release page (see SECURITY.md).
4. **Android developer verification.** Google is rolling out a rule that apps on certified phones must come from a registered developer: from September 2026 in Brazil, Indonesia, Singapore and Thailand, and worldwide from 2027. There is a free limited-distribution account for students and hobbyists (no ID document or fee). Register the package name `com.keybysah.reader` together with your signing key at the Android Developer Console once it opens for you; keep the same key forever.
