# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Windows-only Raycast extension (local source, not published to the Store) for browsing Mendix Team Server apps and branches, opening local checkouts in Studio Pro, cloning remote branches, and managing installed Studio Pro versions.

## Commands

```powershell
npm run dev            # ray develop --target release
npm run build          # ray build -e dist; type-checks and compiles only, does NOT update the installed extension
npm run lint           # ray lint; skips formatting checks because ESLint and Prettier are not installed
npx tsc --noEmit       # type check

npm test               # compiles test modules, then runs tests/*.test.mjs

# Single test file or test (compile first unless running only worker.test.mjs)
node scripts/compile-core.cjs
node --test tests/core.test.mjs
node --test --test-name-pattern="validates Mendix" tests/core.test.mjs
```

Set `MX_TEST_POWERSHELL` to a `pwsh.exe` path to run `tests/worker.test.mjs` under PowerShell 7. It defaults to `powershell.exe` (5.1), and the worker must work on both.

Raycast runs the installed copy at `%USERPROFILE%\.config\raycast\extensions\mendix-app-switcher`, not this directory. Edits take effect only after `npm run dev` (a watcher; it copies within seconds and the copy stays after you stop it), so check the installed assets before declaring a change deployed.

## Architecture

The three commands in `package.json` (`switch`, `manage-apps`, `versions`) are the entry points in `src/`. They share views: `versions.tsx` reuses `AppList` from `switch.tsx`, which in turn uses `operations.tsx` and `git-changes.tsx`.

### Testable modules vs. Raycast modules

`src/core.ts`, `src/checkout.ts`, `src/studiopro.ts`, and `src/jira.ts` must not import `@raycast/api`. `scripts/compile-core.cjs` transpiles exactly these four to `dist-test/*.cjs` for the Node test runner, and rewrites only the `./core` import. A new test-covered module, or a new import between them, needs that script updated.

`src/launch.ts` holds the side effects that need Raycast: preferences, spawning processes, and starting operations. `src/storage.ts` wraps LocalStorage (registered apps) and Cache (branch and version lists, shown immediately and refreshed in the background).

### Checkout: TypeScript hands off to a PowerShell worker

Clone, cache, and branch-creation work runs in `assets/checkout-worker.ps1`, not in the extension process, so it survives Raycast closing. The two sides communicate only through files in `<supportPath>/operations/<uuid>/`:

1. `startOperation` in `launch.ts` copies the worker into the operation folder as `worker.ps1`, so a rebuild cannot change a running operation. It then writes `request.json` and an initial `status.json`.
2. `openPowerShellWindow` starts the snapshot in a visible console. The worker is the authority on locks, Git processes, validation, publishing, and launching Studio Pro.
3. The worker updates `status.json` atomically and appends to `console.log` and `git-events.jsonl`. `operations.tsx` polls these through `readOperations` and requests cancellation by writing `cancel.request`.

`CheckoutRequest` and `OperationStatus` in `checkout.ts` are the contract with the worker. Changing either means changing the worker and the request built in `tests/worker.test.mjs`.

`docs/checkout-implementation-plan.md` is the design contract for this flow: algorithms, acceptance matrix, and outstanding manual Studio Pro checks. Read it before changing the worker. Its section 9 is a validation record from 2026-10-26, not current status.

### Raycast process environment

Raycast's process has an incomplete environment: `PATH`, `PATHEXT`, and `USERPROFILE` may be missing or wrong. This is why the code calls `reg.exe` by full path, falls back to Git for Windows' default location, and restores variables from the registry in `OPEN_WINDOW`. A detached Node spawn gets no console, so visible windows must go through `Start-Process`. Keep these workarounds when touching process launches.

## Invariants

- **Canonical remote:** keep the exact form `https://git.api.mendix.com/<lowercase uuid>.git/`, including the trailing slash. Studio Pro's credential lookup uses `Uri.IsBaseOf`, so omitting the slash can match another app.
- **Secrets:** the PAT is only for the repository read API (`Authorization: MxToken`). It must never reach the worker request, a Git URL, or arguments. Git authentication belongs to the credential helper. The optional Jira API token (`src/jira.ts`) goes only to the configured HTTPS Jira site as Basic auth; Jira features must stay hidden when site, email, or token is empty.
- **User data:** never overwrite an existing target, and never automatically delete checkouts. On failure the worker removes only the `.mx-checkout-*` and `.building-*` folders that the same operation created; operation logs are kept. A create-only branch without a cache also removes its own throwaway `push.git` from the operation folder. `deleteLocalCheckout` only recycles folders inside the projects root, after a confirmation.
- **Remote and clone shape:** the only remote-mutating Git command is the `create-branch` push in the worker: it adds a new branch at a commit the server already has, with `--force-with-lease=refs/heads/<branch>:` so it can never move or replace an existing branch. Add no other pushes, deletes, or ref updates on the server. Do not use `--single-branch`, shallow clones, alternates, or linked worktrees for checkouts.
- **Git configuration:** do not install Studio Pro/mxunit merge drivers. Set `core.autocrlf=false` before the first materialization rather than repairing line endings afterward.
- **Tests:** they use disposable local `file:///` Git servers and dummy MPR files, never real Mendix projects. `file:///` remotes are allowed only through the worker's `-AllowLocalTestRemote` switch, which production launches never set.
- **Legacy scripts:** `scripts/legacy/clone-branch.ps1` and `scripts/legacy/mx-postclone.sh` are stand-alone manual tools. Keep them out of `assets/` (everything there ships to users), do not call them from the extension, and do not copy external scripts over the worker.
- **Line endings:** `.ps1` and `.sh` files are LF, enforced by `.gitattributes`.
