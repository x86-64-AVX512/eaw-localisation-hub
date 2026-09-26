# Changelog

All notable public changes to EaW Localisation Hub are recorded here. Version names shown in the Windows UI use the `0.8.8F4` form; package metadata uses `0.8.8-beta.4`.

## 0.8.8F4

- The shared runtime package and Review UI are migrated to TypeScript. Security, Git, document-delivery and socket boundaries in Agent and Server use strict TypeScript contracts; the remaining large JavaScript coordinators are covered by `checkJs` to avoid a mechanical rewrite of stable code. The regular `typecheck` command runs both checks.
- Document synchronisation no longer accepts an acknowledgement without a pending flush, and the server rejects malformed JSON control messages before dispatching them to a room.
- Verified branch merges into `general-dev` transfer comment threads, retarget tickets while retaining their original comparison commit, and remove the old branch rooms only after the target comments are persisted. Missing files, unmerged personal/shared text, or legacy documents that cannot be identified stop the cleanup. Deleting a Git branch without a verified merge leaves its server data intact and pauses editing.
- Review has a read-only «Удалённые ветки» archive for saved server documents, comments and suggestions. Legacy rooms whose paths were not indexed can be opened by entering their known localisation path; opening the archive never creates a room or restores the Git branch.
- The approved `barrad` branch reads its canonical localisation and verifies ticket base commits from `MiszczTheMaste/equestria_dev`; all other branches continue using the official EaW repository.

## 0.8.8F3 – 2026-09-22

- Agent verifies the Git blob asynchronously before replacing a tracked file, so a save no longer blocks its event loop while retaining the freshness and disk-identity checks.
- Review batches card layout into one animation frame, measures card heights before applying positions and retains card nodes when only their text anchors move, avoiding repeated forced layouts and visual remounts.
- Author previews retain their cache across unchanged shared/Git bases, suppress duplicate requests and discard replies from an older base.
- Bulk localisation-key insertion uses linear-time anchor resolution instead of repeatedly scanning the growing document. Superseded personal projections no longer calculate an unused local-selection diff.
- Review keeps up to three completed Git comparisons as ready-to-display Monaco diff views. Switching back to one does not fetch, rewrite models, or recompute highlights; duplicate in-flight requests are suppressed. A new comparison still requires computation, now bounded to avoid multi-second CPU stalls, and remains behind a loading overlay until its highlights are ready. The closed editor keeps its geometry offscreen without automatic relayout, so repeated opens and closes do not trigger a costly render, and long lines wrap on both sides. A changed HEAD or file reloads the history from a pinned commit snapshot, while the Agent-side disk cache continues to serve text for other comparisons.

## 0.8.8F2 – 2026-09-21

- Large Review edits no longer allocate complete per-character copies merely to find one replacement. Suggestion provenance uses bounded typed-array history, and Monaco's exact edit ranges bypass the fallback whole-document comparison.
- Agent indexes UTF-8 positions once per document snapshot, skips unchanged one-second disk reads and duplicate merge-base writes, and retries a failed base write safely.
- Personal projections advance through revisioned byte patches. A response invalidated by newer typing becomes the base for the next request instead of being discarded, preventing continuous edits from starving local-file synchronisation.
- Server history is bounded in one serialization pass and releases decompressed old snapshots after persistence. Audit journal writes are coalesced, and per-client projection caches are bounded.
- Review snapshots are rebuilt only when their revision or anchored positions change; reservation snapshots receive the same deduplication. Personal-file patches sent to Review carry base and result hashes and recover with a full snapshot after any mismatch.
- Common edits confined to one localisation line bypass the full history parser while structural changes and duplicate keys retain the conservative parser path. Localisation-key index output is sorted so filesystem enumeration order cannot cause false changes.

## 0.8.8F1 – 2026-09-21

- Review caches UTF-8/UTF-16 position checkpoints, and Agent converts large-file cursor positions without per-character allocations. Presence and reservation-target snapshots update only the affected collaboration sections instead of rebuilding the complete panel for every participant message.
- Personal projections are coalesced during typing with a two-second maximum delay. Agent reuses an unchanged Git HEAD file and sends small personal-version edits after the first full snapshot instead of repeatedly transferring three complete texts; the closed local-file dialog is populated only when opened.
- Server history compression runs off the main event loop while preserving the captured revision and durable flush order. Agent polls Git asynchronously at a lower fallback rate.
- The localisation key-index worker reuses unchanged files and the Review endpoint answers unchanged index requests without retransmitting the full key list. Reading an unchanged personal projection no longer schedules a redundant server persistence write.

## 0.8.7F13 – 2026-09-21

- Review no longer draws yellow ambiguous-Unicode boxes around Cyrillic letters following Paradox colour codes. The change covers the main editor and diff views; invisible-character warnings remain enabled.

