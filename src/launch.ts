import { Alert, Clipboard, Color, Icon, Image, Toast, confirmAlert, environment, getPreferenceValues, open, showToast } from "@raycast/api";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalCheckout, MendixApp, findLocalCheckouts, summarizeGitStatus } from "./core";
import { CheckoutPreferences, CheckoutRequest, CloneType, OperationAction, cacheDirectory, canonicalRemote, checkoutTarget, projectRoot } from "./checkout";

export type Config = CheckoutPreferences & {
  personalAccessToken?: string;
  projectsRoot?: string;
  studioProExecutable?: string;
};
export const getConfig = () => getPreferenceValues<Config>();
function launchEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.LC_ALL;
  for (const key of Object.keys(env)) if (/^GIT_(TRACE|CURL_VERBOSE)/.test(key)) delete env[key];
  return env;
}

/** The icon of what will open the project: the configured studiopro.exe, else the .mpr association (Version Selector). */
export function studioProIcon(mprPath?: string): Image.ImageLike {
  const exe = getConfig().studioProExecutable?.trim() || mprPath;
  return exe ? { fileIcon: exe } : Icon.AppWindow;
}

/** Starts a specific studiopro.exe, optionally with a project; Studio Pro outlives Raycast. */
export function launchStudioPro(executable: string, mprPath?: string): void {
  const child = spawn(executable, mprPath ? [mprPath] : [], { detached: true, stdio: "ignore", windowsHide: false, env: launchEnvironment() });
  child.once("error", (error) => void showToast({ style: Toast.Style.Failure, title: "Failed to launch Studio Pro", message: error.message }));
  child.unref();
}

/** Opens with `executable` when given, else the configured Studio Pro, else the .mpr association. */
export async function openLocal(mprPath: string, executable?: string): Promise<void> {
  try {
    const exe = executable ?? getConfig().studioProExecutable?.trim();
    if (exe) {
      launchStudioPro(exe, mprPath);
    } else {
      await open(mprPath); // Use Windows .mpr file association / Mendix Version Selector.
    }
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Unable to open checkout", message: String(error) });
  }
}

export async function assistedCheckout(app: MendixApp, branch: string): Promise<void> {
  const exe = getConfig().studioProExecutable?.trim();
  if (!exe) {
    await Clipboard.copy(branch);
    await showToast({
      style: Toast.Style.Failure,
      title: "Configure Studio Pro Executable first",
      message: `Branch ${branch} copied. Set studiopro.exe in extension preferences, then retry.`,
    });
    return;
  }
  try {
    await fs.access(exe);
    await Clipboard.copy(branch);
    launchStudioPro(exe);
    await showToast({
      style: Toast.Style.Success,
      title: `Opened Studio Pro for ${app.name}`,
      message: `Branch '${branch}' copied. Use Open App → ${app.name} → ${branch} to download it.`,
    });
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Unable to launch Studio Pro", message: String(error) });
  }
}

// Start-Process opens a real console window (CREATE_NEW_CONSOLE). Node cannot: from Raycast's console-less
// backend a detached spawn gets no console, and a plain spawn hands PowerShell NUL std handles.
// The window prefers the Microsoft Store PowerShell 7 (its app alias), then any pwsh on the registry PATH
// (Raycast's PATH is incomplete), then Windows PowerShell.
// Raycast's environment also lacks variables such as PATHEXT, without which `Get-Command git` (Scoop's Git check)
// finds nothing; missing system and user variables are restored from the registry, profile folders from the OS.
// Windows PowerShell started without PATHEXT sets it to just ".CPL", so it is restored whenever .EXE is missing.
// [char]34 is a double quote, so the -File path survives spaces without quoting this argument.
const OPEN_WINDOW = [
  "foreach ($scope in 'Machine','User') { $vars = [Environment]::GetEnvironmentVariables($scope); foreach ($name in $vars.Keys) { if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) { [Environment]::SetEnvironmentVariable($name, $vars[$name], 'Process') } } }",
  "foreach ($folder in @{ USERPROFILE = 'UserProfile'; APPDATA = 'ApplicationData'; LOCALAPPDATA = 'LocalApplicationData' }.GetEnumerator()) { if (-not [Environment]::GetEnvironmentVariable($folder.Key, 'Process')) { [Environment]::SetEnvironmentVariable($folder.Key, [Environment]::GetFolderPath($folder.Value), 'Process') } }",
  "if (($env:PATHEXT -split ';') -notcontains '.EXE') { $env:PATHEXT = [Environment]::GetEnvironmentVariable('PATHEXT','Machine') }",
  "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path",
  "$ps = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Microsoft\\WindowsApps\\Microsoft.PowerShell_8wekyb3d8bbwe\\pwsh.exe'",
  "if (-not (Test-Path -LiteralPath $ps)) { $ps = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source }",
  "if (-not $ps) { $ps = 'powershell.exe' }",
  "Start-Process -FilePath $ps -WorkingDirectory $env:USERPROFILE -ArgumentList '-NoProfile','-NoExit','-ExecutionPolicy','Bypass','-File',('{0}{1}{0}' -f [char]34, $env:MX_WINDOW_SCRIPT)",
].join("; ");

