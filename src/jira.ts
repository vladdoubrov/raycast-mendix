// Optional Jira Cloud lookup for branches named after an issue (e.g. feature/OOMO-2482-fix).
// No @raycast/api import: compiled for the Node test runner by scripts/compile-core.cjs.

export type JiraSettings = { siteUrl: string; email: string; apiToken: string; projectKeys: string[] };
export type JiraStatusCategory = "new" | "indeterminate" | "done";
export type JiraIssue = {
  key: string;
  summary: string;
  status: string;
  statusCategory: JiraStatusCategory;
  assignee?: string;
  issueType?: string;
};

/** `https://` origin of a Jira site, from `company.atlassian.net` or a full URL; undefined if not HTTPS. */
export function normalizeJiraSite(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.protocol === "https:" && url.hostname ? url.origin : undefined;
  } catch { return undefined; }
}

export function parseProjectKeys(input: string | undefined): string[] {
  return [...new Set((input ?? "").split(/[\s,;]+/).map((k) => k.trim().toUpperCase()).filter((k) => /^[A-Z][A-Z\d_]+$/.test(k)))];
}

/** Settings when site, email and token are all filled in; otherwise undefined and the Jira feature stays hidden. */
export function jiraSettings(prefs: { jiraSiteUrl?: string; jiraEmail?: string; jiraApiToken?: string; jiraProjectKeys?: string }): JiraSettings | undefined {
  const siteUrl = normalizeJiraSite(prefs.jiraSiteUrl ?? "");
  const email = prefs.jiraEmail?.trim() ?? "";
  const apiToken = prefs.jiraApiToken?.trim() ?? "";
  if (!siteUrl || !email || !apiToken) return undefined;
  return { siteUrl, email, apiToken, projectKeys: parseProjectKeys(prefs.jiraProjectKeys) };
}

/**
 * The first issue key in a branch name. With project keys, matches only those (any case);
 * without, only upper-case keys, so names like `mx10-2` are not taken for issues.
 */
export function issueKeyFromBranch(branch: string, projectKeys: string[] = []): string | undefined {
  const pattern = projectKeys.length
    ? new RegExp(`(?<![A-Za-z\\d])(${projectKeys.join("|")})-(\\d+)(?!\\d)`, "i")
    : /(?<![A-Za-z\d])([A-Z][A-Z\d_]+)-(\d+)(?!\d)/;
  const match = branch.match(pattern);
  return match ? `${match[1].toUpperCase()}-${Number(match[2])}` : undefined;
}

export const jiraIssueUrl = (siteUrl: string, key: string) => `${siteUrl}/browse/${encodeURIComponent(key)}`;

function toIssue(raw: unknown): JiraIssue | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { key, fields } = raw as { key?: unknown; fields?: Record<string, any> };
  if (typeof key !== "string" || !fields || typeof fields !== "object") return undefined;
  const category = fields.status?.statusCategory?.key;
  return {
    key,
    summary: typeof fields.summary === "string" ? fields.summary : "",
    status: typeof fields.status?.name === "string" ? fields.status.name : "Unknown",
    statusCategory: category === "done" || category === "indeterminate" ? category : "new",
    assignee: typeof fields.assignee?.displayName === "string" ? fields.assignee.displayName : undefined,
    issueType: typeof fields.issuetype?.name === "string" ? fields.issuetype.name : undefined,
  };
}

/**
 * Summary, status and assignee for `keys`, through Jira Cloud's bulk fetch (100 keys per request).
 * Keys that do not exist or are not visible are simply missing from the result.
 * The API token goes only to the configured Jira site, as Basic authentication.
 */
export async function fetchJiraIssues(settings: JiraSettings, keys: string[], fetchImpl: typeof fetch = fetch): Promise<JiraIssue[]> {
  const unique = [...new Set(keys)];
  const auth = `Basic ${Buffer.from(`${settings.email}:${settings.apiToken}`).toString("base64")}`;
  const issues: JiraIssue[] = [];
  for (let i = 0; i < unique.length; i += 100) {
    const response = await fetchImpl(`${settings.siteUrl}/rest/api/3/issue/bulkfetch`, {
      method: "POST",
      headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ issueIdsOrKeys: unique.slice(i, i + 100), fields: ["summary", "status", "assignee", "issuetype"] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const summary = response.status === 401 ? "invalid email or API token"
        : response.status === 403 ? "the account lacks access to Jira"
        : response.status === 404 ? "check the Jira site URL (Jira Cloud only)" : response.statusText;
      throw new Error(`Jira ${response.status}: ${summary}`);
    }
    const data: unknown = await response.json();
    const items = (data as { issues?: unknown } | null)?.issues;
    if (!Array.isArray(items)) throw new Error("Unexpected Jira response");
    for (const item of items) {
      const issue = toIssue(item);
      if (issue) issues.push(issue);
    }
  }
  return issues;
}
