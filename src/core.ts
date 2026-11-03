import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface MendixApp {
  id: string;
  name: string;
  /** Optional dedicated local search root for this app (e.g. C:\\Mendix\\MyApp). */
  localRoot?: string;
}
export interface RemoteBranch {
  name: string;
  latestCommit?: { id?: string; date?: string; message?: string; mendixVersion?: string };
}
export interface LocalCheckout {
  branch: string;
  mprPath: string;
  folder: string;
  commit?: string;
}
export interface CombinedBranch {
  name: string;
  remote?: RemoteBranch;
  local: LocalCheckout[];
}

export function validateAppId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());
}
export function mergeBranches(remote: RemoteBranch[], local: LocalCheckout[]): CombinedBranch[] {
  const result = new Map<string, CombinedBranch>();
  for (const b of remote) {
    if (!b.name || result.has(b.name)) continue;
    result.set(b.name, { name: b.name, remote: b, local: [] });
  }
  for (const c of local) {
    const value = result.get(c.branch) ?? { name: c.branch, local: [] };
    value.local.push(c);
    result.set(c.branch, value);
  }
  return [...result.values()].sort((a, b) => {
    const groupA = a.local.length > 0 ? 0 : 1;
    const groupB = b.local.length > 0 ? 0 : 1;
    return groupA - groupB || a.name.localeCompare(b.name);
  });
}

export async function fetchRemoteBranches(appId: string, pat: string): Promise<RemoteBranch[]> {
  if (!validateAppId(appId)) throw new Error("Invalid Mendix app ID");
  if (!pat.trim()) throw new Error("Configure a PAT with mx:modelrepository:repo:read in Raycast preferences");
  const endpoint = `https://repository.api.mendix.com/v1/repositories/${encodeURIComponent(appId)}/branches`;
  const branches: RemoteBranch[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const url = new URL(endpoint);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, {
      headers: { Authorization: `MxToken ${pat}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const summary = response.status === 401 ? "invalid PAT or authorization scheme"
        : response.status === 403 ? "your Mendix account lacks access or the PAT lacks repo:read"
        : response.status === 404 ? "app/repository not found" : response.statusText;
      throw new Error(`Repository API ${response.status}: ${summary}`);
    }
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || !Array.isArray((data as { items?: unknown }).items)) {
      throw new Error("Unexpected branch API response");
    }
    for (const item of (data as { items: unknown[] }).items) {
      if (item && typeof item === "object" && typeof (item as RemoteBranch).name === "string") {
        branches.push(item as RemoteBranch);
      }
    }
    const next = (data as { cursors?: { next?: unknown } }).cursors?.next;
    if (typeof next !== "string" || !next || seen.has(next)) return branches;
    cursor = next;
    seen.add(next);
  }
  throw new Error("Remote branch list exceeded 100 pages; refusing incomplete results");
}

function repoAppId(remote: string): string | undefined {
  // Handles normal URL and URL-with-user-info forms without persisting credentials.
  const match = remote.match(/(?:https?:\/\/|ssh:\/\/|@)?git\.api\.mendix\.com[/:]([\da-f-]{36})(?:\.git)?\/?$/i);
  return match?.[1]?.toLowerCase();
}
function remoteFromConfig(config: string): string | undefined {
  let isOrigin = false;
  for (const line of config.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) { isOrigin = /^remote\s+"origin"$/i.test(section[1]); continue; }
    if (isOrigin) {
      const url = line.match(/^\s*url\s*=\s*(.*?)\s*$/i);
      if (url) return url[1];
    }
  }
  return undefined;
}
async function findGitDir(folder: string): Promise<string | undefined> {
  const dotGit = join(folder, ".git");
  try {
    const stat = await fs.stat(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (stat.isFile()) {
      const content = await fs.readFile(dotGit, "utf8");
      const match = content.match(/^gitdir:\s*(.+)\s*$/im);
      if (match) return isAbsolute(match[1]) ? match[1] : resolve(folder, match[1]);
    }
  } catch { /* Not a Git root. */ }
  return undefined;
}
async function getGitMeta(folder: string): Promise<{ branch: string; appId?: string; commit?: string } | undefined> {
  const gitdir = await findGitDir(folder);
  if (!gitdir) return undefined;
  try {
    const head = (await fs.readFile(join(gitdir, "HEAD"), "utf8")).trim();
    const symbolic = /^ref: refs\/heads\/(.+)$/.exec(head);
    const branch = symbolic?.[1] || `detached@${head.substring(0, 10)}`;
    // Worktrees may store remote origin only in their common git directory.
    let configPath = join(gitdir, "config");
    try {
      const commondir = (await fs.readFile(join(gitdir, "commondir"), "utf8")).trim();
      configPath = join(resolve(gitdir, commondir), "config");
    } catch { /* Normal checkout. */ }
    const config = await fs.readFile(configPath, "utf8").catch(() => "");
    return { branch, appId: repoAppId(remoteFromConfig(config) ?? ""), commit: symbolic ? undefined : head };
  } catch { return undefined; }
}

const SKIP = new Set([".git", ".idea", ".vs", "node_modules", "deployment", "javasource", "resources", "userlib", "theme", "themesource", "widgets", "vendor", "bin", "obj", ".gradle", "target", "dist", "build"]);
export async function findLocalCheckouts(app: MendixApp, defaultRoot: string): Promise<LocalCheckout[]> {
  const dedicated = Boolean(app.localRoot?.trim());
  const root = (app.localRoot || defaultRoot).trim();
  if (!root) return [];
  const results: LocalCheckout[] = [];
  const visited = new Set<string>();
  let foldersExamined = 0;
  async function walk(folder: string, depth: number): Promise<void> {
    if (depth > 3 || foldersExamined++ > 2000 || visited.has(folder.toLowerCase())) return;
    visited.add(folder.toLowerCase());
    let entries: Dirent[];
    try { entries = await fs.readdir(folder, { withFileTypes: true }); }
    catch { return; }
    const mprs = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".mpr"));
    if (mprs.length) {
      const git = await getGitMeta(folder);
      // Explicit app-specific root can also contain an unversioned/local-only project.
      if ((git?.appId === app.id.toLowerCase()) || (dedicated && !git?.appId)) {
        for (const f of mprs) {
          results.push({ branch: git?.branch ?? "unversioned", mprPath: join(folder, f.name), folder, commit: git?.commit });
        }
      }
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP.has(entry.name.toLowerCase()) || entry.name.startsWith(".")) continue;
      await walk(join(folder, entry.name), depth + 1);
    }
  }
  await walk(root, 0);
  return results;
}
/** Summarizes `git status --porcelain=v1 --branch`: uncommitted entries ("XY path"), commits ahead, and whether an upstream exists. */
export function summarizeGitStatus(output: string): { files: string[]; ahead: number; upstream: boolean } {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const head = lines[0]?.startsWith("## ") ? lines.shift() ?? "" : "";
  // "[gone]": the upstream branch was deleted on the server, so the branch now exists only locally.
  return { files: lines, ahead: Number(/\[ahead (\d+)/.exec(head)?.[1] ?? 0), upstream: head.includes("...") && !head.endsWith(" [gone]") };
}
export function safeCheckoutFolderName(app: MendixApp, branch: string): string {
  const clean = (s: string) => {
    const name = s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").slice(0, 65).replace(/[. ]+$/g, "") || "app";
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
  };
  return `${clean(app.name)}-${clean(branch)}`;
}
