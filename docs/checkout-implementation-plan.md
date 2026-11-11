# Mendix checkout improvements: functional and technical plan

Date: 2026-10-26. Target inspected: Studio Pro 10.24.24.119653 on Windows.

This document is the implementation contract and handoff for further agents. The initial implementation is in this repository; validation status and remaining manual checks are distinguished below. Local Git commit `04ce062` preserves the extension before these changes. No real Mendix checkout should be changed by tests or migrated automatically.

## 1. Problem, evidence, and intended outcome

The old remote-branch action ran `git clone --single-branch`, then a post-clone script changed the fetch mapping to all branches and fetched again. It also ran line-ending repair after checkout. This duplicated expensive repository work and made the console appear stuck while Git processed packs.

The supplied `Downloads/clone-log.txt` for Process / Development_MX10 shows:

| Phase | Observed duration/data |
|---|---|
| Initial clone | 12:22:08–12:31:50; approximately 9m42s; 1.36 GiB; 57,271 objects; 11,215 worktree files |
| Post-clone | Approximately 20m45s; additional 214 branches, 977 tags, and 200.41 MiB |
| Additional pack processing | Pack appeared around 12:33:11; index around 12:52:04 |
| Mendix notes | Approximately 7.28 MiB; completed near 12:52:33 |

The long interval between pack and index creation is evidence of costly local pack processing. It does not identify CPU, storage, antivirus, or a specific Git routine as the sole bottleneck. Do not promise a numerical speedup from these timestamps. The desired improvement is architectural: eliminate the single-branch expansion, reuse objects already on disk, and make the remaining cost observable.

A separate investigation found a credential-selection hazard in this Studio Pro version. Its app lookup compares repository URLs using `.NET Uri.IsBaseOf`. Omitting the trailing slash from a `.git` URL can broaden the match to another app on the host. Preserve the exact canonical remote `https://git.api.mendix.com/<lowercase app UUID>.git/` throughout checkout. This is a code-level finding, not proof that every prior popup had this cause: the failing Process-main folder was already deleted and its exact popup text was unavailable.

## 2. Studio Pro comparison and scope

Inspection of the installed version found the following behavior:

- A full download clones the branch with full branch visibility; it does not use the old extension's single-branch-then-expand sequence.
- Partial downloads use `--filter=blob:none`. Commits remain available; historical blobs may be fetched later.
- A suitable existing same-mode checkout can be reused by copying repository data, refreshing, and switching in a new destination, with remote cloning as a fallback.
- It fetches `refs/notes/mx_metadata`, configures line endings/long paths and Mendix identity, and manages notes rewrite settings.
- Its project-open path removes obsolete custom Studio Pro/mxunit merge-driver configuration. New extension checkouts must not install those drivers.

Studio Pro owns its authentication and model lifecycle and remains the supported workflow. Mendix documents external clones as unsupported for use in Studio Pro. Keep **Download via Studio Pro (Assisted)** available. The extension can improve repeated checkout speed and diagnostics, but cannot claim parity for all Studio Pro versions or internal model behavior. The locally inspected version had partial cloning disabled; do not silently change Studio Pro preferences.

## 3. Functional contract

### 3.1 User actions and preferences

Enter on a local branch opens its existing MPR. Enter on a remote-only branch starts the configured clone mode. Additional actions explicitly select full or partial mode and retain assisted download. An app-specific projects root overrides the global root for both discovery and checkout creation.

| Preference | Default | Required behavior |
|---|---|---|
| Default Clone Type | Full | Select full cache-backed history or direct partial clone |
| Reuse Local Repositories | Enabled | Full clones use a per-app cache; disabled means direct full clone |
| Repository Cache Root | Effective projects root / `.mendix-switcher-cache` | Append `v1/<app UUID>`; recommend same volume as checkouts |
| Detailed Clone Diagnostics | Disabled | Enable Git Trace2 performance logging; ordinary status and stage timing remain enabled |
| Studio Pro Executable | Existing preference | Use configured executable or Windows MPR association |