/** Runs `script` in its own visible PowerShell window; resolves once the window has started. The window inherits `env`. */
function openPowerShellWindow(script: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", OPEN_WINDOW], {
      stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env: { ...launchEnvironment(), ...env, MX_WINDOW_SCRIPT: script },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`)));
  });
}

/** `executable` opens the clone with that Studio Pro instead of the configured one. */
export async function cloneAndOpen(app: MendixApp, branch: string, cloneType?: CloneType, executable?: string): Promise<void> {
  await startOperation(app, branch, "checkout", cloneType, executable);
}

/** Clones with the default clone type and leaves Studio Pro closed; Checkout Operations can open it later. */
export async function cloneOnly(app: MendixApp, branch: string): Promise<void> {
  await startOperation(app, branch, "checkout", undefined, undefined, false);
}

const exists = (path: string) => fs.stat(path).then(() => true, () => false);

function runGit(folder: string, args: string[]): Promise<string | undefined> {
  // Raycast's PATH may lack Git, so fall back to Git for Windows' default location.
  const candidates = ["git", join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd", "git.exe")];
  const run = (i: number): Promise<string | undefined> => i >= candidates.length ? Promise.resolve(undefined) : new Promise((done) => {
    // quotePath=false keeps non-ASCII file names readable instead of octal-escaped.
    execFile(candidates[i], ["-c", "core.quotePath=false", "-C", folder, ...args], { windowsHide: true, timeout: 20_000, env: launchEnvironment() },
      (error, stdout) => error ? void run(i + 1).then(done) : done(stdout));
  });
  return run(0);
}

export const UNPUSHED_LIMIT = 50;
export type GitChanges =
  | { kind: "unversioned" }
  | { kind: "unknown" }
  | { kind: "git"; files: string[]; unpushed: string[]; upstream: boolean };
/** Uncommitted files and commits that are on no remote, for the delete confirmation and the Git changes view. */
export async function readGitChanges(folder: string): Promise<GitChanges> {
  // Without its own .git, `git -C` could report on an enclosing repository instead.
  if (!await exists(join(folder, ".git"))) return { kind: "unversioned" };
  const [status, log] = await Promise.all([
    runGit(folder, ["status", "--porcelain=v1", "--branch"]),
    // Commits on no remote at all, so this also covers a branch without an upstream.
    runGit(folder, ["log", "--oneline", "--no-decorate", "-n", String(UNPUSHED_LIMIT), "HEAD", "--not", "--remotes"]),
  ]);
  if (status === undefined) return { kind: "unknown" };
  const { files, upstream } = summarizeGitStatus(status);
  return { kind: "git", files, upstream, unpushed: (log ?? "").split(/\r?\n/).filter(Boolean) };
}
export function gitWarnings(changes: GitChanges): string[] {
  if (changes.kind === "unversioned") return ["This project is not under Git: the folder holds the only copy of its work."];
  if (changes.kind === "unknown") return ["Could not check for uncommitted changes."];
  const { files, unpushed, upstream } = changes;
  const commits = unpushed.length >= UNPUSHED_LIMIT ? `${UNPUSHED_LIMIT}+` : String(unpushed.length);
  return [
    ...(files.length ? [`${files.length} uncommitted change${files.length > 1 ? "s" : ""}.`] : []),
    ...(unpushed.length ? [`${commits} commit${unpushed.length > 1 ? "s" : ""} not pushed.`] : []),
    ...(!upstream ? ["No upstream branch (none set, or deleted on the server)."] : []),
  ];
}

// Raycast's trash() gives up after 5 seconds while Windows keeps recycling, so a large project
// reported failure yet disappeared. The script has no time limit and warns before a permanent delete.
function recycleFolder(folder: string): Promise<"recycled" | "cancelled"> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(environment.assetsPath, "recycle-folder.ps1")],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env: { ...launchEnvironment(), MX_RECYCLE_PATH: folder } });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve("recycled") : code === 2 ? resolve("cancelled")
      : reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`)));
  });
}

