# Changelog

All notable public changes to EaW Localisation Hub are recorded here. Version names shown in the Windows UI use the `0.8.7F1` form; package metadata uses `0.8.7-alpha.1`.

## 0.8.7F1 – 2026-09-05

- Added modular server-synchronised onboarding and local notification preferences.
- Added immediate discussion notifications plus separate ten-minute digests for suggestion decisions, ticket state, and ticket editing statistics.
- Added Russian/English key auditing, language-scoped batch replacement, and safe inner-quote escaping.
- Review now reports newer releases, wraps every diff, focuses English originals, preserves conflict scrolling, and supports fullscreen Git diff views.
- Closing Agent exits by default; notification-area operation is now an explicit option.
- Git history diff now wraps both panes, while key/line comparison is an aligned Russian/English semantic diff with missing and duplicate keys.
- The tutorial now uses the available Review window and keeps completed segments stable across branch and ticket switches.
- Removed the experimental translator and renamed «Помощь» to «Настройки».
- Localisation audit now has a strict physical-line mode that highlights every misplaced blank line, out-of-order key and standalone comment; inline comment tails remain visible without affecting the diff.
- Batch key replacement now consumes complete legacy values containing unescaped inner quotes instead of leaving duplicated text behind.

## 0.8.6F4 – 2026-09-01

- Added branch-aware collaborative documents for Russian, English and replacement localisation files.
- Isolated each user's working file from changes made by other participants while retaining a shared review document.
- Added Git freshness checks, per-file editing blocks, hot branch switching and conflict inspection.
- Added Git history diff selection between arbitrary commits.
- Added account suspension, invitation management and senior translator administration.
- Added opt-in Notepad++ integration, safer review startup and local reconciliation controls.
- Added a Windows deployment utility and server backup/restore tooling.
- Fixed synchronization races, stale visual conflicts, review navigation and incremental-edit rendering issues.

This is an alpha release. Back up project and server data before upgrades.
