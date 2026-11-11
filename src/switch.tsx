import { Action, ActionPanel, Color, Icon, Keyboard, List, Toast, openExtensionPreferences, showToast } from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import { CombinedBranch, LocalCheckout, MendixApp, RemoteBranch, fetchRemoteBranches, findLocalCheckouts, mergeBranches } from "./core";
import { GitChangesView } from "./git-changes";
import { useStudioProInstalls } from "./hooks";
import { assistedCheckout, cloneAndOpen, cloneAndOpenTerminal, cloneOnly, deleteLocalCheckout, getConfig, openLocal, openTerminal, studioProIcon } from "./launch";
import { AppForm, ManageApps, appIcon } from "./manage-apps";
import { Operations } from "./operations";
import { JiraIssue, JiraStatusCategory, fetchJiraIssues, issueKeyFromBranch, jiraIssueUrl, jiraSettings } from "./jira";
import { getApps, getCachedJiraIssues, getCachedLocal, getCachedRemote, mergeCachedJiraIssues, setCachedLocal, setCachedRemote } from "./storage";
import { StudioProInstall, release, sameRelease } from "./studiopro";

const issueMap = (issues: JiraIssue[]) => new Map(issues.map((i) => [i.key, i]));
const statusColor: Record<JiraStatusCategory, Color> = { new: Color.SecondaryText, indeterminate: Color.Blue, done: Color.Green };
type JiraFilter = "all" | "open" | "done";

