import { Action, ActionPanel, Alert, Form, Icon, Image, List, Toast, confirmAlert, showToast, useNavigation } from "@raycast/api";
import { useEffect, useState } from "react";
import { win32 } from "node:path";
import { MendixApp, validateAppId } from "./core";
import { getApps, saveApps } from "./storage";

type AppFormValues = { name: string; id: string; localRoot?: string };

// Muted mid tones that keep white initials readable in light and dark themes.
const AVATAR_COLORS = ["#A8625C", "#A9744E", "#8C7A45", "#5E8466", "#4F8284", "#5873A0", "#76689A", "#93627E"];
/** Initials on a colour that is stable per app ID, so apps are told apart at a glance. */
export function appIcon(app: MendixApp): Image.ImageLike {
  const initials = app.name.trim().split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
  const text = initials.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const hash = [...app.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="${AVATAR_COLORS[hash % AVATAR_COLORS.length]}"/>`
    + `<text x="32" y="32" dy=".35em" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="${initials.length > 1 ? 26 : 32}" font-weight="600" fill="#fff">${text}</text></svg>`;
  return { source: `data:image/svg+xml,${encodeURIComponent(svg)}` };
}

export function AppForm({ initial, onSaved }: { initial?: MendixApp; onSaved: () => void }) {
  const { pop } = useNavigation();
  const [nameError, setNameError] = useState<string>();
  const [idError, setIdError] = useState<string>();
  const [localRootError, setLocalRootError] = useState<string>();
  const submit = async (input: AppFormValues) => {
    const name = input.name.trim();
    const id = input.id.trim().toLowerCase();
    const localRoot = input.localRoot?.trim();
    if (!name) { setNameError("Enter an app name"); return; }
    if (!validateAppId(id)) { setIdError("Enter the Mendix Project ID (UUID), not App name"); return; }
    if (localRoot && !win32.isAbsolute(localRoot)) {
      setLocalRootError("Enter an absolute Windows path (for example C:\\Mendix\\MyApp)"); return;
    }
    const apps = await getApps();
    if (!initial && apps.some((a) => a.id.toLowerCase() === id)) {
      setIdError("This app is already in the switcher"); return;
    }
    const updated: MendixApp = { id, name, ...(localRoot ? { localRoot } : {}) };
    await saveApps(initial ? apps.map((a) => (a.id === initial.id ? updated : a)) : [...apps, updated]);
    onSaved();
    await showToast({ style: Toast.Style.Success, title: initial ? "App updated" : "App added", message: name });
    pop();
  };
  return (
    <Form
      navigationTitle={initial ? "Edit Mendix App" : "Add Mendix App"}
      actions={<ActionPanel><Action.SubmitForm title={initial ? "Save Changes" : "Add App"} onSubmit={submit} /></ActionPanel>}
    >
      <Form.TextField id="name" title="Name" placeholder="My App" defaultValue={initial?.name} error={nameError} onChange={() => setNameError(undefined)} />
      <Form.TextField id="id" title="Mendix Project ID" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" defaultValue={initial?.id} error={idError} onChange={() => setIdError(undefined)} />
      <Form.TextField id="localRoot" title="Dedicated Local Root" placeholder="Optional, e.g. C:\\Mendix\\MyApp" defaultValue={initial?.localRoot} error={localRootError} onChange={() => setLocalRootError(undefined)} />
      <Form.Description text="Find the Project ID in Mendix Developer Portal → app Settings → General. A dedicated local root is optional; otherwise checkouts are discovered under the global Projects Root using the Git remote's app ID." />
    </Form>
  );
}

export function ManageApps({ onSaved }: { onSaved?: () => void }) {
  const [apps, setApps] = useState<MendixApp[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = async () => { setApps(await getApps()); setLoading(false); onSaved?.(); };
  useEffect(() => { void refresh(); }, []);
  const remove = async (app: MendixApp) => {
    const ok = await confirmAlert({
      title: `Remove ${app.name} from Raycast?`,
      message: "Only the saved app entry will be removed. No local folders or remote branches will be deleted.",
      primaryAction: { title: "Remove App", style: Alert.ActionStyle.Destructive },
    });
    if (!ok) return;
    await saveApps((await getApps()).filter((a) => a.id !== app.id));
    await refresh();
  };
  return (
    <List isLoading={loading} searchBarPlaceholder="Search configured Mendix apps..." navigationTitle="Manage Mendix Apps">
      <List.EmptyView title="No apps configured" description="Add a Mendix app manually to see its Team Server branches" actions={<ActionPanel><Action.Push title="Add App" icon={Icon.Plus} target={<AppForm onSaved={() => void refresh()} />} /></ActionPanel>} />
      {apps.map((app) => (
        <List.Item key={app.id} title={app.name} subtitle={app.id} icon={appIcon(app)}
          actions={<ActionPanel>
            <Action.Push title="Edit App" icon={Icon.Pencil} target={<AppForm initial={app} onSaved={() => void refresh()} />} />
            <Action.Push title="Add App" icon={Icon.Plus} target={<AppForm onSaved={() => void refresh()} />} />
            <Action title="Remove App" icon={Icon.Trash} style={Action.Style.Destructive} onAction={() => void remove(app)} />
          </ActionPanel>}
        />
      ))}
    </List>
  );
}
export default function Command() { return <ManageApps />; }
