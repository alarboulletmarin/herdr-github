// node mods/github/brief.test.mjs
import { slug, issueBrief, prBrief, runBrief } from "./brief.js";
import assert from "assert";

assert.equal(slug("Export: save a rendered note as a portable PDF"), "export-save-a-rendered-note-as", "cut on a dash, ≤ 30");
assert.equal(slug("Fix typo"), "fix-typo", "short title kept");
assert.equal(slug("Élégant café à Noël"), "elegant-cafe-a-noel", "accents dropped");
assert.equal(slug("x".repeat(50)), "x".repeat(30), "no dash: hard cut at 30");
assert.equal(slug("🎉🎉"), "", "nothing usable");
assert.equal(slug("a-" + "b".repeat(40)), "a", "keeps the whole first word");

const issue = issueBrief({ repo: "o/r", number: 7, title: "Bug: crash", url: "u", labels: [{ name: "bug" }] });
const pr = prBrief({ repo: "o/r", number: 8, title: "t", url: "u", headRefName: "h", baseRefName: "main" });
const run = runBrief({ repo: "o/r", url: "u", workflowName: "CI", event: "push", headBranch: "main", databaseId: 1 });
for (const b of [issue, pr, run]) {
  assert(b.includes("## First: the repository's conventions"), "conventions section");
  assert(b.indexOf("repository's conventions") < b.indexOf("## Steps"), "conventions before the steps");
  assert(/Conventional Commits/.test(b) && /git worktree/.test(b) && /repository's language/.test(b), "commit, worktree, language rules");
  assert(!/undefined|null|NaN/.test(b), "no missing field leaks");
}
assert(issue.includes("`fix/7-bug-crash`") && issue.includes("`Closes #7`"), "bug label → fix/ branch");
assert(issue.includes("(no description"), "empty body");
console.log("brief.test ok");
for (const b of [issue, pr, run]) assert(!/[éèàêç]/.test(b.replace(/in French/, "")), "instructions in English only");
assert(issue.includes("Report (in French"), "report asked in French");