**View Checkout Operations**, accessible from an app or branch, shows the latest 20 operations with state, stage, strategy, time, and errors. It refreshes every two seconds and supports opening the operation folder, copying status, requesting cancellation, opening a ready checkout, refreshing cache, and confirmed cache removal. Starting a terminal is reported as operation startup, never checkout success.

### 3.2 Outcomes and recovery

Success means a new independent repository has passed validation, moved to its final target, and launch was requested. Launch success only establishes that the OS accepted the launch; the extension cannot verify that Studio Pro fully opened the model. `launch_failed` retains a ready checkout and offers opening it again.

Existing destinations are never overwritten. A free legacy `App-branch` name is preferred; a collision uses a deterministic ten-character SHA-256 suffix derived from app UUID and raw branch name. If that also exists, fail. Windows reserved names, invalid characters, and trailing dots/spaces are sanitized. Raw Git branch names are never sanitized for Git operations.

Failure or cancellation retains the operation logs. The worker removes the staging folder and any `.building-*` cache folder it created in this operation, after its Git processes are killed and before it releases its locks. It removes only folders whose paths it checked were free before it created them, rejects removal when they contain a reparse point, and retries briefly for scanners that hold files. If removal still fails, the leftover path is logged and appended to the status error. A worker that is killed (for example, its window is closed) cannot clean up and leaves its staging folder. No incomplete folder appears in normal local discovery, because staging names begin with a dot. A retry starts a fresh operation. No log retention or resume-in-place is implemented. Manual cleanup must use the operation ownership record and verify the resolved path. Never infer ownership from a friendly folder name alone.

## 4. Module responsibilities and contracts

| File | Responsibility |
|---|---|
| `src/checkout.ts` | Typed request/status contracts, canonical remote, effective root, collision-safe target, cache identity, operation reads |
| `src/launch.ts` | Read preferences, discover candidate seeds, snapshot worker, write request/status, launch detached console, retain assisted/open-local actions |
| `src/operations.tsx` | Status polling, logs, cancellation request, cache actions and removal confirmation |
| `src/switch.tsx` | Branch actions and navigation to operations |
| `assets/checkout-worker.ps1` | Authoritative orchestration, Git process ownership, locks, caching, metadata, validation, publication, launch |
| `src/core.ts` | Discovery and safe folder name primitives; hidden cache/staging stays excluded |
| `tests/worker.test.mjs` | Real-Git fixtures using local `file:///` servers and no Studio Pro launch |
| `docs/checkout-implementation-plan.md` | Architecture, acceptance criteria, and handoff |

The old `clone-branch.ps1` and `mx-postclone.sh` remain legacy manual tools in `scripts/legacy/`. The new Raycast path must not invoke them, and in particular must not run the old unconditional all-branches fetch or worktree line-ending repair. Do not overwrite the worker from an external Tools directory.

Each operation lives under Raycast's support directory at `operations/<random UUID>/` and contains:

- `request.json`: schemaVersion 1, operation/app IDs, action, canonical remote, exact branch, effective root, target, app cache directory, mode, reuse flag, candidate seed paths, diagnostics flag, executable, `launch` (false: publish without opening Studio Pro), `openTerminal` (true: open a terminal in the published checkout). Never includes the API PAT.
- `worker.ps1`: immutable snapshot of the bundled worker at launch, so rebuilds cannot change active operations.
- `status.json`: schemaVersion, IDs, action, state/stage/strategy, target, timestamps, PID/process start time, ready flag/MPR path, selected commit, stage timings, elapsed time, sanitized error.
- `ownership.json`: the staging and target paths associated with this operation.
- `console.log`, `git-events.jsonl`: timestamped progress and per-command durations/exit codes.
- Optional `git-trace2-perf.log`; optional `cancel.request` written by the UI.