/** Moves a checkout folder to the Recycle Bin after a confirmation that names unsaved Git work; true when removed. */
export async function deleteLocalCheckout(app: MendixApp, checkout: LocalCheckout): Promise<boolean> {
  try {
    // Already gone (e.g. deleted in Explorer): only the list needs updating.
    if (!await exists(checkout.folder)) {
      await showToast({ style: Toast.Style.Success, title: "Local copy was already removed", message: checkout.folder });
      return true;
    }
    // Only a project folder below the projects root, never the root itself.
    const inside = relative(projectRoot(app, getConfig()), checkout.folder);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error(`${checkout.folder} is not inside the projects root`);
    const changes = await readGitChanges(checkout.folder);
    const warnings = gitWarnings(changes);
    // An alert has no room for a file list; the branch's Show Git Changes view has it.
    const review = changes.kind === "git" && (changes.files.length || changes.unpushed.length) ? "To see them: Cancel, then Show Git Changes (Ctrl+G)." : "";
    const confirmed = await confirmAlert({
      title: `Delete local copy of ${checkout.branch}?`,
      message: [checkout.folder, warnings.length ? warnings.map((w) => `⚠ ${w}`).join("\n") : "No uncommitted or unpushed changes.", review,
        "The folder is moved to the Recycle Bin. Close it in Studio Pro first."].filter(Boolean).join("\n\n"),
      icon: { source: Icon.Trash, tintColor: Color.Red },
      primaryAction: { title: "Move to Recycle Bin", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return false;
    const toast = await showToast({ style: Toast.Style.Animated, title: "Deleting local copy", message: checkout.branch });
    let outcome: "recycled" | "cancelled";
    for (;;) {
      try { outcome = await recycleFolder(checkout.folder); break; }
      catch (error) {
        // A toast is easy to miss, and the usual cause (a program using the folder) is fixable right away.
        await toast.hide();
        const retry = await confirmAlert({
          title: "Could not delete local copy", message: error instanceof Error ? error.message : String(error),
          icon: { source: Icon.Warning, tintColor: Color.Orange }, primaryAction: { title: "Try Again" },
        });
        if (!retry) return false;
        await toast.show();
      }
    }
    if (outcome === "cancelled") {
      toast.style = Toast.Style.Failure; toast.title = "Deletion cancelled";
      return false;
    }
    toast.style = Toast.Style.Success; toast.title = "Local copy moved to Recycle Bin";
    return true;
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Could not delete local copy", message: String(error instanceof Error ? error.message : error) });
    return false;
  }
}

/** Opens `scoop install <bucket>/<app>` or `scoop update` in a PowerShell window, which shows the download progress. */
export async function runScoop(action: "install" | "update", app = ""): Promise<void> {
  const toast = await showToast({ style: Toast.Style.Animated, title: action === "install" ? `Installing ${app}` : "Updating Scoop catalog" });
  try {
    await openPowerShellWindow(join(environment.assetsPath, "scoop-mendix.ps1"), { MX_SCOOP_ACTION: action, MX_SCOOP_APP: app });
    toast.style = Toast.Style.Success;
    toast.title = action === "install" ? "Installing in PowerShell" : "Updating Scoop in PowerShell";
    toast.message = "Refresh with Ctrl+R when the window says Done.";
  } catch (error) {
    toast.style = Toast.Style.Failure; toast.title = "Could not start Scoop"; toast.message = error instanceof Error ? error.message : String(error);
  }
}

export async function cacheOperation(app: MendixApp, action: "refresh-cache" | "remove-cache"): Promise<void> {
  await startOperation(app, "", action, "full");
}

async function startOperation(app: MendixApp, branch: string, action: OperationAction, mode?: CloneType, executable?: string, launch = true): Promise<void> {
  const cfg = getConfig();
  try {
    const parent = projectRoot(app, cfg);
    const target = action === "checkout" ? await checkoutTarget(app, branch, parent) : "";
    const operationId = randomUUID();
    const directory = join(environment.supportPath, "operations", operationId);
    await fs.mkdir(directory, { recursive: true });
    // Snapshot the worker so a rebuild cannot change an operation already in progress.
    const script = join(directory, "worker.ps1");
    await fs.copyFile(join(environment.assetsPath, "checkout-worker.ps1"), script);
    const cloneType = mode ?? cfg.cloneType ?? "full";
    const reuse = cfg.reuseLocalRepositories !== false;
    const seeds = cloneType === "full" && reuse && action !== "remove-cache"
      ? (await findLocalCheckouts(app, cfg.projectsRoot ?? "")).map(c => c.folder) : [];
    const request: CheckoutRequest = {
      schemaVersion: 1, operationId, action, appId: app.id.toLowerCase(), appName: app.name,
      remoteUrl: canonicalRemote(app.id), branch, projectsRoot: parent, target,
      cacheRoot: cacheDirectory(app, cfg), cloneType, reuseLocalRepositories: reuse,
      seeds: [...new Set(seeds)], diagnostics: cfg.detailedCloneDiagnostics === true,
      studioProExecutable: executable ?? cfg.studioProExecutable?.trim() ?? "", launch,
    };
    const requestFile = join(directory, "request.json");
    await fs.writeFile(requestFile, JSON.stringify(request, null, 2));
    const queued = { schemaVersion: 1, operationId, appId: request.appId, branch, action, target,
      state: "queued", stage: "opening-terminal", strategy: "", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await fs.writeFile(join(directory, "status.json"), JSON.stringify(queued, null, 2));
    const toast = await showToast({ style: Toast.Style.Animated, title: "Opening operation terminal" });
    try {
      await openPowerShellWindow(script, { MX_CHECKOUT_REQUEST: requestFile });
      toast.style = Toast.Style.Success; toast.title = "Operation started in PowerShell";
      toast.message = "View Checkout Operations for status, logs, and cancellation.";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.style = Toast.Style.Failure; toast.title = "Could not open operation terminal"; toast.message = message;
      await fs.writeFile(join(directory, "status.json"), JSON.stringify({ ...queued, state: "failed", error: message }));
    }
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Unable to start operation", message: String(error) });
  }
}
