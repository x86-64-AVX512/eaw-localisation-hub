# Contributing

EaW Localisation Hub is an early Windows-focused project. Bug reports and narrowly scoped pull requests are welcome.

## Development setup

1. Clone with submodules: `git clone --recurse-submodules <repository-url>`.
2. Install Node.js 22, Notepad++ x64, Visual Studio Build Tools with the C++ workload, PowerShell 5.1+ and Inno Setup 6.
3. Run `npm ci`.
4. Run `npm test` while developing and `npm run check` before submitting a pull request.

Do not commit `dist`, `output`, `.playwright-cli`, `.tools`, `.env`, backups, credentials or generated `apps/agent/review-web` files.

## Pull requests

- Keep unrelated changes separate.
- Add regression tests for bug fixes.
- Update protocol and architecture documentation when behavior or trust boundaries change.
- Preserve user data and avoid migrations that cannot be rolled back.
- Explain any network, filesystem, authentication or deployment impact.
- By contributing, you agree that your contribution is distributed under GPL-2.0-only.

## Commit messages

Use a short imperative summary, for example `Fix branch detection with GitHub Desktop`. Do not include secrets or personal data in commits, fixtures, screenshots or logs.