Status writes use a temporary file and atomic replacement, retrying transient Windows sharing violations. Readers tolerate unavailable or corrupt records. PID probing is advisory; PID reuse can make a crashed operation appear running. OS file locks, not UI status, control exclusivity. Queued operations that never start currently require log inspection; automatic startup-timeout classification is future work.

## 5. Checkout algorithms

### 5.1 Preflight and shared invariants

Validate schema, UUID, action, mode, canonical URL, branch syntax, and root containment. The worker permits `file:///` only with an explicit test switch; production launch never sets it. Reject reparse-point ancestors, targets outside the effective root, and an occupied target. Locate Git, record its version and PowerShell version, and remove inherited locale/trace environment variables that could affect execution or expose authentication data.

Acquire an exclusive OS file handle for the destination reservation. Prepare hidden staging `.mx-checkout-<operation UUID>` beside the intended destination; this permits same-volume final rename. Lock files are opened with delete-on-close, so Windows removes them when the handle closes, including when the worker is killed. An opener that hits the brief pending-delete window gets access denied and retries.

Git receives argument arrays serialized with Windows native quoting, not interpolated shell commands. It runs without automatic GC/maintenance during the operation. Existing global Git configuration is not modified. Credential helpers remain responsible for Git authentication. The API token is only for branch listing.

### 5.2 Full clone using cache

The app directory contains `full.git`, `manifest.json`, and `cache.lock`. The manifest binds schema, lowercase app UUID, exact remote, full clone type, and last successful refresh time. All cache refresh, local materialization, and cache deletion hold the exclusive app lock. Different apps can proceed independently. Waiting is cancellable and has a 30-minute lock-acquisition timeout.

For an existing cache, validate the manifest, bare repository, full/nonshallow status, canonical origin, and absence of alternates/promisor configuration. Fetch with `--atomic --prune` and explicit all-heads and Mendix notes refspecs. Normal Git tag auto-follow remains active; do not force-prune tags. Record a successful refresh only after Git succeeds. Do not silently use stale cache after authentication or fetch failure.

For a missing cache, consider discovered checkouts as seed candidates. Require the same origin/app, a real `.git` directory, no observed Git lock files, no shallow history, no partial/promisor configuration, and no object alternates. Worktree edits can exist because seeding reads immutable Git objects and remote-tracking refs only; it never resets, fetches into, or cleans the source.

A seed is cloned locally and bare into `.building-<operation UUID>`, allowing Git to hard-link or copy existing objects without repacking the entire source. Imported heads/tags are removed in a batched ref transaction and reconstructed from origin's remote-tracking refs; unpublished branches/tags must not become advertised cache refs. Repoint origin to the canonical server, then refresh heads/notes from the server. Object storage may still contain unreachable objects from the seed. Concurrent external Git maintenance on the source is not fully preventable; failures remain visible and preserve staging. There is no automatic retry of arbitrary seed failures against the remote in this iteration.

Without a valid seed, run one full `git clone --bare --progress` from the server and fetch Mendix notes once. Never first clone a single branch. Validate the cache and rename the building directory into `full.git`, then write the ownership manifest. An interrupted rename/manifest sequence can leave an incomplete cache requiring inspection; never adopt it blindly.

Resolve the selected branch's commit from the refreshed cache. Create a new `--local --no-checkout` clone from it with autocrlf disabled and long paths enabled. Fetch notes locally, replace origin with the canonical server URL, then release the cache lock. This checkout must have its own `.git` directory and no alternates. Hard-linked immutable objects are independent directory entries: cache deletion or repacking must not invalidate published checkouts. Cross-volume cloning uses Git's file-copy fallback.

### 5.3 Direct full or partial clone

When reuse is disabled, run a direct full `--no-checkout` clone. For partial mode, add `--filter=blob:none`; bypass the full cache entirely. Both include all remote branch refs and avoid shallow history. Fetch Mendix notes once after cloning. Record the selected remote-tracking commit.

