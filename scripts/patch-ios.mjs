// Run after `npx cap add ios`. Makes the generated iOS project look and behave like Reader:
// name "Reader", Mocha Bean icon and launch screen, opens PDF/Word/text files, Apple's privacy
// manifest, light interface style (the theme is chosen inside the app), and the version number.
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "ios", "App", "App");
const proj = join(root, "ios", "App", "App.xcodeproj", "project.pbxproj");
if (!existsSync(app)) {
  console.error("ios/ not found. Run `npx cap add ios` first.");
  process.exit(1);
}
const must = (c, what) => {
  if (!c) throw new Error(`iOS patch failed: ${what}`);
};

// 1. icon and launch screen art
cpSync(join(root, "resources", "ios", "AppIcon-512@2x.png"), join(app, "Assets.xcassets", "AppIcon.appiconset", "AppIcon-512@2x.png"));
for (const n of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
  cpSync(join(root, "resources", "ios", "splash.png"), join(app, "Assets.xcassets", "Splash.imageset", n));
}

// 2. Info.plist
const plistPath = join(app, "Info.plist");
let plist = readFileSync(plistPath, "utf8");
plist = plist.replace("<string>armv7</string>", "<string>arm64</string>");
const extra = `
	<key>NSCameraUsageDescription</key>
	<string>Reader uses the camera only to scan documents on your device. Photos are never uploaded.</string>
	<key>NSPhotoLibraryUsageDescription</key>
	<string>Reader reads the photos you choose to turn them into a document. Nothing leaves your device.</string>
	<key>UIUserInterfaceStyle</key>
	<string>Light</string>
	<key>ITSAppUsesNonExemptEncryption</key>
	<false/>
	<key>LSSupportsOpeningDocumentsInPlace</key>
	<false/>
	<key>CFBundleDocumentTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeName</key><string>PDF document</string>
			<key>CFBundleTypeRole</key><string>Viewer</string>
			<key>LSHandlerRank</key><string>Alternate</string>
			<key>LSItemContentTypes</key><array><string>com.adobe.pdf</string></array>
		</dict>
		<dict>
			<key>CFBundleTypeName</key><string>Word document</string>
			<key>CFBundleTypeRole</key><string>Viewer</string>
			<key>LSHandlerRank</key><string>Alternate</string>
			<key>LSItemContentTypes</key><array><string>org.openxmlformats.wordprocessingml.document</string></array>
		</dict>
		<dict>
			<key>CFBundleTypeName</key><string>PowerPoint presentation</string>
			<key>CFBundleTypeRole</key><string>Viewer</string>
			<key>LSHandlerRank</key><string>Alternate</string>
			<key>LSItemContentTypes</key><array><string>org.openxmlformats.presentationml.presentation</string><string>org.openxmlformats.presentationml.slideshow</string></array>
		</dict>
		<dict>
			<key>CFBundleTypeName</key><string>Text document</string>
			<key>CFBundleTypeRole</key><string>Viewer</string>
			<key>LSHandlerRank</key><string>Alternate</string>
			<key>LSItemContentTypes</key><array><string>public.plain-text</string></array>
		</dict>
	</array>
`;
must(plist.includes("</dict>\n</plist>"), "Info.plist ending");
plist = plist.replace(/<\/dict>\s*<\/plist>\s*$/, `${extra}</dict>\n</plist>\n`);
writeFileSync(plistPath, plist);

// 3. Apple privacy manifest: no tracking, no data collected
const privacy = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyTracking</key>
	<false/>
	<key>NSPrivacyTrackingDomains</key>
	<array/>
	<key>NSPrivacyCollectedDataTypes</key>
	<array/>
	<key>NSPrivacyAccessedAPITypes</key>
	<array>
		<dict>
			<key>NSPrivacyAccessedAPIType</key>
			<string>NSPrivacyAccessedAPICategoryUserDefaults</string>
			<key>NSPrivacyAccessedAPITypeReasons</key>
			<array><string>CA92.1</string></array>
		</dict>
		<dict>
			<key>NSPrivacyAccessedAPIType</key>
			<string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
			<key>NSPrivacyAccessedAPITypeReasons</key>
			<array><string>C617.1</string></array>
		</dict>
	</array>
</dict>
</plist>
`;
writeFileSync(join(app, "PrivacyInfo.xcprivacy"), privacy);

// 4. project file: add the privacy manifest to the app, set version numbers
let p = readFileSync(proj, "utf8");
const FILE = "7A55AA00000000000000A001";
const BUILD = "7A55AA00000000000000A002";
must(p.includes("504EC3131FED79650016851F /* Info.plist */,"), "Info.plist group entry");
p = p.replace("/* Begin PBXBuildFile section */", `/* Begin PBXBuildFile section */\n\t\t${BUILD} /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = ${FILE} /* PrivacyInfo.xcprivacy */; };`);
p = p.replace("/* Begin PBXFileReference section */", `/* Begin PBXFileReference section */\n\t\t${FILE} /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };`);
p = p.replace("504EC3131FED79650016851F /* Info.plist */,", `504EC3131FED79650016851F /* Info.plist */,\n\t\t\t\t${FILE} /* PrivacyInfo.xcprivacy */,`);
p = p.replace("504EC3121FED79650016851F /* LaunchScreen.storyboard in Resources */,", `504EC3121FED79650016851F /* LaunchScreen.storyboard in Resources */,\n\t\t\t\t${BUILD} /* PrivacyInfo.xcprivacy in Resources */,`);
must(p.includes(`${BUILD} /* PrivacyInfo.xcprivacy in Resources */,`), "resources phase entry");

// App Store versions allow only three numbers (1.3.5), so a fourth (1.3.5.1) is trimmed
const marketing = (process.env.VERSION_NAME || "1.0").split(".").slice(0, 3).join(".");
p = p.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${marketing};`);
p = p.replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${process.env.VERSION_CODE || 1};`);
writeFileSync(proj, p);
console.log(`iOS project patched (version ${marketing}, build ${process.env.VERSION_CODE || 1})`);
