# Security policy

## Supported version

Only the newest published EaW Localisation Hub prerelease is supported. Older test builds should be upgraded before reporting a problem.

## Reporting a vulnerability

Do not open a public issue for vulnerabilities, leaked credentials, authentication bypasses, unsafe file operations or defects that could expose collaborative documents.

Until GitHub private vulnerability reporting is enabled, contact the repository owner privately through the EaW team communication channel. Include the affected version, reproduction steps, expected impact and any relevant logs with secrets removed. Do not attach server backups, bearer tokens, invitation codes, passwords, SSH keys or unredacted `.env` files.

The project is an alpha and is provided without warranty under GPL-2.0-only. Acknowledgement or a release deadline cannot be guaranteed, but reports should receive an initial response within seven days.

## Deployment baseline

- Terminate TLS before exposing the server to the internet.
- Keep the Hub server bound to loopback behind the reverse proxy.
- Prefer SSH keys for deployment, pin the host fingerprint and disable password login for `root`.
- Store `deploy/.env`, backups and Docker volumes outside Git.
- Rotate any credential that was pasted into an issue, log, chat or build artifact.