If Git explicitly reports that filtering is unsupported and ignored, classify the result as `direct-full-filter-unavailable`, remove the misleading promisor/filter settings, and validate as full. Do not retry an authentication error or unknown clone failure as another mode. A genuine partial clone keeps its promisor configuration so later missing-object fetches work.

### 5.4 Configure, validate, publish, launch

Apply these repository-local values before normal use:

```text
core.autocrlf=false
core.longpaths=true
mendix.sprintr-project-id=<app UUID>
mendix.lineEndingResetDone=true
notes.rewriteRef=refs/notes/mx_metadata
notes.rewriteMode=overwrite
notes.rewrite.rebase=true
remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*
```

Materialize the selected branch and set its upstream to `origin/<branch>`. No destructive line-ending reset is needed because autocrlf was disabled before initial checkout. Validate exact origin/branch/upstream, HEAD equal to the captured commit, notes present, clean working tree, appropriate full/partial characteristics, and exactly one MPR at root or one directory below. Multiple MPRs fail rather than choosing arbitrarily. Do not rewrite tracked `.gitignore`, `.gitattributes`, model files, or merge drivers.

Publish with `Directory.Move`, which fails if the destination appears concurrently. A generic move into an existing directory is prohibited because it could nest the staging folder into a user's project. Record ready/MPR path before requesting launch. Clear inherited `LC_ALL` for configured executable launches. Version selection remains the configured executable or Windows association; no model auto-upgrade logic is added.

## 6. Cancellation, cleanup, and operational limits

Git children are assigned to a Windows kill-on-close job; closing the worker or disposing the job terminates owned Git processes. The worker checks `cancel.request` during Git output processing and while waiting for locks. It releases locks in `finally`. Requests arriving between launch and a very short Git process exit are handled without treating an already-exited child as a supervision failure.

After an error, the implementation recursively deletes only the staging and cache build folders that the failed operation created (section 3.2). Confirmed cache removal validates ownership, rejects nested reparse points, and deletes only that app's `full.git` and manifest under lock. An invalid/corrupt manifest or structurally invalid cache blocks automatic removal; document/manual inspection is required. No checkout folder is an automatic deletion target.

Trace2 is opt-in because logs can reveal local paths, branch names, and remote details. Ordinary logs redact HTTP URL userinfo and authorization fields, but cannot guarantee that arbitrary credential helpers never print secrets. Review logs before sharing. No telemetry or remote writes are implemented.

## 7. Verification and acceptance matrix

Automated tests use dummy MPR files, so they validate repository mechanics, not Mendix model semantics. Run `npm test`, `npx tsc --noEmit`, then build. Run worker integration tests with Windows PowerShell 5.1 and PowerShell 7 using `MX_TEST_POWERSHELL` where available.

| Scenario | Acceptance |
|---|---|
| Cold full cache | Clean independent checkout; all branch refs; exact origin; notes and Mendix settings |
| Warm cache | Newly added server branch/tag appears; correct upstream/commit |
| Seed with dirty source | Worktree edit survives unchanged; new checkout contains committed content |
| Cache removal | Existing checkout passes `git fsck --full`, fetch, and merge |
| Direct full | Bypasses cache; actual remote advancement can be fetched and merged |
| Partial | Promisor remains configured; checkout clean; fetch/merge available |
| Unsupported filter | Recorded full fallback; no misleading promisor configuration |
| Missing branch/notes | Failure before publish; no launch; useful retained logs |
| Existing destination | User files remain unchanged |
| Concurrent same target | Exactly one succeeds; no nested checkout; loser fails safely |
| Cancellation | Cancelled state and no published target when cancellation precedes work |
| Naming and roots | Dedicated root wins; invalid UUID rejected; collisions are deterministic |