## 0.8.7F12 – 2026-09-19

- Review checks localisation syntax while editing, marking unclosed quotes, unknown escape sequences, missing value quotes, duplicate keys and malformed `$...$`, `§...`, `£...` and `[...]` markup directly in Monaco. A Problems list navigates to each issue and the first duplicate. Checking stays local in a worker; unchanged markers remain visible while new results are calculated.
- The linter requires a language header matching the opened file and tokenises references, variable expressions, dynamic loc and both valid icon forms independently, so one broken token no longer hides a neighbouring error. Common HOI4 formatter and array/scope forms are covered without treating colour switches or an empty `$VALUE|$` formatter as errors.
- Desktop Agent supplies a read-only index of localisation keys from the local repository. Review uses it for conservative unresolved `$KEY$` hints, including keys in other files; the file text is not sent to a remote validator. Runtime and vanilla references without a matching local namespace are intentionally not flagged.

## 0.8.7F11 – 2026-09-19

- Review autosave checks the exact disk base before replacing a file, so a concurrent external edit is reconciled instead of erased.
- Closing the last document waits for server persistence; edits not confirmed as delivered remain in a local Yjs recovery update for the next connection.
- Personal projections no longer remain uninitialised when edits arrive during every request. External merge completion now forwards its notice correctly.
- Protocol 19 adds an explicit durable document flush acknowledgement and requires the server and Desktop Agent to be upgraded together.

## 0.8.7F10 – 2026-09-14

- The server builds its large supplemental Russian dictionary in an isolated worker, so a cold dictionary request can no longer block authentication or collaborative document WebSockets.
- Review waits for `documentReady` before loading spellchecking assets, keeping document startup ahead of optional editor assistance.
- Spelling markers remain visible while an updated viewport result is being calculated, eliminating flashes during typing and scrolling. Hovering a marked word opens nothing; its right-click menu offers direct shared-dictionary insertion and the explicit quick-fix panel.

## 0.8.7F9 – 2026-09-13

- Versionless Paradox localisation keys now work consistently in batch replacement, English-original lookup, scroll synchronisation, editor highlighting and Git ticket summaries. Regression tests cover both `key:0 "value"` and `key: "value"` forms.
- Reservation updates use keyed atomic snapshots, preserving existing UI nodes and scroll position instead of flashing on every document edit. The reservation list expands to the window boundary before scrolling.
- Review cards are anchored beside their source text with collision handling and connecting guides. Editor settings add dark, light and high-contrast themes plus font family, size and line-height controls.
- Russian spellchecking runs locally in a background worker over only the visible text. The server distributes the LibreOffice dictionary plus a compact index of over two million additional Russian word forms and surnames, and every authenticated participant can extend one shared team dictionary. Files and fragments are never sent for checking, and replacements remain explicit user actions.
- Persistent file tabs, repository localisation search, cursor/scroll restoration and a unified Review launcher reduce repeated navigation. The launcher starts Agent when needed and restores the most recently reviewed document.

## 0.8.7F8 – 2026-09-12

- Git refreshes and history restores preserve comment and suggestion locations using bounded key-and-context fallback anchors. Unrecoverable discussions are reported as orphaned instead of silently moving to the beginning of the file.
- Ticket apply and rebase operations lock every participating room and recheck revisions immediately before replacement. Rebase verifies the requested Git commit before changing ticket documents, and queued CRDT updates repeat their write-authorisation check before application.
- Deleted ticket rooms cannot be recreated by an already queued persistence write. Late disk reads from detached Review bindings are ignored, and localisation audit cache keys and results are now computed from the same immutable pair of file snapshots.

## 0.8.7F7 – 2026-09-11

- Desktop Agent now keeps a bounded, compressed local cache for immutable Hub history versions, Git history comparisons, ticket file diffs, and localisation audits. Cache keys include the source revision or content fingerprint, so changed inputs cannot reuse stale comparisons.
- Review settings show the cache entry count and disk usage and can clear the cache immediately. Cached data remains local, contains no credentials, is capped at 256 MiB and can always be recreated from its original sources.

## 0.8.7F6 – 2026-09-10

- Per-key local-file glyphs are anchored to the first visual row of each real Monaco model line, so wrapping a long localisation value no longer repeats the checkbox on every display row.
- Personal-variant conflicts are returned only to authors who participate in them. Unrelated users no longer see other contributors' collisions presented as conflicts with their own working file.
- Batch key replacement escapes only ASCII double quotes used by Paradox localisation syntax; Russian guillemets such as `«текст»` are preserved verbatim.
- Git refreshes and history restores re-anchor every reservation to its saved localisation keys after replacing the CRDT text. Existing collapsed reservations are repaired when their room is loaded; reservations whose keys were actually removed are reported as orphaned instead of as empty ranges at the start of the file.
- Accepted-suggestion history now records and displays the proposal creator separately from the person who accepted it. Personal-file ownership follows the accepter; legacy entries are reconciled with retained suggestion decisions where possible and no longer attribute accepted shared text to the proposal creator.

