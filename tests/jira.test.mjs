import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJiraIssues, issueKeyFromBranch, jiraIssueUrl, jiraSettings, normalizeJiraSite, parseProjectKeys } from '../dist-test/jira.cjs';

test('normalizes Jira site URLs and requires HTTPS', () => {
  assert.equal(normalizeJiraSite('company.atlassian.net'), 'https://company.atlassian.net');
  assert.equal(normalizeJiraSite(' https://company.atlassian.net/jira/your-work '), 'https://company.atlassian.net');
  assert.equal(normalizeJiraSite('http://company.atlassian.net'), undefined);
  assert.equal(normalizeJiraSite(''), undefined);
});

test('Jira is disabled unless site, email and token are all set', () => {
  assert.equal(jiraSettings({}), undefined);
  assert.equal(jiraSettings({ jiraSiteUrl: 'x.atlassian.net', jiraEmail: 'a@b.c' }), undefined);
  assert.equal(jiraSettings({ jiraSiteUrl: 'x.atlassian.net', jiraEmail: ' ', jiraApiToken: 't' }), undefined);
  assert.deepEqual(jiraSettings({ jiraSiteUrl: 'x.atlassian.net', jiraEmail: 'a@b.c', jiraApiToken: 't', jiraProjectKeys: 'oomo, ABC;;' }),
    { siteUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKeys: ['OOMO', 'ABC'] });
});

test('parses project keys and drops invalid ones', () => {
  assert.deepEqual(parseProjectKeys(' oomo ,OOMO, 1BAD, x '), ['OOMO']);
  assert.deepEqual(parseProjectKeys(undefined), []);
});

test('finds the issue key in a branch name', () => {
  assert.equal(issueKeyFromBranch('OOMO-2482'), 'OOMO-2482');
  assert.equal(issueKeyFromBranch('feature/OOMO-2482-fix-login'), 'OOMO-2482');
  assert.equal(issueKeyFromBranch('OOMO-2482_fix'), 'OOMO-2482');
  assert.equal(issueKeyFromBranch('feature/oomo-2482-fix'), undefined, 'lower case needs configured project keys');
  assert.equal(issueKeyFromBranch('feature/oomo-2482-fix', ['OOMO']), 'OOMO-2482');
  assert.equal(issueKeyFromBranch('ABC-12 then OOMO-3', ['OOMO']), 'OOMO-3');
  assert.equal(issueKeyFromBranch('XOOMO-1', ['OOMO']), undefined);
  assert.equal(issueKeyFromBranch('main'), undefined);
  assert.equal(issueKeyFromBranch('LDP_MX10'), undefined);
});

test('builds browse URLs', () => {
  assert.equal(jiraIssueUrl('https://x.atlassian.net', 'OOMO-1'), 'https://x.atlassian.net/browse/OOMO-1');
});

const settings = { siteUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 'secret', projectKeys: [] };
const issueJson = (key, category = 'indeterminate') => ({
  key, fields: { summary: `Summary ${key}`, status: { name: 'In Progress', statusCategory: { key: category } }, assignee: { displayName: 'Dev' }, issuetype: { name: 'Story' } },
});

test('bulk-fetches issues in batches of 100 with Basic auth to the configured site only', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, keys: body.issueIdsOrKeys });
    // Missing issues are left out, as Jira does.
    return new Response(JSON.stringify({ issues: body.issueIdsOrKeys.filter((k) => k !== 'OOMO-5').map((k) => issueJson(k, 'done')), issueErrors: [] }));
  };
  const keys = Array.from({ length: 150 }, (_, i) => `OOMO-${i + 1}`);
  const issues = await fetchJiraIssues(settings, [...keys, 'OOMO-1'], fakeFetch);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.keys.length), [100, 50]);
  for (const c of calls) {
    assert.equal(c.url, 'https://x.atlassian.net/rest/api/3/issue/bulkfetch');
    assert.equal(c.auth, `Basic ${Buffer.from('a@b.c:secret').toString('base64')}`);
  }
  assert.equal(issues.length, 149);
  assert.deepEqual(issues[0], { key: 'OOMO-1', summary: 'Summary OOMO-1', status: 'In Progress', statusCategory: 'done', assignee: 'Dev', issueType: 'Story' });
});

test('reports Jira HTTP errors without the token', async () => {
  const fakeFetch = async () => new Response('', { status: 401 });
  await assert.rejects(fetchJiraIssues(settings, ['OOMO-1'], fakeFetch), (e) => /401/.test(e.message) && !e.message.includes('secret'));
});

test('tolerates partial issue fields', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ issues: [{ key: 'OOMO-1', fields: {} }, { nonsense: true }] }));
  assert.deepEqual(await fetchJiraIssues(settings, ['OOMO-1'], fakeFetch),
    [{ key: 'OOMO-1', summary: '', status: 'Unknown', statusCategory: 'new', assignee: undefined, issueType: undefined }]);
});
