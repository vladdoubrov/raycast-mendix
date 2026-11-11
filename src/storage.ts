import { Cache, LocalStorage } from "@raycast/api";
import { LocalCheckout, MendixApp, RemoteBranch, validateAppId } from "./core";
import { JiraIssue } from "./jira";
import { StudioProInstall } from "./studiopro";
const KEY = "mendix-apps-v1";
export async function getApps(): Promise<MendixApp[]> {
  const raw = await LocalStorage.getItem<string>(KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is MendixApp => p && typeof p === "object" && typeof p.name === "string" && typeof p.id === "string" && validateAppId(p.id));
  } catch { return []; }
}
export async function saveApps(apps: MendixApp[]): Promise<void> {
  await LocalStorage.setItem(KEY, JSON.stringify(apps));
}

// Branch lists change rarely and the Repository API is slow, so the last result is kept in Raycast's
// on-disk Cache: the list shows instantly and is refreshed in the background.
const branchCache = new Cache();
export type Cached<T> = { updatedAt: number; items: T[] };
function readCached<T>(key: string): Cached<T> | undefined {
  const raw = branchCache.get(key);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Cached<T>;
    return Array.isArray(parsed?.items) ? parsed : undefined;
  } catch { return undefined; }
}
const remoteKey = (appId: string) => `remote-branches:${appId}`;
// Local results depend on the folder scanned, so a changed root does not show stale checkouts.
const localKey = (appId: string, root: string) => `local-checkouts:${appId}:${root.toLowerCase()}`;
export const getCachedRemote = (appId: string) => readCached<RemoteBranch>(remoteKey(appId));
export const setCachedRemote = (appId: string, items: RemoteBranch[]) =>
  branchCache.set(remoteKey(appId), JSON.stringify({ updatedAt: Date.now(), items }));
export const getCachedLocal = (appId: string, root: string) => readCached<LocalCheckout>(localKey(appId, root));
export const setCachedLocal = (appId: string, root: string, items: LocalCheckout[]) =>
  branchCache.set(localKey(appId, root), JSON.stringify({ updatedAt: Date.now(), items }));
// Jira issues by site, shared by all apps; merged so one app's refresh keeps another app's issues.
const jiraKey = (siteUrl: string) => `jira-issues:${siteUrl.toLowerCase()}`;
export const getCachedJiraIssues = (siteUrl: string) => readCached<JiraIssue>(jiraKey(siteUrl))?.items ?? [];
/** Replaces the entries for `requested` keys: fetched ones are updated, missing ones dropped. */
export function mergeCachedJiraIssues(siteUrl: string, requested: string[], fetched: JiraIssue[]): JiraIssue[] {
  const asked = new Set(requested);
  const items = [...getCachedJiraIssues(siteUrl).filter((i) => !asked.has(i.key)), ...fetched];
  branchCache.set(jiraKey(siteUrl), JSON.stringify({ updatedAt: Date.now(), items }));
  return items;
}
// Installed Studio Pro versions rarely change; the registry scan refreshes this in the background.
const installsKey = "studiopro-installs";
export const getCachedInstalls = () => readCached<StudioProInstall>(installsKey);
export const setCachedInstalls = (items: StudioProInstall[]) =>
  branchCache.set(installsKey, JSON.stringify({ updatedAt: Date.now(), items }));
