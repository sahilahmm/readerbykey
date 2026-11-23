# Security

Reader works fully offline and keeps your documents on your phone. This page lists what the app does to stay that way, and what it cannot do.

## What the app does

- **No internet permission.** The app asks for no permissions at all, so it cannot send anything anywhere. (`INTERNET` is removed from the manifest, even if a library tries to add it back.)
- **No cleartext traffic, no mixed content, no web debugging, no logging** from the Capacitor layer.
- **Content Security Policy.** The page may only load its own files; no remote scripts, frames, plugins or form posts.
- **No backups.** Android cloud backup and device-to-device transfer are switched off for the app, so your documents and reading history are not copied off the phone by Android.
- **Narrow sharing.** The share folder is the only place the app can hand out files from (`cache/shared/`), and it is emptied before every share.
- **Untrusted files stay untrusted.**
  - PDFs: PDF.js with scripting and `eval` off.
  - Word files: read with a small built-in reader. It never uses `innerHTML`, refuses XML with entity declarations, caps the size of each unpacked part and of all pictures, skips macros, embedded objects and external pictures, and only turns `http(s)`, `mailto` and `tel` links into tappable links (opened with `noopener noreferrer`).
  - Files larger than 250 MB are refused.
- **Open with** only accepts `content://` and `file://` documents, and checks the bytes to decide what a file really is.
- **Not debuggable.** Releases are built in release mode and signed.
- **Supply chain.** CI installs dependencies with `npm ci --ignore-scripts`, audits them, uses the least permissions per job (only the release job can write), publishes a SHA-256 checksum, and a GitHub build attestation proving the APK came from this repository. Dependabot watches npm packages and GitHub Actions.

## Verify a download

```bash
sha256sum -c Reader-by-Key.apk.sha256
gh attestation verify Reader-by-Key.apk --repo sahilahmm/readerbykey
```

The release notes also list the SHA-256 of the signing certificate. It must stay the same from release to release once you set up the permanent key (see README).

## What it cannot do

- **Android may still say "scan app" or "unknown app" for sideloaded APKs.** That is Google Play Protect and the browser's download warning. They depend on where the file comes from and on Google's reputation data, not on anything inside the APK. What reduces it: a permanent signing key (same publisher every release), a current target SDK, zero permissions, and eventually Android developer verification or a store listing. It cannot be switched off from inside the app.
- **Documents are stored unencrypted** in the app's private storage. Other apps cannot read them without root, but anyone who unlocks your phone can open Reader. Use your phone's lock screen.
- Reader is not a malware scanner. It will not run a document's macros or scripts, but a booby-trapped document you share onward is still booby-trapped.

## Vulnerability handling (EU Cyber Resilience Act)

- Report privately: https://github.com/sahilahmm/readerbykey/security/advisories/new (also in `security.txt`). Please give me a reasonable time to fix before telling anyone.
- I aim to acknowledge within 5 days and ship a fix as a new release; the advisory then explains what was fixed.
- A software bill of materials (CycloneDX) is attached to every release so you can see exactly which libraries are inside.
- If a vulnerability in Reader is actively exploited, it is reported to the authorities as the Cyber Resilience Act requires (24 hours early warning, 72 hours notification, final report after the fix).
- Supported version: the latest release only.

## Reporting a problem

Open a private security advisory on this repository (Security tab > Report a vulnerability), or open an issue if it is not sensitive.

## PowerPoint files (1.4)

`.pptx`/`.ppsx` files are untrusted input. They are read by `www/pptx.js` with the same zip limits as Word files, XML containing `<!ENTITY` is refused, slides (1000), shapes (2500 per slide), pictures (300, 80 MB) are capped, and every shape is read inside a try/catch so one bad shape cannot stop the deck. Slides are built with DOM calls only (never `innerHTML`); colours are validated, only png/jpg/gif/webp/bmp/svg pictures are shown (as `<img>`, so SVG cannot run script), and links are limited to http(s), mailto and tel. Nothing in a presentation is ever fetched from the network.
