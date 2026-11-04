// node mods/github/work.test.mjs
import { stageOf, marked, ref, columns } from "./work.js";
import assert from "assert";

const open = { repo: "o/r", number: 7, state: "OPEN" };
assert.equal(ref(open), "o/r#7");
assert.equal(stageOf(open).stage, "todo", "nothing known: to do");
assert.equal(stageOf({ ...open, state: "CLOSED" }, { stage: "doing", by: "hand" }).stage, "done", "closed wins over a hand mark");
assert.equal(stageOf({ ...open, state: "MERGED", headRefName: "x" }).why, "Merged");
assert.deepEqual(stageOf(open, { stage: "doing", by: "brief" }), { stage: "doing", why: "Brief copied" });
assert.equal(stageOf(open, { stage: "doing", by: "agent", tab: "#7 r" }, []).why, "Agent started", "agent tab gone: still in progress");
const agent = { tab_name: "#7 r", status: "working" };
assert.equal(stageOf(open, { stage: "doing", by: "agent", tab: "#7 r" }, [agent]).why, "Agent working");
assert.equal(stageOf(open, { stage: "doing", by: "agent", tab: "#7 r" }, [{ ...agent, status: "blocked" }]).why, "Agent needs you");
assert.equal(stageOf(open, { stage: "doing", by: "agent", tab: "#7 r" }, [{ ...agent, status: "idle" }]).why, "Agent waiting");
assert.equal(stageOf({ ...open, closedByPullRequestsReferences: [{ number: 9 }] }).stage, "review", "a linked PR: in review");
assert.equal(stageOf({ ...open, closedByPullRequestsReferences: [{ number: 9 }] }, null, [agent]).stage, "review", "no mark: a stray agent tab isn't matched");
assert.equal(stageOf({ ...open, closedByPullRequestsReferences: [] }, { stage: "todo", by: "hand" }).stage, "todo", "hand mark wins over auto");
assert.equal(stageOf({ ...open, closedByPullRequestsReferences: [{ number: 9 }] }, { stage: "todo", by: "hand" }).stage, "todo", "hand mark wins over a linked PR");
assert.equal(stageOf({ ...open, headRefName: "b", isDraft: true }).stage, "doing", "draft PR");
assert.equal(stageOf({ ...open, headRefName: "b", isDraft: false }).stage, "review", "open PR");
assert.equal(stageOf({ ...open, state: "open" }).stage, "todo", "lowercase state (search results)");
assert.equal(stageOf({ ...open, state: "closed" }).stage, "done", "lowercase closed");

const m = marked({}, "o/r#7", "doing", { by: "brief" });
assert.equal(m["o/r#7"].stage, "doing"); assert.equal(m["o/r#7"].by, "brief");
assert.deepEqual(marked(m, "o/r#7", null), {}, "null removes");
assert.deepEqual(marked(undefined, "a#1", null), {}, "no marks yet");
const before = { "a#1": { stage: "doing" } }; marked(before, "b#2", "todo");
assert.deepEqual(Object.keys(before), ["a#1"], "input untouched");
const items = [
  { repo: "o/r", number: 1, state: "OPEN", updatedAt: "2026-01-01" },
  { repo: "o/r", number: 2, state: "OPEN", updatedAt: "2026-01-03", closedByPullRequestsReferences: [{ number: 5 }] },
  { repo: "o/r", number: 3, state: "CLOSED", updatedAt: "2026-01-02" },
  { repo: "o/r", number: 4, state: "OPEN", updatedAt: "2026-01-04" },
  { repo: "o/r", number: 5, state: "OPEN", headRefName: "fix", isDraft: false, updatedAt: "2026-01-05" },
  { repo: "o/r", number: 6, state: "OPEN", headRefName: "wip", isDraft: true, updatedAt: "2026-01-06" },
];
const c = columns(items, { "o/r#4": { stage: "doing", by: "brief" } });
const nums = (k) => c[k].map((x) => x.item.number);
assert.deepEqual(nums("todo"), [1]);
assert.deepEqual(nums("doing"), [6, 4], "newest first; draft PR in progress");
assert.deepEqual(nums("review"), [2], "PR #5 closes #2: one card, the issue's");
assert.deepEqual(nums("done"), [3]);
assert.equal(c.doing[0].kind, "pr"); assert.equal(c.doing[1].kind, "issue");
assert.deepEqual(Object.values(columns([])).flat(), [], "empty board");
console.log("work ok");
