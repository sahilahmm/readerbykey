# Compliance map: Google Play and EU

This is a checklist of what the project does and what still needs you. It is an engineering self-assessment, not legal advice or a certification.

## Google Play: done in the code
| Requirement | Status |
|---|---|
| Target the current Android API (36 required for new apps and updates from 31 Aug 2026) | Done (`targetSdkVersion 36`, set by Capacitor 8) |
| Upload an Android App Bundle (.aab) | Done, built and signed in CI when the permanent key secrets exist |
| Play App Signing, stable upload key | Needs your keystore secrets (README) |
| 64-bit, 16 KB page size | App ships no native libraries (PDF.js is JavaScript and WebAssembly), so nothing to rebuild |
| No unneeded permissions | None declared, internet removed |
| User Data policy: privacy policy URL | `docs/privacy.html`, needs GitHub Pages turned on |
| Data safety form | Answers in `store/DATA_SAFETY.md` |
| Content rating, target audience, ads declaration | Answers in `store/LISTING.md` |
| Exported components, cleartext off, backups off, not debuggable | Done (`SECURITY.md`) |
| Open-source licence notices | Shipped in the app as `licenses.txt` |
| Accessibility basics (labels, 48 dp touch targets, focus ring, reduced motion, text scaling) | Done |

## Google Play: only you can do these (Play Console)
1. Create a developer account (one-time fee, identity verification, the holder must be an adult). Accounts created after 13 Nov 2023 as *personal* must also run a **closed test with at least 12 testers opted in for 14 continuous days** before Production is unlocked. Organisation accounts skip this.
2. Turn on GitHub Pages (Settings > Pages > main > /docs) so the privacy policy URL works.
3. Add the keystore secrets, push, download `Reader-by-Key.aab` from the release, and upload it (enrol in Play App Signing).
4. Fill in Data safety, content rating, target audience, ads, app access, trader status and the store listing from `store/`.
5. Android developer verification also applies to apps distributed outside Play on certified devices (starting Sept 2026 in Brazil, Indonesia, Singapore and Thailand, global from 2027). Registering the package `com.keybysah.reader` with your key covers both.

## EU
| Rule | What it means here | Status |
|---|---|---|
| **GDPR / ePrivacy** | No personal data is collected, no cookies or device access for tracking, no internet permission | Privacy policy states it; no consent banner needed because nothing is collected |
| **Cyber Resilience Act** (reporting duties live since 11 Sep 2026; main duties 11 Dec 2027) | If Reader counts as a product placed on the EU market in a commercial activity, the maker must handle vulnerabilities, report actively exploited ones within 24h/72h/14 days via the ENISA single reporting platform, keep security updates, and keep technical documentation. A free hobby app with no commercial activity is generally outside scope, but Reader is built as if it were in scope | Done: vulnerability disclosure policy (`SECURITY.md`, `security.txt`), SBOM published with every release, signed and attested builds, dependency audit and Dependabot, no known-vulnerable components shipped, secure defaults (no network, no backups, least privilege), security updates through new releases |
| **Digital Services Act** (trader status on Play) | See `store/LISTING.md` | Your declaration |
| **European Accessibility Act** (since 28 Jun 2025) | Covers certain consumer products and services; microenterprises providing services are exempt. Reader follows the same practical rules anyway: names/roles for every control, sufficient contrast, 48 dp targets, reflowing text that follows system font size, reduced-motion support, no time limits | Done; test with TalkBack on your phone |
| **Consumer rules (honest information)** | No ads, no dark patterns, no paid features | Nothing to do |
| **Open-source licences** | Apache-2.0 (PDF.js) and MIT (Capacitor) notices ship in the app | Done |

## Security support commitment
Security fixes are shipped as new releases on the GitHub Releases page. Critical issues are fixed as fast as one person can. Installed copies do not update by themselves outside Google Play, so users should check the releases page.

## Apple App Store (iOS build)
| Requirement | Status |
|---|---|
| Privacy manifest (`PrivacyInfo.xcprivacy`) | Done: no tracking, no collected data, required-reason APIs declared |
| App Privacy label | "Data Not Collected" (see `store/APPLE.md`) |
| Export compliance | `ITSAppUsesNonExemptEncryption` = false |
| App Transport Security | Default strict (no exceptions) and the app has no network code |
| Document types | PDF, Word, text registered as Viewer |
| Minimum iOS | 15 |
| Signing, TestFlight, App Store review | Only you can do this: paid Apple Developer account, then sign and upload from a Mac |
