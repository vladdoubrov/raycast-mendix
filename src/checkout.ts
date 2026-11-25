import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { MendixApp, safeCheckoutFolderName, validateAppId } from "./core";

export type CloneType = "full" | "partial";
/** "create-branch" pushes `branch` as a new server branch at the tip of `baseBranch`, then optionally checks it out. */
export type OperationAction = "checkout" | "refresh-cache" | "remove-cache" | "create-branch";
export interface CheckoutPreferences {
  projectsRoot?: string;
  repositoryCacheRoot?: string;
  cloneType?: CloneType;
  reuseLocalRepositories?: boolean;
  detailedCloneDiagnostics?: boolean;
}
export interface CheckoutRequest {
  schemaVersion: 1;
  operationId: string;
  action: OperationAction;
  appId: string;
  appName: string;
  remoteUrl: string;
  branch: string;
  projectsRoot: string;
  target: string;
  cacheRoot: string;
  cloneType: CloneType;
  reuseLocalRepositories: boolean;
  seeds: string[];
  diagnostics: boolean;
  studioProExecutable: string;
  /** False publishes the checkout without opening Studio Pro. */
  launch: boolean;
  /** True opens a terminal in the published checkout folder. */
  openTerminal: boolean;
  /** create-branch only: the server branch whose latest commit the new branch starts from. */
  baseBranch?: string;
  /** create-branch only: false creates the branch on the server without a local checkout (`target` is empty). */
  download?: boolean;
}
export interface OperationStatus {
  schemaVersion: 1;
  operationId: string;
  appId: string;
  branch: string;
  action: OperationAction;
  state: string;
  stage: string;
  strategy: string;
  target: string;
  startedAt: string;
  updatedAt: string;
  pid?: number;
  processStartedAt?: string;
  ready?: boolean;
  mprPath?: string;
  commit?: string;
  error?: string;
  timings?: Record<string, number>;
  directory: string;
}
export const terminalStates = new Set(["completed", "failed", "cancelled", "launch_failed", "interrupted"]);
export function canonicalRemote(appId: string): string {
  if (!validateAppId(appId)) throw new Error("Invalid Mendix app ID");
  return `https://git.api.mendix.com/${appId.trim().toLowerCase()}.git/`;
}
export function projectRoot(app: MendixApp, prefs: CheckoutPreferences): string {
  const root = (app.localRoot?.trim() || prefs.projectsRoot?.trim());
  if (!root) throw new Error("Set a Local Projects Root or an app-specific root first");
  return resolve(root);
}
export function cacheDirectory(app: MendixApp, prefs: CheckoutPreferences): string {
  return join(prefs.repositoryCacheRoot?.trim() || join(projectRoot(app, prefs), ".mendix-switcher-cache"), "v1", app.id.toLowerCase());
}
// Keep existing names when free. Never replace an existing directory or reuse an ambiguous name.
export async function checkoutTarget(app: MendixApp, branch: string, root: string): Promise<string> {
  const name = safeCheckoutFolderName(app, branch);
  const exists = async (p: string) => fs.lstat(p).then(() => true, (e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return false;
    throw e;
  });
  const preferred = join(root, name);
  if (!(await exists(preferred))) return preferred;
  const suffix = createHash("sha256").update(`${app.id.toLowerCase()}\0${branch}`).digest("hex").slice(0, 10);
  const fallback = join(root, `${name}-${suffix}`);
  if (await exists(fallback)) throw new Error(`Checkout destination already exists: ${fallback}`);
  return fallback;
}
export async function readOperations(supportPath: string, appId: string): Promise<OperationStatus[]> {
  const root = join(supportPath, "operations");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const results = await Promise.all(entries.filter(e => e.isDirectory()).map(async e => {
    try {
      const directory = join(root, e.name);
      const status = JSON.parse(await fs.readFile(join(directory, "status.json"), "utf8")) as OperationStatus;
      if (status.schemaVersion !== 1 || status.appId !== appId.toLowerCase() || typeof status.state !== "string") return;
      // A PID alone can be reused. Treat liveness here as advisory; the worker's OS locks are authoritative.
      if (!terminalStates.has(status.state) && status.pid) {
        try { process.kill(status.pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            status.state = "interrupted";
            status.error = "Worker stopped. Logs and incomplete files were retained; start a new operation to retry.";
          }
        }
      }
      return { ...status, directory };
    } catch { return undefined; }
  }));
  return results.filter((r): r is OperationStatus => !!r).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
}
