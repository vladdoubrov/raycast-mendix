import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Raycast's extension process may lack user variables such as USERPROFILE, so derive them from the profile folder.
const localAppData = () => process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");

export interface StudioProInstall {
  /** Full installed version, e.g. 10.24.28.129343. */
  version: string;
  executable: string;
  /** Per-user installs live under %LOCALAPPDATA%\Programs\Mendix; machine-wide ones under Program Files. */
  scope: "user" | "machine";
}

// Studio Pro installers (Inno Setup) register an uninstall entry per version; the Version Selector reads the same.
const UNINSTALL_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];
// Studio Pro 8+ ships studiopro.exe; Mendix 7 shipped Mendix.Modeler.exe.
const EXECUTABLE = /\\(studiopro|mendix\.modeler)\.exe$/i;

/** Parses `reg query <key> /s` output into Mendix Studio Pro entries; other Mendix tools (Version Selector, Native Builder) are skipped. */
export function parseUninstallEntries(output: string): { version: string; executable: string }[] {
  const results: { version: string; executable: string }[] = [];
  let values: Record<string, string> = {};
  const flush = () => {
    const executable = (values.DisplayIcon ?? "").replace(/^"|",?\d*$|,\d+$/g, "").trim();
    const version = (values.DisplayVersion ?? "").trim();
    if (/^mendix$/i.test(values.Publisher ?? "") && EXECUTABLE.test(executable) && /^\d+(\.\d+)+$/.test(version)) {
      results.push({ version, executable });
    }
    values = {};
  };
  for (const line of output.split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) { flush(); continue; }
    const value = line.match(/^\s+(.+?)\s{4}REG_\w+\s{4}(.*)$/);
    if (value) values[value[1]] = value[2];
  }
  flush();
  return results;
}

/** Numeric, component-wise comparison; missing components count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}
/** major.minor.patch without the build number, e.g. 10.24.28 for 10.24.28.129343. */
export const release = (version: string) => version.split(".").slice(0, 3).map(Number).join(".");
/** True when major.minor.patch agree; the build number differs between e.g. 10.24.28 and 10.24.28.129343. */
export const sameRelease = (a: string, b: string) => release(a) === release(b);

function regQuery(key: string): Promise<string> {
  // Raycast's PATH can be incomplete, so call reg.exe by its full path.
  const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
  return new Promise((resolve) => {
    execFile(reg, ["query", key, "/s"], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : stdout));
  });
}
async function scanDefaultFolders(): Promise<{ version: string; executable: string }[]> {
  const roots = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Mendix"),
    join(localAppData(), "Programs", "Mendix"),
  ];
  const results: { version: string; executable: string }[] = [];
  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && /^\d+(\.\d+)+$/.test(entry.name)) {
        results.push({ version: entry.name, executable: join(root, entry.name, "modeler", "studiopro.exe") });
      }
    }
  }
  return results;
}

export interface ScoopCatalog {
  bucket: string;
  /** Exact versions with a per-user manifest (mendix-studio-pro-x.y.z), newest first. */
  versions: string[];
  /** Versions that also have a machine-scope (-machine) manifest. */
  machine: string[];
  /** Releases currently installed through Scoop, including via floating aliases like mendix-studio-pro-10.24. */
  installed: string[];
  /** When the bucket was last fetched (`scoop update`), if known. */
  fetchedAt?: number;
}
const MANIFEST = /^mendix-studio-pro-(\d+\.\d+\.\d+)(-machine)?\.json$/i;
export const scoopRoot = () => process.env.SCOOP || join(homedir(), "scoop");

/** Reads the Scoop bucket that holds Studio Pro manifests (preferring one named "mendix"); undefined without Scoop or such a bucket. */
export async function readScoopCatalog(root = scoopRoot()): Promise<ScoopCatalog | undefined> {
  const buckets = (await fs.readdir(join(root, "buckets"), { withFileTypes: true }).catch(() => []))
    .filter((b) => b.isDirectory()).map((b) => b.name).sort((a, b) => Number(b === "mendix") - Number(a === "mendix"));
  for (const bucket of buckets) {
    const names = await fs.readdir(join(root, "buckets", bucket, "bucket")).catch(() => [] as string[]);
    const matches = names.map((n) => MANIFEST.exec(n)).filter((m): m is RegExpExecArray => m !== null);
    const versions = matches.filter((m) => !m[2]).map((m) => m[1]).sort((a, b) => compareVersions(b, a));
    if (!versions.length) continue;
    // Scoop keeps each app's installed versions as subfolders next to the "current" link.
    const apps = (await fs.readdir(join(root, "apps")).catch(() => [] as string[])).filter((a) => /^mendix-studio-pro(-[\d.]+)?(-machine)?$/i.test(a));
    const installed = (await Promise.all(apps.map((a) => fs.readdir(join(root, "apps", a)).catch(() => [] as string[])))).flat()
      .filter((v) => /^\d+(\.\d+)+$/.test(v)).map(release);
    const fetchedAt = await fs.stat(join(root, "buckets", bucket, ".git", "FETCH_HEAD")).then((s) => s.mtimeMs, () => undefined);
    return { bucket, versions, machine: matches.filter((m) => m[2]).map((m) => m[1]), installed: [...new Set(installed)], fetchedAt };
  }
  return undefined;
}

/** The newest patch of each major.minor, e.g. 10.24.28 for 10.24.x. */
export function latestPatches(versions: string[]): Set<string> {
  const newest = new Map<string, string>();
  for (const v of versions) {
    const minor = v.split(".").slice(0, 2).join(".");
    const current = newest.get(minor);
    if (!current || compareVersions(v, current) > 0) newest.set(minor, v);
  }
  return new Set(newest.values());
}

/** All installed Studio Pro versions, newest first. */
export async function listStudioProInstalls(): Promise<StudioProInstall[]> {
  const registry = (await Promise.all(UNINSTALL_KEYS.map(regQuery))).flatMap(parseUninstallEntries);
  // The folder scan catches installs whose uninstall entry is missing; registry entries win on duplicates.
  const candidates = [...registry, ...await scanDefaultFolders()];
  const userRoot = localAppData().toLowerCase();
  const byPath = new Map<string, StudioProInstall>();
  for (const { version, executable } of candidates) {
    const key = executable.toLowerCase();
    if (byPath.has(key) || !await fs.access(executable).then(() => true, () => false)) continue;
    byPath.set(key, { version, executable, scope: userRoot && key.startsWith(userRoot) ? "user" : "machine" });
  }
  return [...byPath.values()].sort((a, b) => compareVersions(b.version, a.version));
}
