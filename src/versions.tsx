import { Action, ActionPanel, Color, Icon, List, openExtensionPreferences } from "@raycast/api";
import { useEffect, useState } from "react";
import { dirname } from "node:path";
import { getConfig, launchStudioPro, runScoop } from "./launch";
import { useStudioProInstalls } from "./hooks";
import { ScoopCatalog, latestPatches, readScoopCatalog, release, sameRelease, scoopRoot } from "./studiopro";
import { AppList } from "./switch";

function ago(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  return days < 1 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

export default function Command() {
  const [refreshId, setRefreshId] = useState(0);
  const [show, setShow] = useState("latest");
  const { installs = [], loading } = useStudioProInstalls(refreshId);
  // Reading the bucket is a directory listing, fast enough to skip the cache.
  const [catalog, setCatalog] = useState<ScoopCatalog | null>();
  useEffect(() => { void readScoopCatalog().then((c) => setCatalog(c ?? null), () => setCatalog(null)); }, [refreshId]);
  const configured = getConfig().studioProExecutable?.trim().toLowerCase();
  const refresh = () => setRefreshId((n) => n + 1);
  const updateCatalog = catalog && <Action title="Update Scoop Catalog" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["ctrl"], key: "u" }} onAction={() => void runScoop("update")} />;
  const refreshAction = <Action title="Refresh" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["ctrl"], key: "r" }} onAction={refresh} />;

  const latest = latestPatches(catalog?.versions ?? []);
  const available = (catalog?.versions ?? [])
    .filter((v) => !installs.some((i) => sameRelease(i.version, v)))
    .filter((v) => show === "all" || latest.has(v));
  return (
    <List isLoading={loading || catalog === undefined} navigationTitle="Mendix Studio Pro Versions" searchBarPlaceholder="Search versions..."
      searchBarAccessory={catalog ? <List.Dropdown tooltip="Versions available via Scoop" storeValue onChange={setShow}>
        <List.Dropdown.Item title="Latest Patches" value="latest" />
        <List.Dropdown.Item title="All Versions" value="all" />
      </List.Dropdown> : undefined}>
      <List.EmptyView title={loading ? "Looking for Studio Pro…" : "No Studio Pro versions found"}
        description="Installed versions are read from the Windows uninstall registry and the default Mendix install folders." />
      <List.Section title="Installed" subtitle={String(installs.length)}>
        {installs.map((install) => (
          <List.Item key={install.executable} title={release(install.version)} subtitle={install.executable} icon={{ fileIcon: install.executable }}
            accessories={[
              ...(install.executable.toLowerCase() === configured ? [{ tag: { value: "Configured", color: Color.Green }, icon: Icon.Gear, tooltip: "Studio Pro Executable preference" }] : []),
              ...(catalog?.installed.includes(release(install.version)) ? [{ tag: "Scoop", tooltip: "Installed with Scoop" }] : []),
              install.scope === "user" ? { tag: "Current user", icon: Icon.Person } : { tag: "All users", icon: Icon.Desktop },
            ]}
            actions={<ActionPanel>
              <Action.Push title="Open a Branch with This Version" icon={{ fileIcon: install.executable }} target={<AppList studioPro={install} />} />
              <Action title="Launch Studio Pro" icon={Icon.AppWindow} onAction={() => void launchStudioPro(install.executable)} />
              <Action.Open title="Open Install Folder" icon={Icon.Folder} target={dirname(dirname(install.executable))} />
              <Action.CopyToClipboard title="Copy Executable Path" content={install.executable} />
              <Action.CopyToClipboard title="Copy Version" content={release(install.version)} shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }} />
              {updateCatalog}
              {refreshAction}
              <Action title="Open Settings" icon={Icon.Gear} onAction={() => void openExtensionPreferences()} />
            </ActionPanel>}
          />
        ))}
      </List.Section>
      {catalog === null && <List.Section title="Available via Scoop">
        <List.Item title="No Scoop catalog with Studio Pro found" subtitle={`Looked in ${scoopRoot()}\\buckets`}
          icon={{ source: Icon.QuestionMarkCircle, tintColor: Color.SecondaryText }}
          actions={<ActionPanel>
            <Action.CopyToClipboard title="Copy Bucket Setup Command" content="scoop bucket add mendix https://github.com/densmoe/scoop-mendix" />
            {refreshAction}
          </ActionPanel>} />
      </List.Section>}
      {catalog && <List.Section title={`Available via Scoop · ${catalog.bucket} bucket`}
        subtitle={`${available.length}${catalog.fetchedAt ? ` · catalog updated ${ago(catalog.fetchedAt)}` : ""}`}>
        {available.map((version) => {
          const app = `${catalog.bucket}/mendix-studio-pro-${version}`;
          return (
            <List.Item key={version} title={version} icon={{ source: Icon.Download, tintColor: Color.SecondaryText }}
              subtitle={show === "all" && latest.has(version) ? `Latest ${version.split(".").slice(0, 2).join(".")} patch` : undefined}
              accessories={[{ text: "Not installed" }]}
              actions={<ActionPanel>
                <Action title="Install with Scoop" icon={Icon.Download} onAction={() => void runScoop("install", app)} />
                {catalog.machine.includes(version) && <Action title="Install for All Users (Admin)" icon={Icon.Desktop}
                  onAction={() => void runScoop("install", `${app}-machine`)} />}
                <Action.CopyToClipboard title="Copy Install Command" content={`scoop install ${app}`} />
                {updateCatalog}
                {refreshAction}
              </ActionPanel>}
            />
          );
        })}
      </List.Section>}
    </List>
  );
}