Manual acceptance still required against a real disposable Mendix branch: open in Studio Pro 10.24.24, confirm Team Server identity, refresh/fetch, view history/metadata, merge a suitable test branch, close/reopen, and verify no unexpected model changes. Repeat with other Studio Pro versions before claiming support. Also exercise an authentication prompt, network interruption, closing a terminal during transfer, cross-volume cache, disk-full failure, and a large repository with optional Trace2. These are not proven by the local fixture suite.

For performance comparison, measure cold full, seeded full, warm full, and direct partial on the same branch and machine. Record Git/Studio Pro versions, cache state, stage durations, transfer size from console, pack/index timings from Trace2, and physical disk usage. Do not count hard-linked file lengths twice as physical bytes. Do not run AV exclusions or change system security settings to improve a benchmark. Report variance and distinguish initial download from repeated checkout benefits.

## 8. Build, rollout, rollback, and further agent work

Raycast runs the installed copy at `%USERPROFILE%\.config\raycast\extensions\mendix-app-switcher`. `npm run build` or `npm run dev` must propagate edits. Verify hashes of bundled worker assets and confirm the installed command bundle contains the new operations/preferences before declaring deployment complete. Do not alter user app registrations or existing branch-list caches.

Initial rollout keeps full mode and reuse enabled, partial opt-in, diagnostics opt-in, and assisted download available. Rollback should restore implementation files from `04ce062` in a separate checkout or selectively after reviewing local changes, then rebuild. Do not blindly reset the working tree or remove user project/cache data. Existing published repositories remain ordinary independent Git checkouts.

Further work must retain these invariants. Suggested follow-ups, not represented as already implemented: safe explicit abandoned-operation cleanup with ownership verification; richer cache health/size UI; startup timeout and PID-start-time reconciliation; a separately tested seed-failure fallback that distinguishes source-race errors from auth/network failures; post-run maintenance scheduling outside checkout latency; version-aware executable selection; and real Studio Pro/performance acceptance results. Avoid adding linked worktrees until Studio Pro `.git` file compatibility is demonstrated.

## 9. Completed validation for this implementation

Validated on 2026-10-26 with Git 2.49.0.windows.1:

- `npm test`: **19 passed, 0 failed**, including the Windows PowerShell 5.1 worker integration suite and Unicode paths/branches.
- The worker integration suite under installed PowerShell **7.6.6**: **11 passed, 0 failed** (parent test plus ten scenarios).
- `npx tsc --noEmit`: passed. `git diff --check`: passed.
- `npm run lint`: manifest and icon checks passed; the CLI skipped formatting checks because ESLint and Prettier are not installed. This is not a claim that ESLint/Prettier passed.
- `npm run build`: passed and updated the installed Raycast extension. Installed bundle includes the operations UI and new preferences.
- Source and installed `assets/checkout-worker.ps1` SHA-256 both equal `2350EB09DF99C93BD117D150F7AD073F729CC5BE51270FEFD7AD2080277EFA01`.

No actual Mendix project was cloned, modified, or opened for these tests. Real Studio Pro acceptance and large-repository timing remain the manual checks listed in section 7. The implementation changes are left uncommitted for review against baseline `04ce062`.

## References

- [Mendix 10 clone types](https://docs.mendix.com/refguide10/clone-type/)
- [Mendix 10 repository-size troubleshooting](https://docs.mendix.com/refguide10/troubleshoot-repository-size/)
- [Mendix Team Server and external-clone support scope](https://docs.mendix.com/developerportal/repository/team-server/)
- [Git clone: local copying, hard links, alternates, partial filters](https://git-scm.com/docs/git-clone)
- [Git index-pack](https://git-scm.com/docs/git-index-pack)
- [.NET Uri.IsBaseOf semantics](https://learn.microsoft.com/en-us/dotnet/api/system.uri.isbaseof)

Version-specific implementation observations came from read-only inspection of the locally installed Studio Pro assemblies; upstream documentation does not establish every internal detail listed here.
