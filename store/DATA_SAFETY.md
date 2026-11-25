# Play Console "Data safety" form: answers for Reader by Key 1.3.5

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **No** |
| Is all of the user data collected by your app encrypted in transit? | Not applicable (nothing is collected or transmitted; the app has no internet permission) |
| Do you provide a way for users to request that their data is deleted? | Not applicable (no data leaves the device; users delete it in-app or by uninstalling) |
| Data types (location, personal info, financial, health, messages, photos/videos, audio, files and docs, calendar, contacts, app activity, web history, app info and performance, device or other IDs) | **None collected, none shared** |

Why "files and docs" is not "collected": Google counts data as collected only when it is transmitted off the device. Reader reads the files you pick locally and never sends them anywhere. Sharing happens only when you pick another app in Android's share sheet, which is a user-initiated action and is exempt.

Permissions declared: **CAMERA** only (document scanner; images stay on the device, nothing collected or shared). No internet permission. Sensitive permission declarations (SMS, call log, all-files access, accessibility, VPN, etc.): none needed.
Foreground service, advertising ID, health connect: not used. Advertising ID declaration answer: **No**.
Security practices section: tick "Data is encrypted in transit" only if the form requires an answer; otherwise leave "No data collected". Tick "You can request that data be deleted" is not required.