/** With `studioPro`, opening and cloning use that version (reached from the Studio Pro Versions command). */
function Branches({ app, studioPro }: { app: MendixApp; studioPro?: StudioProInstall }) {
  const config = getConfig();
  const localRoot = (app.localRoot || config.projectsRoot || "").trim();
  // Start from the saved lists; the effect below refreshes them in the background.
  const [local, setLocal] = useState<LocalCheckout[]>(() => getCachedLocal(app.id, localRoot)?.items ?? []);
  const [remote, setRemote] = useState<RemoteBranch[]>(() => getCachedRemote(app.id)?.items ?? []);
  const [loadingLocal, setLoadingLocal] = useState(true);
  const [loadingRemote, setLoadingRemote] = useState(true);
  const [remoteError, setRemoteError] = useState("");
  const [refreshId, setRefreshId] = useState(0);
  // Undefined until cached or scanned, so the version accessory does not flash "not installed".
  const { installs } = useStudioProInstalls(refreshId);
  useEffect(() => {
    let mounted = true;
    setLoadingLocal(true);
    setLoadingRemote(true);
    setRemoteError("");
    void findLocalCheckouts(app, config.projectsRoot ?? "").then((found) => {
      setCachedLocal(app.id, localRoot, found);
      if (mounted) setLocal(found);
    }).catch((e) => { if (mounted) void showToast({ style: Toast.Style.Failure, title: "Local scan failed", message: String(e) }); })
      .finally(() => { if (mounted) setLoadingLocal(false); });
    void fetchRemoteBranches(app.id, config.personalAccessToken ?? "").then((found) => {
      setCachedRemote(app.id, found);
      if (mounted) { setRemote(found); setRemoteError(""); }
    // On failure keep the saved list: it is still the best answer, and the error is shown above it.
    }).catch((e) => { if (mounted) setRemoteError(String(e instanceof Error ? e.message : e)); })
      .finally(() => { if (mounted) setLoadingRemote(false); });
    return () => { mounted = false; };
  }, [app.id, localRoot, refreshId]);
  const combined = useMemo(() => mergeBranches(remote, local), [remote, local]);
  // Jira is optional: without site, email and token there are no issue lookups, columns or actions.
  const jira = jiraSettings(config);
  const projectKeysPref = jira?.projectKeys.join(",") ?? "";
  const issueKeyOf = (branch: CombinedBranch) => jira ? issueKeyFromBranch(branch.name, jira.projectKeys) : undefined;
  const [issues, setIssues] = useState(() => issueMap(jira ? getCachedJiraIssues(jira.siteUrl) : []));
  const [loadingJira, setLoadingJira] = useState(false);
  const [jiraFilter, setJiraFilter] = useState<JiraFilter>("all");
  const issueKeys = useMemo(() => [...new Set(combined.map(issueKeyOf).filter((k): k is string => !!k))].sort(),
    [combined, jira?.siteUrl, projectKeysPref]);
  const issueKeysJoined = issueKeys.join(",");
  useEffect(() => {
    // Wait for both branch scans so one request covers the final list; the cached issues show meanwhile.
    if (!jira || loadingLocal || loadingRemote || !issueKeys.length) return;
    let mounted = true;
    setLoadingJira(true);
    void fetchJiraIssues(jira, issueKeys).then((found) => {
      const all = mergeCachedJiraIssues(jira.siteUrl, issueKeys, found);
      if (mounted) setIssues(issueMap(all));
    }).catch((e) => {
      if (mounted) void showToast({ style: Toast.Style.Failure, title: "Could not refresh Jira issues", message: String(e instanceof Error ? e.message : e) });
    }).finally(() => { if (mounted) setLoadingJira(false); });
    return () => { mounted = false; setLoadingJira(false); };
  }, [issueKeysJoined, loadingLocal, loadingRemote, jira?.siteUrl, refreshId]);
  const issueOf = (branch: CombinedBranch) => { const key = issueKeyOf(branch); return key ? issues.get(key) : undefined; };
  const shown = jira && jiraFilter !== "all"
    ? combined.filter((b) => (issueOf(b)?.statusCategory === "done") === (jiraFilter === "done"))
    : combined;
  const localBranches = shown.filter((b) => b.local.length > 0);
  const remoteOnly = shown.filter((b) => b.local.length === 0 && b.remote);
  const chosen = studioPro && `Studio Pro ${release(studioPro.version)}`;
  // Like the Version Selector: the install matching the branch's Mendix version first, then newest first.
  const installsFor = (branch: CombinedBranch) => {
    const mx = branch.remote?.latestCommit?.mendixVersion;
    return mx ? [...installs ?? []].sort((a, b) => Number(sameRelease(b.version, mx)) - Number(sameRelease(a.version, mx))) : installs ?? [];
  };
  const versionTitle = (install: StudioProInstall, branch: CombinedBranch) => {
    const mx = branch.remote?.latestCommit?.mendixVersion;
    return `Studio Pro ${release(install.version)}${mx && sameRelease(install.version, mx) ? " (Branch Version)" : ""}`;
  };
  // Functional update: the Git changes view calls this later, when `local` may have been rescanned.
  const forgetLocal = (checkout: LocalCheckout) => setLocal((current) => {
    const remaining = current.filter((c) => c.folder !== checkout.folder);
    setCachedLocal(app.id, localRoot, remaining);
    return remaining;
  });
  const removeLocal = async (checkout: LocalCheckout) => { if (await deleteLocalCheckout(app, checkout)) forgetLocal(checkout); };
  const copyLabel = (branch: CombinedBranch, index: number) => branch.local.length > 1 ? `Local Copy ${index + 1}` : "";
  const actions = (branch: CombinedBranch) => (
    <ActionPanel>
      {branch.local.map((checkout, index) => (
        <Action key={checkout.mprPath} icon={studioPro ? { fileIcon: studioPro.executable } : studioProIcon(checkout.mprPath)}
          title={`Open${copyLabel(branch, index) ? ` ${copyLabel(branch, index)}` : ""} in ${chosen ?? "Studio Pro"}`}
          onAction={() => void openLocal(checkout.mprPath, studioPro?.executable)} />
      ))}
      {installs?.length ? branch.local.map((checkout, index) => (
        <ActionPanel.Submenu key={`with:${checkout.mprPath}`} icon={{ fileIcon: installsFor(branch)[0].executable }}
          title={`Open${copyLabel(branch, index) ? ` ${copyLabel(branch, index)}` : ""} With…`}
          shortcut={index === 0 ? { modifiers: ["ctrl", "shift"], key: "o" } : undefined}>
          {installsFor(branch).map((install) => (
            <Action key={install.executable} icon={{ fileIcon: install.executable }} title={versionTitle(install, branch)}
              onAction={() => void openLocal(checkout.mprPath, install.executable)} />
          ))}
        </ActionPanel.Submenu>
      )) : null}
      {branch.local.map((checkout, index) => (
        <Action key={`terminal:${checkout.folder}`} title={`Open${copyLabel(branch, index) ? ` ${copyLabel(branch, index)}` : ""} in Terminal`}
          icon={Icon.Terminal} shortcut={index === 0 ? { modifiers: ["ctrl"], key: "t" } : undefined}
          onAction={() => void openTerminal(checkout.folder)} />
      ))}
      {/* First action for a remote-only branch, so Enter clones it. */}
      {branch.remote && <Action title={`Clone and Open in ${chosen ?? "Studio Pro"}`} icon={Icon.Download}
        onAction={() => void cloneAndOpen(app, branch.name, undefined, studioPro?.executable)} />}
      {branch.remote && installs?.length ? (
        <ActionPanel.Submenu title="Clone and Open With…" icon={Icon.Download}
          shortcut={branch.local.length ? undefined : { modifiers: ["ctrl", "shift"], key: "o" }}>
          {installsFor(branch).map((install) => (
            <Action key={install.executable} icon={{ fileIcon: install.executable }} title={versionTitle(install, branch)}
              onAction={() => void cloneAndOpen(app, branch.name, undefined, install.executable)} />
          ))}
        </ActionPanel.Submenu>
      ) : null}
      {branch.remote && <Action title="Clone and Open in Terminal" icon={Icon.Terminal}
        shortcut={branch.local.length ? undefined : { modifiers: ["ctrl"], key: "t" }}
        onAction={() => void cloneAndOpenTerminal(app, branch.name)} />}
      {branch.remote && <Action title="Clone Only (Don't Open)" icon={Icon.NewFolder} onAction={() => void cloneOnly(app, branch.name)} />}
      {branch.remote && <Action title="Clone with Full History" icon={Icon.Layers} onAction={() => void cloneAndOpen(app, branch.name, "full", studioPro?.executable)} />}
      {branch.remote && <Action title="Partial Clone (On-Demand Files)" icon={Icon.Bolt} onAction={() => void cloneAndOpen(app, branch.name, "partial", studioPro?.executable)} />}
      {branch.remote && <Action title="Download via Studio Pro (Assisted)" icon={studioProIcon()}
        onAction={() => void assistedCheckout(app, branch.name)} />}
      <Action.CopyToClipboard title="Copy Branch Name" content={branch.name} />
      {jira && issueKeyOf(branch) && <Action.OpenInBrowser title={`Open ${issueKeyOf(branch)} in Jira`} icon={Icon.Link}
        url={jiraIssueUrl(jira.siteUrl, issueKeyOf(branch)!)} shortcut={{ modifiers: ["ctrl"], key: "j" }} />}
      {jira && issueKeyOf(branch) && <Action.CopyToClipboard title="Copy Issue Key" content={issueKeyOf(branch)!} />}
      <Action.Push title="View Checkout Operations" icon={Icon.Terminal} target={<Operations app={app} />} />
      {branch.local.length > 0 && <Action.CopyToClipboard title="Copy Local Project Path" content={branch.local[0].mprPath} />}
      {branch.local.map((checkout, index) => (
        <Action.Push key={`changes:${checkout.folder}`} title={`Show Git Changes${copyLabel(branch, index) ? ` (${copyLabel(branch, index)})` : ""}`}
          icon={Icon.List} shortcut={index === 0 ? { modifiers: ["ctrl"], key: "g" } : undefined}
          target={<GitChangesView app={app} checkout={checkout} onDeleted={() => forgetLocal(checkout)} />} />
      ))}
      {branch.local.map((checkout, index) => (
        <Action key={`delete:${checkout.folder}`} title={`Delete ${copyLabel(branch, index) || "Local Copy"}…`} icon={Icon.Trash}
          style={Action.Style.Destructive} shortcut={index === 0 ? Keyboard.Shortcut.Common.Remove : undefined}
          onAction={() => void removeLocal(checkout)} />
      ))}
      <Action title="Refresh Local and Remote Branches" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["ctrl"], key: "r" }} onAction={() => setRefreshId((n) => n + 1)} />
      <Action title="Open Settings" icon={Icon.Gear} onAction={() => void openExtensionPreferences()} />
    </ActionPanel>
  );
  const versionAccessory = (mx: string): List.Item.Accessory => {
    const ok = (tooltip: string) => ({ icon: { source: Icon.CheckCircle, tintColor: Color.Green }, text: `MX ${release(mx)}`, tooltip });
    const warn = (tooltip: string) => ({ icon: { source: Icon.Warning, tintColor: Color.Orange }, text: { value: `MX ${release(mx)}`, color: Color.Orange }, tooltip });
    // With a chosen version, the question is whether the branch matches it, not whether any install does.
    if (studioPro) return sameRelease(studioPro.version, mx) ? ok(`Matches ${chosen}`) : warn(`Differs from ${chosen}`);
    if (installs === undefined) return { text: `MX ${release(mx)}` };
    return installs.some((i) => sameRelease(i.version, mx)) ? ok("Studio Pro version installed") : warn("This Studio Pro version is not installed");
  };
  // Where the branch exists: both, only on this PC, or only on Team Server.
  const branchIcon = (branch: CombinedBranch) =>
    branch.local.length && branch.remote ? { value: { source: Icon.Folder, tintColor: Color.Green }, tooltip: "Local and remote" }
      : branch.local.length ? { value: { source: Icon.HardDrive, tintColor: Color.SecondaryText }, tooltip: "Local only" }
      : { value: { source: Icon.Cloud, tintColor: Color.Blue }, tooltip: "Remote only" };
  const issueAccessory = (issue: JiraIssue): List.Item.Accessory => ({
    tag: { value: issue.status, color: statusColor[issue.statusCategory] },
    tooltip: [issue.key, issue.issueType, issue.assignee ? `Assignee: ${issue.assignee}` : "Unassigned"].filter(Boolean).join(" · "),
  });
  const item = (branch: CombinedBranch) => {
    const issue = issueOf(branch);
    // Where the branch lives is shown by the section and icon; only a count above one adds information.
    const copies = branch.local.length > 1 ? `${branch.local.length} local copies` : undefined;
    return <List.Item
      key={branch.name}
      title={branch.name}
      subtitle={issue?.summary || copies}
      icon={branchIcon(branch)}
      keywords={[app.name, app.id, branch.remote?.latestCommit?.message ?? "", ...(issue ? [issue.key, issue.summary, issue.status, issue.assignee ?? ""] : [])]}
      accessories={[
        ...(issue ? [issueAccessory(issue)] : []),
        ...(branch.remote?.latestCommit?.mendixVersion ? [versionAccessory(branch.remote.latestCommit.mendixVersion)] : []),
        // With an issue summary in the subtitle, the copy count moves here.
        ...(issue?.summary && copies ? [{ icon: Icon.HardDrive, text: String(branch.local.length), tooltip: copies }] : []),
      ]}
      actions={actions(branch)}
    />;
  };
  return (
    <List isLoading={loadingLocal || loadingRemote || loadingJira} navigationTitle={`${app.name} · Branches${chosen ? ` · ${chosen}` : ""}`}
      searchBarPlaceholder={jira ? "Search branches, commit messages or Jira issues..." : "Search branches or commit messages..."}
      searchBarAccessory={jira ? (
        <List.Dropdown tooltip="Filter by Jira status" storeValue onChange={(v) => setJiraFilter(v as JiraFilter)}>
          <List.Dropdown.Item title="All Branches" value="all" />
          <List.Dropdown.Item title="Not Done in Jira" value="open" />
          <List.Dropdown.Item title="Done in Jira" value="done" />
        </List.Dropdown>
      ) : undefined}>
      <List.EmptyView title={loadingLocal || loadingRemote ? "Loading branches…" : "No branches found"}
        description={remoteError || (config.projectsRoot || app.localRoot ? "Check the Git origin and local folder settings." : "Set a Projects Root and a Mendix PAT in extension settings.")}
        actions={<ActionPanel><Action title="Refresh Branches" onAction={() => setRefreshId((n) => n + 1)} /><Action title="Open Settings" onAction={() => void openExtensionPreferences()} /></ActionPanel>} />
      {remoteError && <List.Section title="Remote API status">
        <List.Item title={remote.length ? "Could not refresh remote branches; showing the saved list" : "Remote branches unavailable"}
          subtitle={remoteError} icon={Icon.ExclamationMark}
          actions={<ActionPanel><Action title="Open Settings" onAction={() => void openExtensionPreferences()} /><Action title="Retry" onAction={() => setRefreshId((n) => n + 1)} /></ActionPanel>} />
      </List.Section>}
      {localBranches.length > 0 && <List.Section title="Available locally" subtitle={`${localBranches.length} branches`}>
        {localBranches.map(item)}
      </List.Section>}
      {remoteOnly.length > 0 && <List.Section title="Remote only" subtitle={`${remoteOnly.length} branches`}>
        {remoteOnly.map(item)}
      </List.Section>}
    </List>
  );
}

