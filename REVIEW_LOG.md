# Review log

Maintained by the `perspective-master` agent. Each cycle appends an entry.

## Cycle 0 — 2026-11-14 (initial build)

- Baseline: `npm run master` PASS, 150/150 simulated iterations (seed 601262).
- Mutation check: disabling the download size check → 16/60 iterations failed; disabling version pruning → 60/60 failed. The harness detects both regressions.

Open items carried into cycle 1:

| Area | Item | Severity |
| --- | --- | --- |
| phone | `ShotStore.addShot` wraps its insert in `db.transaction`. On the phone, expo-sqlite's `withTransactionAsync` does not serialize, so two quick tags can start a nested transaction and fail. Make shot numbering atomic without a JS-level transaction. | high |
| sim | The Node SQL adapter serializes transactions, which is more forgiving than expo-sqlite and hides the item above. Make it fail like expo does. | high |
| phone | `adapters/expo.ts` has never been typechecked against the real Expo packages. The package versions in `mobile/package.json` are unverified. | medium |
| server | The server has no unit tests. Catalog validation, query validation, and media headers are only covered indirectly. | medium |
| sim | Scenarios that don't exist yet: catalog with no entry for the drill, pinned `version`, same-origin absolute `http` asset URL, session delete, recording while a download is in flight. | medium |

## Cycle 1 — 2026-11-14

Baseline: PASS, 150/150 (seed 601262). Subagents: phone, server, sim (parallel, disjoint areas). Interrupted once by a usage limit; resumed from saved state.

| Area | Finding | Severity | Status |
| --- | --- | --- | --- |
| phone | `addShot` used a JS transaction. Under expo-sqlite, quick taps nest BEGINs: all calls reject, yet one row commits | high | fixed: single `INSERT … SELECT … RETURNING` |
| sim | Node SQL adapter serialized transactions, hiding the bug above (old core passed 10/10, fails 10/10 under expo semantics) | high | fixed: expo-exact transactions, async bridge timing, sandbox URI checks, NSURLSession-like download staging, app-kill simulation |
| phone | Overlapping `startBackend()` calls (React StrictMode) share expo's cached connection; a fresh install could end at user_version=1 with no tables | medium | fixed: idempotent `startBackend` |
| phone | Kill between the new model's row commit and `pruneOlder` kept two models (~8.5 MB) indefinitely. Found by the new `kill_at_each_await_point` | medium | fixed: recovery keeps one model per drill; local-hit prune |
| phone | Expo pins inconsistent (react-native 0.81.4, missing @types/react); adapter never typechecked | medium | fixed: SDK 54 pins; `npm run typecheck` in mobile/ is clean against real types |
| server | Ctrl-C hung forever with a stalled download | medium | fixed: `closeWithin` 5 s |
| server | `Cache-Control: immutable` never reached clients (@fastify/static overwrote it) | medium | fixed |
| server | `sync-catalog` dropped unknown fields and rewrote non-atomically on every run | medium | fixed |
| server | No warning when catalog sizes or files disagree with `media/` | medium | fixed: startup and on-change check |
| server | Protocol-relative / backslash URLs accepted; 5xx leaked absolute file paths; same-size catalog edits missed | low | fixed (contract note added to PROJECT_CONTEXT.md) |
| phone | Failed prune after a committed download failed the whole open | low | fixed: best-effort prune |
| phone | Download timeout used `pauseAsync` | low | fixed: `cancelAsync` |

New tests: 52 server unit tests; 8 new sim scenarios (25 total); stronger invariants (quick_check, byte-identical models, relative paths, no orphan shots, no open transaction).

Result: `npm run master` PASS: 150/150 (seed 729164), 71 phones, 246 relaunches, 18/18 acceptance items. Extra seeds 11 and 12: 150/150 each.

Deferred to cycle 2:

| Area | Item | Severity |
| --- | --- | --- |
| phone | Overlapping opens that resolve to different versions (pinned + unpinned, or a publish mid-download) can prune each other's model | low |
| phone | A body larger than `sizeBytes` is only rejected after the full download, so it can eat disk headroom | low |
| phone | A double-tapped `saveRecording` surfaces a raw move error, not a `BackendError` | low |
| server | A media file replaced without a catalog edit is re-checked only at restart | low |
| phone | Expo SDK 54 is four releases behind npm latest (58). Upgrading is a team decision | info |

## Cycle 2 — 2026-11-14

Baseline: PASS (cycle 1 result). Subagents: phone, server, sim, resumed with their cycle 1 context and given a shared behaviour spec so fixes and tests agree.

| Area | Finding | Severity | Status |
| --- | --- | --- | --- |
| phone | Overlapping opens of different versions could prune each other's model | low | fixed: `openDemo` queued per (shotType, format). Without the queue, `overlapping_versions` fails 13/24 |
| phone | A body larger than `sizeBytes` was downloaded in full before being rejected | low | fixed: `maxBytes` port option, cancel on overflow → `size_mismatch`. Without it, `oversize_media` fails 12/12 |
| phone | A double-saved recording raised a raw ENOENT | low | fixed: `recording_missing`; exactly one session. Without it, `double_save_recording` fails 12/12 |
| phone | Catalog timeout stopped covering the body once headers arrived | low (latent) | fixed. Unreachable with RN's buffered global `fetch`; protects a future move to streaming `expo/fetch` |
| phone | Concurrent `removeVideo` calls all reported the reclaimed bytes | low | fixed: guarded UPDATE. Without it, `remove_video_twice` fails 12/12 |
| sim | Node `fetch` resolved at headers; RN's resolves after the full body | fidelity | fixed |
| sim | Untested core paths: `deleteShot`, input errors, per-drill totals, missing or damaged files, storage accounting, kills during launch/migration | coverage | fixed: `edit_shots_and_history`, `damaged_files`, `storage_usage_accounting`, `kill_during_launch` |
| server | A replaced or deleted export was re-checked only at restart | low | fixed: re-checked on every catalog read, each problem warned once (+4 tests: 56 total) |
| server | Review: concurrent and resumed downloads, media/catalog deleted while running | — | no fault; tests added |

Result: `npm run master` PASS: 150/150 (seed 206094), 34 scenarios, 149 phones, 505 relaunches, 159 injected drops, 22/22 acceptance items. Extra seeds 21 and 22: 150/150 each. Real-Expo typecheck clean.

Deferred:

| Area | Item | Severity |
| --- | --- | --- |
| server | A catalog saved in place by an editor can be read half-written, giving one 500 (the phone keeps its last model) | low |
| phone | The `saveRecording` in-flight guard is redundant with the post-move recheck, so no test fails without it | info |
| phone | If the app moves to `expo/fetch`, switch the sim's fetch to streaming so `stalled_catalog_body` regains teeth | info |

No finding above low this cycle. Next: cycle 3, an independent fresh-eyes review. If it also finds nothing above low, stop.

## Cycle 3 — 2026-11-14 (fresh-eyes review)

An independent reviewer with no prior context read the whole codebase and edited nothing. Every finding came with a reproduction; the master confirmed each against the code before sending it to its owner.

