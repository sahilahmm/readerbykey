# Reader by Key

A simple PDF reader for Android. Open a PDF, read it, and it remembers where you stopped.

On your phone the app is called **Reader**. "Reader by Key" is only the project name (this repo, the download page, the APK file).

## Download

Every push to `main` builds a new APK and publishes it here:

`https://github.com/<your-username>/<this-repo>/releases/latest/download/Reader-by-Key.apk`

Open that link on your phone, then install the file. Android will ask you to allow installs from your browser or file manager the first time (Settings > Install unknown apps).

## What it does

- Open any PDF from your phone, or tap a PDF in WhatsApp, Files or a browser and choose Reader ("Open with")
- Smooth continuous scrolling, pinch to zoom, zoom buttons
- Remembers the page and zoom for each file; the Recent list shows your progress
- Go to page (tap the page number)
- Night pages (moon button) inverts pages for dark rooms; it starts on when your phone is in dark mode
- Password-protected PDFs
- Works fully offline. Your files never leave your phone.
- Same look as the Key site: Creamy Latte and Mocha Bean, with a blue accent in light mode and true black with cream in dark mode

## How it is built

- `www/` is the whole app (plain HTML, CSS and JavaScript, using [PDF.js](https://mozilla.github.io/pdf.js/)).
- [Capacitor](https://capacitorjs.com) wraps it as an Android app.
- `.github/workflows/build-apk.yml` generates the Android project, applies the icon and version, builds, signs, and publishes the APK to a GitHub Release called `latest`.
- `android/` is generated on every build, so it is not stored in the repo.

To change the app, edit files in `www/`, commit, and push. The new APK appears in the release in a few minutes.

### Try it on your computer first

```bash
npm install
npm run prepare:web
npx serve www        # or: python3 -m http.server -d www
```

Open the address it prints. Pick a PDF with the Open button.

## Permanent signing (so updates install over the old version)

Without this, builds use a temporary debug key and Android will not let a new build replace the old one. You would have to uninstall first, which also clears your Recent list.

One time setup:

1. Create a key (needs Java's `keytool`):
   ```bash
   keytool -genkeypair -alias reader -keyalg RSA -keysize 2048 -validity 36500 \
     -keystore reader-release.jks -storetype PKCS12
   ```
   Use the same password for the keystore and the key. The alias must be `reader`.
2. Convert it to text: `base64 -w0 reader-release.jks` (on Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("reader-release.jks"))`).
3. In the repo, open Settings > Secrets and variables > Actions and add two secrets:
   - `KEYSTORE_BASE64` (the text from step 2)
   - `KEYSTORE_PASSWORD` (the password you chose)
4. Push any change. From now on every build is signed with your key.

Keep `reader-release.jks` safe and never commit it. If you lose it you cannot update installed copies.

## App name and id

- Name on the phone: `appName` in `capacitor.config.json` (currently `Reader`).
- App id: `com.keybysah.reader`. Changing it later makes Android treat the app as a different one.
