import { Action, ActionPanel, Form, Icon, useNavigation } from "@raycast/api";
import { useState } from "react";
import { BASE_BRANCH, MendixApp, newBranchNameError } from "./core";
import { AfterCheckout, createBranch } from "./launch";
import { StudioProInstall, release } from "./studiopro";

type Then = AfterCheckout | "no-download";
type Values = { name: string; then: Then };

/**
 * Names a new Team Server branch, created from the latest commit of main. `existing` is the known remote branch
 * list, used to catch a taken name before the worker does. With `studioPro`, the new checkout opens in that version.
 */
export function CreateBranchForm({ app, existing, studioPro }: { app: MendixApp; existing: string[]; studioPro?: StudioProInstall }) {
  const { pop } = useNavigation();
  const [nameError, setNameError] = useState<string>();
  const studioProTitle = studioPro ? `Studio Pro ${release(studioPro.version)}` : "Studio Pro";
  const submit = async ({ name, then }: Values) => {
    const branch = name.trim();
    const error = newBranchNameError(branch, existing);
    if (error) { setNameError(error); return; }
    pop();
    await createBranch(app, branch, then !== "no-download", then === "no-download" ? "none" : then, studioPro?.executable);
  };
  // An empty list means it is unknown (not loaded or failed), not that main is missing.
  const baseMissing = existing.length > 0 && !existing.includes(BASE_BRANCH);
  return (
    <Form navigationTitle={`${app.name} · Create Branch`}
      actions={<ActionPanel><Action.SubmitForm title="Create Branch" icon={Icon.Plus} onSubmit={submit} /></ActionPanel>}>
      <Form.TextField id="name" title="Branch Name" placeholder="feature/my-change" autoFocus error={nameError}
        onChange={() => setNameError(undefined)} onBlur={(e) => setNameError(e.target.value?.trim() ? newBranchNameError(e.target.value.trim(), existing) : undefined)} />
      <Form.Dropdown id="then" title="Then" defaultValue="studio-pro">
        <Form.Dropdown.Item value="studio-pro" title={`Download and Open in ${studioProTitle}`} icon={Icon.Download} />
        <Form.Dropdown.Item value="terminal" title="Download and Open in Terminal" icon={Icon.Terminal} />
        <Form.Dropdown.Item value="none" title="Download Only" icon={Icon.NewFolder} />
        <Form.Dropdown.Item value="no-download" title="Create on Team Server Only" icon={Icon.Cloud} />
      </Form.Dropdown>
      <Form.Description text={baseMissing
        ? `⚠ The branch list has no ${BASE_BRANCH} branch, so creating will fail. Refresh the branch list if it is out of date.`
        : `The branch starts from the latest commit of ${BASE_BRANCH} on Team Server. A download uses the Default Clone Type from the settings.`} />
    </Form>
  );
}