| Area | Finding | Severity | Status |
| --- | --- | --- | --- |
| sim | Random branch selection: in 150 iterations a branch was often never run (4 of 8 seeds skipped one). A planted `findLocal` bug passed 150/150 on seed 22 | medium | fixed: a deterministic `BRANCHES` table cycles every branch; the report includes branch counts; master fails on any unexercised branch. The planted bug now fails on all 5 named seeds (master re-verified seed 22) |
| phone | A kill after the recording move, before its row, lost the clip (recovery deleted it as an orphan) | low | fixed: recovery adopts orphan `videos/<uuid>.<ext>` only when no such session exists; deletes go through a cache trash, so deleted sessions and removed videos are never resurrected. New `kill_during_save` and `kill_during_delete` fail 6/6 against each reverted part |
| phone | Shot numbers reused after deleting the last shot (MAX+1), so a stale `setOutcome` re-tags the wrong shot | low | fixed: migration v2 adds `sessions.last_shot_number` with a trigger; still one atomic statement. `edit_shots_and_history` now requires numbers never be reused |
| phone | A build without `EXPO_PUBLIC_API_URL` silently used the phone's own localhost | low | fixed: `not_configured` error outside `__DEV__`; recording, tagging and replay unaffected |
| server | Files in `media/` subfolders were served (e.g. `/media/blender/source.blend`) | low | fixed: `allowedPath` uses the catalog's `/media/<file>` rule; nested paths 404 whether or not they exist (+1 test: 57) |
| master | The smoke test could validate a stale server already on the port | low | fixed: refuses an occupied port and fails if the spawned server exits. Verified: a squatter on :3977 makes master FAIL |
| master | Could judge a stale or crashed sim's report; acceptance ticked from a stale file | low | fixed: master-owned report path, deleted before each run, seed, iteration and mtime checked; acceptance computed only from a verified passing report |
| master | `adapters/expo.ts` was not in master's typecheck | low | fixed: new step typechecks `mobile/` against the installed Expo SDK |
| master | A hung child could hang the master forever | low | fixed: 10-minute step timeout |

Result: `npm run master` PASS on 8 steps: 150/150 (seed 444751), 36 scenarios, 58/58 branches exercised, about 233 phones, about 759 relaunches, 22/22 acceptance items. Sim subagent: seeds 1, 2 and 22 pass 150/150.

Accepted risk: iOS may purge Caches under storage pressure. If that hits the instant between a delete moving the video to trash and the row commit, the video is lost, but it is a video the player asked to delete.

This cycle had a medium finding, so the loop continues. Cycle 4: a fresh-eyes review focused on the code cycle 3 introduced (trash and adoption recovery, migration v2, the branch framework, the master hardening).

## Cycle 4 — 2026-11-14 (fresh-eyes review of cycle 3's code)

The reviewer found nothing above low severity and no path for master to report a false PASS. Its own mutants against the trash and adoption recovery were all caught.

| Area | Finding | Severity | Status |
| --- | --- | --- | --- |
| phone | `addShot`'s `INSERT … RETURNING` through `db.first` held a write statement open across expo bridge calls. A concurrent delete could resolve, then a kill rolled it back | low | fixed: `db.run` with no RETURNING, then a read-back by rowid; `run` port returns `lastInsertRowId`; writes never go through `first`/`all` |
| sim | `first` ran prepare/step/finalize in one call, and a kill committed pending work, which hid the item above (old core: 4/4 pass; faithful adapter: 0/4) | fidelity | fixed: per-call bridging via `iterate()`, crash snapshots that lose uncommitted work, `failNext` and `setLatency` hooks; new `kill_after_resolved_delete` |
| sim | Untested: v1→v2 migration backfill, `not_configured`, put-back when a row change fails (each mutant passed 72/72) | low | fixed: `migrate_v1_database` (with a kill sweep), `not_configured`, `row_change_fails`; each mutant now 0/4 |
| sim | `SIM_ONLY=""` looped forever | low | fixed: empty means all; unknown names throw |
| master | The step timeout killed only tsx's parent, so master still hung | low | fixed: process-group kill, resolve at timeout; `SIM_ONLY` stripped. Verified: a hung step fails at 3 s with no orphan |
| phone | An adopted clip gets the default drill, NULL duration and launch time | info | deferred: invisible with one drill; each fix adds a moving part to the move-then-row order |

Result: `npm run master` PASS on 8 steps: 150/150 (seed 999617), 40 scenarios, 66/66 branches exercised, 449 phones, 1686 relaunches, 23/23 acceptance items. Sim subagent: seeds 1, 2 and 22 pass 150/150.

First cycle with nothing above low. The loop was stopped here at the user's request, before cycle 5. The master's stop rule calls for one more clean fresh-eyes cycle.
