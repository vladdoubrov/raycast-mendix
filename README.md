# Mendix App Switcher for Raycast (Windows)

Switch between your Mendix apps and Team Server branches from [Raycast for Windows](https://www.raycast.com/windows):

- See remote and local branches of an app in one list.
- Open a checkout in the right Studio Pro version.
- Clone a remote branch and open it in one step.
- List, launch, and (optionally) install Studio Pro versions.

> Unofficial, not affiliated with Mendix. Not in the Raycast Store yet; install from source.

## Requirements

- Windows 10/11 with Raycast for Windows
- Node.js 20+
- Git for Windows (for cloning)
- Mendix Studio Pro
- Optional: [Scoop](https://scoop.sh) to install Studio Pro versions

## Install

```powershell
git clone https://github.com/vladdoubrov/raycast-mendix.git
cd raycast-mendix
npm install
npm run dev
```

The extension now shows up in Raycast and stays there after you stop `npm run dev`. To update: `git pull`, `npm install`, `npm run build`.

## Setup

1. **Create a token.** Mendix Portal → User Settings → Developer Settings → Personal Access Tokens. Scope: `mx:modelrepository:repo:read`.
2. **Fill in the preferences.** Raycast → Settings → Extensions → Mendix App Switcher:
   - **Personal Access Token**: the token from step 1.
   - **Local Projects Root**: the folder with your Studio Pro projects, e.g. `C:\Mendix`. New clones go here too.
   - **Studio Pro Executable** (optional): a fixed `studiopro.exe`. Without it, projects open with the Windows `.mpr` association.
3. **Add your apps.** Run **Manage Mendix Apps** → **Add App** with a name and the Project ID (Portal → app → Settings → General).
4. **Clone once to sign in.** On your first clone, Git asks for credentials: user name `pat`, password your token. Windows remembers them.

## Usage

**Open Mendix Branch**: pick an app, then a branch.

| Key | On a local branch | On a remote-only branch |
|---|---|---|
| `Enter` | Open in Studio Pro | Clone and open |
| `Ctrl+Shift+O` | Open with a chosen version | Clone and open with a chosen version |
| `Ctrl+G` | Show uncommitted and unpushed changes | |
| `Ctrl+R` | Refresh | Refresh |

More in the action menu (`Ctrl+K`): clone without opening, partial clone, delete a local copy (to the Recycle Bin), and **View Checkout Operations** for clone progress and logs.

**Mendix Studio Pro Versions**: lists installed versions; launch one or open a branch with it. With Scoop and a Studio Pro bucket (e.g. `scoop bucket add mendix https://github.com/densmoe/scoop-mendix`), you can install new versions from here too.

## Good to know

- **Clones run in a PowerShell window**, so they continue if Raycast closes. Each app gets a cache (`.mendix-switcher-cache` in your projects root), which makes later clones of the same app fast.
- **Clones are set up like Studio Pro's own downloads** (line endings, Mendix metadata, all branches). Mendix still officially supports only downloads made by Studio Pro; **Download via Studio Pro (Assisted)** in the action menu is the official route.
- **Nothing is overwritten.** A failed clone leaves a hidden `.mx-checkout-*` folder for inspection.
- **Your token** is only sent to Mendix's repository API to list branches. Git uses its own stored credentials. No telemetry.

## Troubleshooting

| Problem | Fix |
|---|---|
| API error 401 / 403 | Check the token and its `repo:read` scope, and that you have access to the app. |
| API error 404 | The Project ID is wrong (it's a UUID, not the app name). |
| Local checkouts missing | Check the Local Projects Root. Projects need a `git.api.mendix.com` origin, or give the app a Dedicated Local Root in Manage Apps. |
| Clone fails to authenticate | Remove `git:https://git.api.mendix.com` from Windows Credential Manager and clone again. |
| Clone window shows an execution-policy error | Your organization blocks PowerShell scripts by Group Policy; ask IT. |
| Can't delete a local copy | Close the project in Studio Pro and any terminal open in that folder. |

## Development

```powershell
npm test           # unit and clone-worker tests (local fake Git servers only)
npx tsc --noEmit   # type check
npm run build      # build and update the installed extension
```

Design notes for the clone worker: [docs/checkout-implementation-plan.md](docs/checkout-implementation-plan.md). Architecture overview: [CLAUDE.md](CLAUDE.md).

## License

[MIT](LICENSE)