## 0.8.7F5 – 2026-09-10

- Review now exposes one local-file checkbox per localisation key that differs from Git HEAD. Each shared modification, addition, or deletion can be included or returned to Git independently; the dialog shows exact before/after lines, gutter markers allow direct toggling, and a persistent banner warns whenever selected shared changes are present in the working file.
- The Notepad++ plugin now exposes only `Open current file in Review`; its editor synchronisation, panel, overlays and collaboration commands are permanently disabled with no configuration switch. The corresponding mandatory training segment was raised to revision 2 so existing users see the change.
- Canonical Git refresh now recognises both `key:0 "Value"` and `key: "Value"` localisation entries, so versionless keys produce precise per-key merges and conflicts instead of blocking the whole shared document as a structure conflict.
- Opening a persisted room now refreshes canonical Git before the initial client sync and includes any pending per-key conflicts immediately, instead of showing a stale file-outdated block with an empty conflict list until the periodic refresh.
- Content-changing Review actions automatically select the "Git + my changes" working-file mode, so their personal projection is materialised without another manual choice.
- Discarding a complete working-file change back to Git HEAD, including immediately after a Review save, now resets only that user's local projection; the shared document and other contributors remain untouched.

## 0.8.7F4 – 2026-09-09

- Opening an existing file no longer folds other contributors' shared edits into the local user's personal Git file. Disk reconciliation now keeps separate shared and personal merge results, including for external file edits and conflict resolution.
- Reservations now recognise localisation entries written both as `key:0 "Value"` and as `key: "Value"`, while continuing to ignore language headers and blank values.
- Review waits for the initial personal merge base before initialising any document, preventing startup edits from racing personal materialisation.
- Deleting a ticket closes its catalog view immediately, so rendering a large, soon-to-be-removed document list no longer stalls the interface.
- WebSocket document messages are processed in arrival order, and graceful shutdown waits for queued messages before flushing rooms.
- Integration suites run serially to avoid shared-server and persistence races in CI.
- Protocol 18 requires updating the server and Desktop Agent together.

## 0.8.7F3 – 2026-09-07

- Mandatory training opens only after a full authenticated server response has explicitly returned the account's progress and confirmed that a current segment is incomplete. Initial Agent greetings and compact WebSocket room identities no longer treat missing progress as an empty account.
- Open Review windows recover after Agent restarts. Activation is preserved even when cursor anchors refer to a document that the new Agent has not synchronised yet.
- Ticket catalog changes reach other connected users immediately. Revision checks, catalog opening and reconnects recover missed changes while preserving unsaved metadata fields.
- Added independent, durable server audit records for ticket operations, discussions, suggestions, reservations, document edits and account management. Deletions record the attempt before mutation and the final result afterwards.
- Audit records use authenticated account identities, survive object deletion, and are included in server backups. EaW Hub Admin provides filtering and pagination; Team Management has no audit UI or endpoint, and senior translators cannot read audit records. No deleted-object restoration was added.
- Daily backup scheduling converts the selected time to the DateTime required by Windows Task Scheduler. The schedule runs at local 03:00 under the logged-in user and catches up when available.
- Replaced browser confirmation boxes in Review with compact confirmations beside the triggering action, including keyboard cancellation and protection against stale targets.
- Windows CI now compares canonical paths safely when simulating atomic replacement failures, and an invalidated in-flight personal-file write is scheduled again instead of being lost.

## 0.8.7F2 – 2026-09-06

- Review now exchanges Yjs updates directly with Agent. In-flight typing, multi-cursor edits, reconnect replay and anchored selections no longer depend on stale byte offsets or debounced text snapshots.
- Personal variants retain their Git base and rebase onto new HEAD versions. Incorporated edits are retired; unresolved personal Git conflicts stop file writes and offer an explicit choice in Review.
- History schema 4 persists the rebase base and pending conflicts. Older variants without provable Git ancestry remain available for inspection and require confirmation before materialisation.
- Personal projection requests recover after disconnects and timeouts, ignore stale replies, and preserve valid empty documents without falling back to another user's shared text.
- Personal variants and three-way merges preserve blank-line positions, comment anchors, key order and final-line structure.
- Ticket editing events are immutable and have distinct cursors, so ten-minute notification digests receive every increment.
- Local files are written to a synced sibling temporary file and atomically replaced, with identity, Git freshness and save-generation checks before replacement. Failures leave the original intact.
- Protocol 16 requires updating both the server and Desktop Agent. Review and Agent are distributed together; legacy snapshot IPC remains available to the opt-in Notepad++ integration.

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

This is an early beta and the program is still rough. Back up project and server data before upgrades.
