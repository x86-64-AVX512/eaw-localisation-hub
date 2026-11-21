# Release process

This checklist is for maintainers publishing EaW Localisation Hub releases.

1. Confirm `VERSION` and the versions in `package.json` agree.
2. Start from a clean checkout.
3. Use an approved patched Node.js runtime (22.23.4+, 24.22.1+ or 26.12.1+ within the corresponding major) and install exact JavaScript dependencies: `npm ci`. Run `node scripts/check-node-runtime.mjs`; client/deployer packaging and installer compilation repeat this check against the actual bundled executable.
4. Run `npm run check`. This audits public files, runs tests, builds every Windows artifact and verifies the packages.
5. Review the generated archives and matching `.sha256` files in `dist`.
   Before publication, run `npm run test:update-flow` after `npm run build:installer`. It verifies the actual installer and checksum, tests the updater's elevated, silent launch arguments, and stops a simulated Agent without changing the installed client. After publication, run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-client-updater.ps1 -PublishedRelease` to test GitHub's live asset delivery and SHA-256.
6. Commit the release, create an annotated tag such as `v.0.8.9F1`, and push both commit and tag.
7. Create a GitHub Release and attach the Windows installer and its SHA-256 file. The client, deployer and source archives may also be attached when needed; the auto-updater does not use them.
8. Publish deployment credentials only through private channels. Never add `.env`, authentication state, recovery codes, backups or private server addresses to the repository or release assets.

The Windows client checks published GitHub Releases at startup and every 15 minutes while Agent settings are open. Download and installation require the «Update client» button and confirmation. The updater selects the highest version with both the installer and its SHA-256 file uploaded. Publish `0.8.9-beta.4` as `v0.8.9-beta.4` with `EaW-Localisation-Hub-Setup-0.8.9-beta.4.exe` and its `.sha256` file. The new updater also recognizes historical F-style tags and assets. Install this release manually on older clients, since their updaters require F-style asset names.

During a manual update, the updater verifies the installer size, SHA-256 and any GitHub asset digest. The update window handles cancellation until installation starts. Windows may ask for administrator approval, then Inno Setup shows installation progress and its own Cancel button. After success, the updater opens Agent settings so the user can start Agent when ready. Updating from an older client still runs the updater packaged with that client.

The updater is included in client packages, so existing installations without it need one manual install of a package containing the updater. Older clients before F7 may still install a new release automatically; publishing F7 cannot change their behaviour before they receive it. Never publish an untrusted installer under this repository's Releases.

Server deployment is deliberately separate from GitHub publication. A release or tag must not deploy to production automatically.

F11 requires an online server build using the patched base and current CA package. The deployer preserves local Compose overrides and allows offline reuse only of an image carrying `org.eawhub.runtime-security=2026-10-21`. Do not remove custom trust mounts until their replacement has been checked. Review `deploy/README.md` before deployment.
