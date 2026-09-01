# Release process

This checklist is for maintainers publishing EaW Localisation Hub releases.

1. Confirm `VERSION` and the versions in `package.json` agree.
2. Start from a clean checkout with submodules: `git submodule update --init --recursive`.
3. Install exact JavaScript dependencies: `npm ci`.
4. Run `npm run check`. This audits public files, runs tests, builds every Windows artifact and verifies the packages.
5. Review the generated archives and matching `.sha256` files in `dist`.
6. Commit the release, create an annotated tag such as `v0.8.6-alpha.4`, and push both commit and tag.
7. Create a GitHub Release and attach the client archive, installer, deployer archive, source archive and all generated SHA-256 files.
8. Publish deployment credentials only through private channels. Never add `.env`, authentication state, recovery codes, backups or private server addresses to the repository or release assets.

Server deployment is deliberately separate from GitHub publication. A release or tag must not deploy to production automatically.