/** The app picker; with `studioPro`, the branches it opens use that version. */
export function AppList({ studioPro }: { studioPro?: StudioProInstall }) {
  const [apps, setApps] = useState<MendixApp[]>([]);
  const [loading, setLoading] = useState(true);
  const refreshApps = async () => {
    try { setApps(await getApps()); }
    catch (e) { await showToast({ style: Toast.Style.Failure, title: "Could not read saved apps", message: String(e) }); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refreshApps(); }, []);
  return (
    <List isLoading={loading} navigationTitle={studioPro ? `Open with Studio Pro ${release(studioPro.version)}` : "Open Mendix Branch"} searchBarPlaceholder="Search your Mendix apps...">
      <List.EmptyView title="No Mendix apps yet" description="Configure the apps you want to switch between manually."
        actions={<ActionPanel><Action.Push title="Add Mendix App" icon={Icon.Plus} target={<AppForm onSaved={() => void refreshApps()} />} /><Action title="Open Settings" onAction={() => void openExtensionPreferences()} /></ActionPanel>} />
      {apps.map((app) => (
        <List.Item key={app.id} title={app.name} subtitle={app.id} icon={appIcon(app)}
          actions={<ActionPanel>
            <Action.Push title="Show Branches" icon={Icon.Folder} target={<Branches app={app} studioPro={studioPro} />} />
            <Action.Push title="View Checkout Operations" icon={Icon.Terminal} target={<Operations app={app} />} />
            <Action.Push title="Manage Apps" icon={Icon.Gear} target={<ManageApps onSaved={() => void refreshApps()} />} />
            <Action.Push title="Add Mendix App" icon={Icon.Plus} target={<AppForm onSaved={() => void refreshApps()} />} />
            <Action.CopyToClipboard title="Copy App ID" content={app.id} />
            <Action title="Open Settings" icon={Icon.Gear} onAction={() => void openExtensionPreferences()} />
          </ActionPanel>}
        />
      ))}
    </List>
  );
}

export default function Command() {
  return <AppList />;
}
