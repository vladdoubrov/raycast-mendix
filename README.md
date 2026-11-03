# Mendix App Switcher for Raycast (Windows)

Jump between your Mendix apps and Team Server branches from [Raycast for Windows](https://www.raycast.com/windows). Pick an app, see its remote and local branches side by side, and open a local checkout in the right Studio Pro version, or clone a remote branch and open it in one step.

> Unofficial community extension. It is not affiliated with or endorsed by Mendix or Siemens. It is not (yet) in the Raycast Store; you install it from source.

## Features

- **One branch list per app**: remote Team Server branches (through the Mendix Repository API) merged with the checkouts on your disk. Each branch shows whether it is local, remote, or both, and the Mendix version of its latest commit.
- **Open in the right Studio Pro**: open a checkout with your default Studio Pro, the Windows `.mpr` association, or any installed version. The version that matches the branch is listed first, and it turns orange when that version is not installed.
- **Clone and open**: press Enter on a remote-only branch to clone it and open it in Studio Pro. A per-app repository cache makes later clones of the same app fast.
- **Studio Pro versions**: list installed versions like the Version Selector does, launch one, or open a branch with it. Optionally install new versions with [Scoop](https://scoop.sh).
- **Safe cleanup**: move a local checkout to the Recycle Bin, after a confirmation that lists uncommitted changes and unpushed commits.

> **Note:** Mendix documents that Git clones made outside Studio Pro are not supported in Studio Pro, because Studio Pro post-processes its own downloads. This extension applies the same Git settings Studio Pro does (see [How cloning works](#how-cloning-works)), It was developed against Studio Pro 10.24; other versions have had less testing. If you prefer the official route, use **Download via Studio Pro (Assisted)** instead.

## Requirements

- Windows 10 or 11 with [Raycast for Windows](https://www.raycast.com/windows)
- [Node.js](https://nodejs.org) 20 or later (22 recommended), to build the extension
- [Git for Windows](https://git-scm.com/download/win), which includes Git Credential Manager (only needed for cloning)
- Mendix Studio Pro, installed in its default location or through the Version Selector
- A Mendix account with access to the apps you want to see

## Install

```powershell
git clone https://github.com/vladdoubrov/raycast-mendix.git
cd raycast-mendix
npm install
npm run dev
```

`npm run dev` builds the extension and adds it to Raycast. Search Raycast for **Open Mendix Branch** to check. You can stop the dev process with `Ctrl+C`; the extension stays installed.

To update later: `git pull`, `npm install`, then `npm run build`.

## Setup

### 1. Create a Personal Access Token

In the Mendix Portal, open your avatar menu → **User Settings** → **Developer Settings** → **Personal Access Tokens**, and create a token with the scope **`mx:modelrepository:repo:read`**. This is enough to list branches and to clone.

### 2. Set the extension preferences

Raycast → Settings → Extensions → **Mendix App Switcher**:

| Preference | What to enter |
|---|---|
| **Mendix Personal Access Token** | The token from step 1. It is only sent to `repository.api.mendix.com` to list branches. |
| **Local Projects Root** | The folder that holds your Studio Pro projects, for example `C:\Mendix` or `%USERPROFILE%\Documents\Mendix`. Checkouts are found here (up to 3 folders deep), and new clones go here. |
| **Studio Pro Executable** *(optional)* | A specific `studiopro.exe`, for example `C:\Program Files\Mendix\10.24.0\modeler\studiopro.exe`. Without it, projects open through the Windows `.mpr` association (usually the Version Selector). Needed for the assisted download. |
| **Default Clone Type** | **Full** (default, uses the reusable cache) or **Partial** (`blob:none`, downloads old file versions on demand). |
| **Reuse Local Repositories** | On by default. Seeds the cache from a compatible existing checkout. Your project files are never modified. |
| **Repository Cache Root** *(optional)* | Where the per-app cache lives. Default: `<projects root>\.mendix-switcher-cache`. Keep it on the same drive as your projects. |
| **Detailed Clone Diagnostics** | Off by default. Records Git Trace2 performance data in the operation logs. |

### 3. Let Git sign in to Team Server (for cloning)

Cloning uses your normal Git credentials, never the token from the preferences. The first time you clone, Git Credential Manager asks for a user name and password:

- **User name:** `pat`
- **Password:** a Personal Access Token with `mx:modelrepository:repo:read` (it can be the same token as in step 1)

Git Credential Manager stores this in the Windows Credential Manager, so you are asked only once. If you have already cloned from `git.api.mendix.com` on the command line, you are set.

### 4. Add your apps

Run **Manage Mendix Apps** → **Add App**. Enter a name and the app's **Project ID**: Mendix Portal → your app → **Settings** → **General**.

**Dedicated Local Root** is optional. Use it when an app's checkouts live in their own folder, or lack the usual `https://git.api.mendix.com/<project id>.git` origin. In a dedicated root, every `.mpr` project is attributed to that app.

## Usage

### Open Mendix Branch

Pick an app to see its branches in two sections: **Available locally** and **Remote only**. Type to filter by branch name or commit message.

| Action | Shortcut | Notes |
|---|---|---|
| Open in Studio Pro | `Enter` on a local branch | Uses the configured Studio Pro, else the `.mpr` association |
| Open With… | `Ctrl+Shift+O` | Choose an installed Studio Pro version; the branch's version comes first |
| Clone and Open in Studio Pro | `Enter` on a remote-only branch | Runs in a PowerShell window; see below |
| Clone and Open With… | `Ctrl+Shift+O` on a remote-only branch | Clone, then open with a chosen version |
| Clone Only (Don't Open) | | Clone without starting Studio Pro |
| Clone with Full History / Partial Clone | | Override the default clone type once |
| Download via Studio Pro (Assisted) | | Copies the branch name and starts Studio Pro; finish in **Open App** |
| Show Git Changes | `Ctrl+G` | Uncommitted files and unpushed commits |
| Delete Local Copy… | Raycast's Remove shortcut | Moves the folder to the Recycle Bin after a confirmation |
| View Checkout Operations | | Status, logs, and cancellation of clone operations |
| Refresh | `Ctrl+R` | The list is cached and also refreshes in the background |

### Mendix Studio Pro Versions

Lists installed Studio Pro versions, newest first, found the same way as the Version Selector: Windows uninstall entries (machine-wide and per user), plus `Program Files\Mendix` and `%LOCALAPPDATA%\Programs\Mendix`. Launch a version, open its folder, copy its path, or choose **Open a Branch with This Version**.

**Optional: install versions with Scoop.** If [Scoop](https://scoop.sh) has a bucket with Studio Pro manifests, the list also shows an **Available via Scoop** section. For example:

```powershell
scoop bucket add mendix https://github.com/densmoe/scoop-mendix
```

**Install with Scoop** installs per user without admin rights. **Install for All Users (Admin)** uses the bucket's `-machine` manifest. **Update Scoop Catalog** (`Ctrl+U`) runs `scoop update`. The bucket is a community project; review it like any other software source.

## How cloning works

A clone runs in its own PowerShell window, so it keeps going if Raycast closes and you can watch its progress. The window runs a snapshot of `assets/checkout-worker.ps1`.

- **Full (default):** the extension keeps one bare repository cache per app. The first clone downloads all branches once, together with Mendix's commit metadata (Git notes). Later clones refresh the cache and create an independent checkout from it. Git hard-links object files when the cache is on the same drive. There are no alternates or linked worktrees, so deleting the cache never breaks a checkout.
- **Partial:** a direct `--filter=blob:none` clone with full commit history; historical file contents download on demand. Some history and merge operations then need network access.
- No mode uses `--single-branch` or shallow history.

Before any file is written, the clone gets the settings Studio Pro would apply: `core.autocrlf=false`, `core.longpaths=true`, the Mendix project ID, notes rewrite settings, an all-branches fetch mapping, the upstream, and the line-ending marker. The origin is `https://git.api.mendix.com/<project id>.git/`. A checkout is moved into place only after its branch, commit, upstream, notes, clean working tree, and single `.mpr` are validated. Existing folders are never overwritten.

When a clone fails or is cancelled, its hidden `.mx-checkout-<id>` staging folder (and `.building-<id>` cache folder) is kept for inspection. Check `ownership.json` in the operation's logs before you remove one by hand. **View Checkout Operations** shows the last 20 operations, opens logs, cancels, reopens finished projects, and refreshes or removes an app's cache.

## Troubleshooting

| Problem | Fix |
|---|---|
| **Repository API 401** | Check the token and its `mx:modelrepository:repo:read` scope. |
| **Repository API 403** | Your account has no access to the app, or the token lacks the scope. |
| **Repository API 404** | Check the Project ID (it is a UUID, not the app name). |
| **Local checkouts missing** | Check the Local Projects Root. Under a shared root, a project needs an origin like `https://git.api.mendix.com/<project id>.git`. Otherwise give the app a Dedicated Local Root. |
| **Clone asks for a password or fails to authenticate** | See [step 3](#3-let-git-sign-in-to-team-server-for-cloning). To replace stored credentials, remove `git:https://git.api.mendix.com` in Windows Credential Manager. |
| **Clone window closes or shows an execution-policy error** | The worker runs with `-ExecutionPolicy Bypass`, but a policy enforced by Group Policy overrides it. Ask your IT department. |
| **Project opens in the wrong Studio Pro** | Use **Open With…**, or set the Studio Pro Executable preference. Opening with a newer version can offer to upgrade the app. |
| **Cannot delete a local copy** | The dialog names the programs that use the folder. Close the project in Studio Pro, and any terminal or editor open in it. |
| **`ray` rejects the `author` in `package.json`** | Replace it with your own Raycast account handle. |

## Data and security

- Your app list is stored in Raycast's local storage. Cached branch and version lists are in Raycast's cache. Both stay on your PC.
- The token is stored as a Raycast password preference and is only sent to `repository.api.mendix.com` (`Authorization: MxToken …`). It never reaches Git, the clone worker, or a command line.
- No telemetry and no third-party servers.
- The extension runs no Git command that changes a remote. Pushing stays in Studio Pro.

## Development

```powershell
npm test               # compile the testable modules, then run tests/*.test.mjs
npx tsc --noEmit       # type check
npm run lint           # ray lint
npm run build          # build and update the installed extension
```

The tests use disposable local Git servers and dummy `.mpr` files; they never touch real Mendix projects. Set `MX_TEST_POWERSHELL` to a `pwsh.exe` path to run the worker tests under PowerShell 7 instead of Windows PowerShell 5.1.

Raycast runs the installed copy in `%USERPROFILE%\.config\raycast\extensions\mendix-app-switcher`, not this folder. Changes take effect after `npm run dev` or `npm run build`.

- [`docs/checkout-implementation-plan.md`](docs/checkout-implementation-plan.md): design of the clone worker, acceptance criteria, and open Studio Pro checks.
- [`CLAUDE.md`](CLAUDE.md): architecture overview and project rules.
- `scripts/legacy/`: older stand-alone tools (`clone-branch.ps1`, `mx-postclone.sh`) for cloning by hand. The extension does not use them.
- `scripts/inspect-studiopro-launch.ps1`: read-only diagnostic that lists Studio Pro URI handlers and executables.

## References

- [Mendix App Repository API](https://docs.mendix.com/apidocs-mxsdk/apidocs/app-repository-api/)
- [Mendix Team Server](https://docs.mendix.com/developerportal/repository/team-server/)
- [Mendix Open App dialog](https://docs.mendix.com/refguide/open-app-dialog/)
- [Raycast developer documentation](https://developers.raycast.com/)

## License

[MIT](LICENSE)
