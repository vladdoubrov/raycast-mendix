import { Action, ActionPanel, Alert, Color, Icon, Image, List, Toast, confirmAlert, environment, showToast } from "@raycast/api";
import { useEffect, useState } from "react";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { MendixApp } from "./core";
import { OperationStatus, cacheDirectory, readOperations, terminalStates } from "./checkout";
import { cacheOperation, getConfig, openLocal, studioProIcon } from "./launch";

const STATE_ICONS: Record<string, Image.ImageLike> = {
  queued: Icon.Clock,
  running: { source: Icon.CircleProgress, tintColor: Color.Blue },
  completed: { source: Icon.CheckCircle, tintColor: Color.Green },
  failed: { source: Icon.XMarkCircle, tintColor: Color.Red },
  launch_failed: { source: Icon.XMarkCircle, tintColor: Color.Red },
  cancelled: { source: Icon.MinusCircle, tintColor: Color.SecondaryText },
  interrupted: { source: Icon.Warning, tintColor: Color.Orange },
};

export function Operations({ app }: { app: MendixApp }) {
  const [operations, setOperations] = useState<OperationStatus[]>([]);
  useEffect(() => {
    let mounted = true;
    const refresh = () => { void readOperations(environment.supportPath, app.id).then(rows => { if (mounted) setOperations(rows); }); };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { mounted = false; clearInterval(timer); };
  }, [app.id]);
  const removeCache = async () => {
    try {
      const path = cacheDirectory(app, getConfig());
      if (await confirmAlert({ title: "Remove this app's repository cache?", message: `${path}\nExisting checkouts remain usable. The next full checkout downloads or rebuilds the cache.`, primaryAction: { title: "Remove Cache", style: Alert.ActionStyle.Destructive } })) {
        await cacheOperation(app, "remove-cache");
      }
    } catch (error) { await showToast({ style: Toast.Style.Failure, title: "Cannot remove cache", message: String(error) }); }
  };
  return <List navigationTitle={`${app.name} · Checkout Operations`}>
    <List.Section title="Repository cache">
      <List.Item title="Refresh Full Repository Cache" subtitle="Fetch branches and Mendix metadata" icon={Icon.HardDrive}
        actions={<ActionPanel><Action title="Refresh Cache" icon={Icon.ArrowClockwise} onAction={() => void cacheOperation(app, "refresh-cache")} /><Action title="Remove Cache" icon={Icon.Trash} style={Action.Style.Destructive} onAction={() => void removeCache()} /></ActionPanel>} />
    </List.Section>
    <List.Section title="Recent operations" subtitle="Latest 20; status refreshes every 2 seconds">
      {operations.map(op => <List.Item key={op.operationId} title={op.branch || op.action}
        subtitle={`${op.action === "create-branch" ? "new branch · " : ""}${op.state} · ${op.stage}${op.strategy ? ` · ${op.strategy}` : ""}`}
        icon={{ value: STATE_ICONS[op.state] ?? Icon.Clock, tooltip: op.state }}
        accessories={[{ text: op.error ? op.error.slice(0, 100) : new Date(op.startedAt).toLocaleString() }]}
        actions={<ActionPanel>
          {op.ready && op.mprPath && <Action title="Open Checkout" icon={studioProIcon(op.mprPath)} onAction={() => void openLocal(op.mprPath!)} />}
          <Action.Open title="Open Operation Logs" icon={Icon.Document} target={op.directory} />
          <Action.CopyToClipboard title="Copy Operation Details" content={JSON.stringify(op, null, 2)} />
          {!terminalStates.has(op.state) && <Action title="Cancel Operation" icon={Icon.XMarkCircle} onAction={async () => {
            try { await fs.writeFile(join(op.directory, "cancel.request"), "cancel\n"); await showToast({ title: "Cancellation requested" }); }
            catch (error) { await showToast({ style: Toast.Style.Failure, title: "Could not cancel", message: String(error) }); }
          }} />}
        </ActionPanel>} />)}
    </List.Section>
  </List>;
}
