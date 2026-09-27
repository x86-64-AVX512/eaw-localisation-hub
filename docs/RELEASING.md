# Release process

This checklist is for maintainers publishing EaW Localisation Hub releases.

1. Confirm `VERSION` and the versions in `package.json` agree.
2. Start from a clean checkout.
3. Install exact JavaScript dependencies: `npm ci`.
4. Run `npm run check`. This audits public files, runs tests, builds every Windows artifact and verifies the packages.
5. Review the generated archives and matching `.sha256` files in `dist`.
   Before publication, run `npm run test:update-flow` after `npm run build:installer`. It verifies the actual installer and checksum, tests the updater's elevated, silent launch arguments, and stops a simulated Agent without changing the installed client. After publication, run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-client-updater.ps1 -PublishedRelease` to test GitHub's live asset delivery and SHA-256.
6. Commit the release, create an annotated tag such as `v.0.8.8F5`, and push both commit and tag.
7. Create a GitHub Release and attach the Windows installer and its SHA-256 file. The client, deployer and source archives may also be attached when needed; the auto-updater does not use them.
8. Publish deployment credentials only through private channels. Never add `.env`, authentication state, recovery codes, backups or private server addresses to the repository or release assets.

The Windows client checks this repository's published GitHub Releases at startup and every 15 minutes while Agent UI is running. It accepts the repository's existing `v.X.Y.ZFN` tags (and `X.Y.ZFN` or `vX.Y.Z-beta.N`) only when both `EaW-Localisation-Hub-Setup-X.Y.ZFN.exe` and its `.sha256` asset are uploaded. Drafts and incomplete releases are ignored. Publish the release only after both assets are attached. The updater verifies the installer size, SHA-256 and, when provided by GitHub, the asset digest; it then runs the installer silently over the existing installation and restarts Agent and any previously open Review window. Windows may ask for administrator approval (UAC). The release version must be newer than the installed version; replacing assets of an existing release does not trigger a same-version update.

The updater is included in client packages, so existing installations without it need one manual install of a package containing the updater. Never publish an untrusted installer under this repository's Releases: publication authorizes automatic execution on user machines.

Server deployment is deliberately separate from GitHub publication. A release or tag must not deploy to production automatically.
