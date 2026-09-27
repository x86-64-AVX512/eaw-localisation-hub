# Release process

This checklist is for maintainers publishing EaW Localisation Hub releases.

1. Confirm `VERSION` and the versions in `package.json` agree.
2. Start from a clean checkout.
3. Install exact JavaScript dependencies: `npm ci`.
4. Run `npm run check`. This audits public files, runs tests, builds every Windows artifact and verifies the packages.
5. Review the generated archives and matching `.sha256` files in `dist`.
   Before publication, run `npm run test:update-flow` after `npm run build:client`. This isolated test uses the actual client archive to exercise integrity checks, extraction, side-by-side installation and a simulated Agent process switch. It uses a temporary directory and does not change the installed client or user shortcuts. It cannot validate GitHub's live asset delivery or a real Review session; those require a published release.
6. Commit the release, create an annotated tag such as `v.0.8.8F5`, and push both commit and tag.
7. Create a GitHub Release and attach the client archive and its SHA-256 file. The installer, deployer archive and source archive may also be attached when needed; the auto-updater does not use them.
8. Publish deployment credentials only through private channels. Never add `.env`, authentication state, recovery codes, backups or private server addresses to the repository or release assets.

The Windows client checks this repository's published GitHub Releases at startup and every 15 minutes while Agent UI is running. It accepts the repository's existing `v.X.Y.ZFN` tags (and `X.Y.ZFN` or `vX.Y.Z-beta.N`) only when both `EaW-Hub-Client-X.Y.ZFN.zip` and its `.sha256` asset are uploaded. Drafts and incomplete releases are ignored. Publish the release only after all assets are attached. The updater verifies the archive size, SHA-256 and, when provided by GitHub, the asset digest; it then installs the new client in a side-by-side per-user directory and immediately restarts Agent. The previous client directory is retained for recovery.

The updater is included in client packages, so existing installations without it need one manual install of a package containing the updater. Older administrator-installed clients migrate to the per-user installation on their first automatic update; the old Windows uninstall entry remains until removed separately. Never publish an untrusted client archive under this repository's Releases: publication authorizes automatic execution on user machines.

Server deployment is deliberately separate from GitHub publication. A release or tag must not deploy to production automatically.
