// Where an issue or pull request stands, beyond GitHub's open and closed: To do, In progress, In review, Done.
// Marks live in shared("github.work"), so the panel, the dialogs and every copy see the same thing:
// { "owner/repo#12": { stage: "doing", by: "agent" | "brief" | "hand", tab?: "#12 repo", at } }.
export const STAGES = [["todo", "To do"], ["doing", "In progress"], ["review", "In review"], ["done", "Done"]];
export const ref = (item) => `${item.repo}#${item.number}`;

const closed = (i) => /^(CLOSED|MERGED)$/.test(String(i.state).toUpperCase());

// item: a list row or the full issue/PR; mark: its entry in github.work; agents: herdr's agents().
// Returns { stage, why, agent } where agent is the live agent working on it, if any.
export function stageOf(item, mark, agents = [], kind = item.headRefName !== undefined ? "pr" : "issue") {
  if (closed(item)) return { stage: "done", why: String(item.state).toUpperCase() === "MERGED" ? "Merged" : "Closed" };
  const agent = agentOf(mark, agents);
  if (mark?.by === "hand") return { stage: mark.stage, why: "Set by you", agent };
  if (agent) return { stage: "doing", why: agent.status === "working" ? "Agent working" : agent.status === "blocked" ? "Agent needs you" : "Agent waiting", agent };
  if (kind === "pr") return item.isDraft ? { stage: "doing", why: "Draft" } : { stage: "review", why: "Open pull request" };
  if ((item.closedByPullRequestsReferences ?? []).length) return { stage: "review", why: `PR #${item.closedByPullRequestsReferences[0].number}` };
  if (mark) return { stage: mark.stage ?? "doing", why: mark.by === "agent" ? "Agent started" : "Brief copied" };
  return { stage: "todo", why: null };
}

// A new marks object (shared values are replaced whole). stage null removes the mark.
export function marked(marks, key, stage, extra = {}) {
  const next = { ...(marks ?? {}) };
  if (stage) next[key] = { stage, at: Date.now(), ...extra }; else delete next[key];
  return next;
}

// The board's columns: every item in its stage, most recently updated first. A pull request that
// closes an issue on the board is that issue's card, not a second one.
export function columns(items, marks = {}, agents = []) {
  const linked = new Set(items.flatMap((i) => (i.closedByPullRequestsReferences ?? []).map((r) => `${i.repo}#${r.number}`)));
  const out = Object.fromEntries(STAGES.map(([k]) => [k, []]));
  for (const i of items) {
    const kind = i.headRefName !== undefined ? "pr" : "issue";
    if (kind === "pr" && linked.has(ref(i))) continue;
    const s = stageOf(i, marks[ref(i)], agents, kind);
    out[s.stage].push({ item: i, kind, ...s });
  }
  for (const k in out) out[k].sort((a, b) => Date.parse(b.item.updatedAt ?? 0) - Date.parse(a.item.updatedAt ?? 0));
  return out;
}

// ---- the agent's own worktree ----
// Herdr's convention (its worktree mod): <home>/.herdr/worktrees/<repo>/<branch, anything odd as dashes>.
export const dirSlug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
// The branch an issue's agent works on, as the brief has always named it; a pull request keeps its own.
export function branchFor({ kind, number, title, labels = [], headRefName }, slug) {
  if (kind === "pr") return headRefName;
  return `${labels.some((l) => /bug/i.test(l.name ?? l)) ? "fix" : "feat"}/${number}-${slug(title)}`.replace(/-$/, "");
}
export const worktreePath = (home, repo, branch) => `${home}/.herdr/worktrees/${repo.split("/")[1]}/${dirSlug(branch)}`;
// Put first in the agent's brief: where it already is, so it neither branches again nor leaves.
export function worktreeNote({ folder, branch, base, reused }) {
  return [
    "## Workspace (already prepared)",
    "",
    `- You are in a dedicated git worktree: \`${folder}\`, on branch \`${branch}\`${base ? `, created from \`${base}\`` : ""}${reused ? " (it existed already: read `git log` and `git status` first, earlier work may be there)" : ""}.`,
    "- Work and commit there. Don't create or switch branches, don't touch the main checkout: this replaces any step below that gets or creates a branch.",
    "",
    "",
  ].join("\n");
}
// The agent on that item: the one working in its worktree; without a worktree, the tab it was started in
// (a name, so two repositories called the same can mix up: the worktree is what makes it exact).
export function agentOf(mark, agents) {
  if (mark?.folder) return agents.find((a) => a.cwd && (a.cwd === mark.folder || a.cwd.startsWith(`${mark.folder}/`))) ?? null;
  return mark?.tab ? agents.find((a) => a.tab_name === mark.tab) ?? null : null;
}
