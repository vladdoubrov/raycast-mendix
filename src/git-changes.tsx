import { Action, ActionPanel, Color, Detail, Icon, Keyboard, useNavigation } from "@raycast/api";
import { useEffect, useState } from "react";
import { LocalCheckout, MendixApp } from "./core";
import { GitChanges as Changes, UNPUSHED_LIMIT, deleteLocalCheckout, gitWarnings, openLocal, readGitChanges, studioProIcon } from "./launch";

const FILE_LIMIT = 200;
const LABELS: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", U: "Conflict", T: "Type changed" };
/** Porcelain "XY path": X is the index, Y the working tree. */
function describe(line: string): { status: string; path: string } {
  const xy = line.slice(0, 2), path = line.slice(3);
  if (xy === "??") return { status: "Untracked", path };
  const code = xy.trim()[0] ?? "";
  return { status: `${LABELS[code] ?? code}${xy[0] !== " " && xy[0] !== "?" ? " (staged)" : ""}`, path };
}
const cell = (text: string) => text.replace(/\|/g, "\\|");

function markdown(checkout: LocalCheckout, changes: Changes): string {
  const parts = [`# ${checkout.branch}`, `\`${checkout.folder}\``];
  if (changes.kind !== "git") return [...parts, `> ⚠ ${gitWarnings(changes)[0]}`].join("\n\n");
  const { files, unpushed } = changes;
  if (!files.length && !unpushed.length) parts.push("No uncommitted changes and no unpushed commits: nothing is lost by deleting this copy.");
  if (files.length) {
    const rows = files.slice(0, FILE_LIMIT).map(describe).map(({ status, path }) => `| ${status} | \`${cell(path)}\` |`);
    parts.push(`## Uncommitted changes (${files.length})`, ["| Status | File |", "|---|---|", ...rows].join("\n"),
      ...(files.length > FILE_LIMIT ? [`…and ${files.length - FILE_LIMIT} more.`] : []));
  }
  if (unpushed.length) {
    parts.push(`## Commits not on any remote (${unpushed.length >= UNPUSHED_LIMIT ? `${UNPUSHED_LIMIT}+` : unpushed.length})`,
      unpushed.map((line) => { const [sha, ...message] = line.split(" "); return `- \`${sha}\` ${message.join(" ")}`; }).join("\n"));
  }
  return parts.join("\n\n");
}

/** What deleting a local copy would lose: uncommitted files and commits that exist on no remote. */
export function GitChangesView({ app, checkout, onDeleted }: { app: MendixApp; checkout: LocalCheckout; onDeleted: () => void }) {
  const { pop } = useNavigation();
  const [changes, setChanges] = useState<Changes>();
  const [refreshId, setRefreshId] = useState(0);
  useEffect(() => {
    let mounted = true;
    setChanges(undefined);
    void readGitChanges(checkout.folder).then((found) => { if (mounted) setChanges(found); });
    return () => { mounted = false; };
  }, [checkout.folder, refreshId]);
  const warnings = changes ? gitWarnings(changes) : [];
  return (
    <Detail isLoading={!changes} navigationTitle={`${checkout.branch} · Git Changes`} markdown={changes ? markdown(checkout, changes) : `# ${checkout.branch}\n\nReading Git status…`}
      metadata={changes && <Detail.Metadata>
        <Detail.Metadata.TagList title="Safe to delete">
          <Detail.Metadata.TagList.Item text={warnings.length ? "Review first" : "Yes"} color={warnings.length ? Color.Orange : Color.Green} />
        </Detail.Metadata.TagList>
        {changes.kind === "git" && <Detail.Metadata.Label title="Uncommitted changes" text={String(changes.files.length)} />}
        {changes.kind === "git" && <Detail.Metadata.Label title="Unpushed commits" text={changes.unpushed.length >= UNPUSHED_LIMIT ? `${UNPUSHED_LIMIT}+` : String(changes.unpushed.length)} />}
        {changes.kind === "git" && <Detail.Metadata.Label title="Upstream" text={changes.upstream ? "Set" : "None"} />}
        <Detail.Metadata.Separator />
        <Detail.Metadata.Link title="Folder" text={checkout.folder} target={checkout.folder} />
      </Detail.Metadata>}
      actions={<ActionPanel>
        {/* Enter stays harmless; deleting needs Ctrl+X and the confirmation. */}
        <Action title="Open in Studio Pro" icon={studioProIcon(checkout.mprPath)} onAction={() => void openLocal(checkout.mprPath)} />
        <Action.Open title="Open Folder" icon={Icon.Folder} target={checkout.folder} />
        <Action title="Delete Local Copy…" icon={Icon.Trash} style={Action.Style.Destructive} shortcut={Keyboard.Shortcut.Common.Remove}
          onAction={async () => { if (await deleteLocalCheckout(app, checkout)) { onDeleted(); pop(); } }} />
        {changes?.kind === "git" && changes.files.length > 0 && <Action.CopyToClipboard title="Copy Changed Files" content={changes.files.join("\n")} />}
        <Action title="Refresh" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["ctrl"], key: "r" }} onAction={() => setRefreshId((n) => n + 1)} />
      </ActionPanel>}
    />
  );
}
