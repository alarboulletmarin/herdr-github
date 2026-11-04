// node mods/github/brief.test.mjs
import { slug, issueBrief, prReviewBrief, prFixBrief, runBrief } from "./brief.js";
import assert from "assert";

assert.equal(slug("Export: save a rendered note as a portable PDF"), "export-save-a-rendered-note-as", "cut on a dash, ≤ 30");
assert.equal(slug("Fix typo"), "fix-typo", "short title kept");
assert.equal(slug("Élégant café à Noël"), "elegant-cafe-a-noel", "accents dropped");
assert.equal(slug("x".repeat(50)), "x".repeat(30), "no dash: hard cut at 30");
assert.equal(slug("🎉🎉"), "", "nothing usable");
assert.equal(slug("a-" + "b".repeat(40)), "a", "keeps the whole first word");

const issue = issueBrief({ repo: "o/r", number: 7, title: "Bug: crash", url: "u", labels: [{ name: "bug" }] });
const pr = prFixBrief({ repo: "o/r", number: 8, title: "t", url: "u", headRefName: "h", baseRefName: "main" });
const review = prReviewBrief({ repo: "o/r", number: 8, title: "t", url: "u", headRefName: "h", baseRefName: "main", closingIssuesReferences: [{ number: 7 }] });
const failing = prFixBrief({ repo: "o/r", number: 9, title: "Failing CI", url: "u", headRefName: "fix-ci", baseRefName: "main", checks: { state: "failure", failed: [{ workflow: "CI", name: "test", conclusion: "failure", url: "https://example.test/check" }] }, reviews: [{ author: { login: "reviewer" }, state: "CHANGES_REQUESTED", body: "Handle empty input" }], comments: [{ author: { login: "author" }, body: "Context" }] });
const run = runBrief({ repo: "o/r", url: "u", workflowName: "CI", event: "push", headBranch: "main", databaseId: 1 });
for (const b of [issue, pr, review, failing, run]) {
  assert(b.includes("## First: the repository's conventions"), "conventions section");
  assert(b.indexOf("repository's conventions") < b.indexOf("## Steps"), "conventions before the steps");
  assert(/git worktree/.test(b) && /repository's language/.test(b), "worktree and language rules");
  if (b !== review) assert(/Conventional Commits/.test(b), "implementation commit rules");
  assert(!/undefined|null|NaN/.test(b), "no missing field leaks");
}
assert(issue.includes("`fix/7-bug-crash`") && issue.includes("`Closes #7`"), "bug label → fix/ branch");
assert(issue.includes("(no description"), "empty body");
assert(review.startsWith("# Review pull request o/r#8"), "review intent");
assert(review.includes("gh pr diff 8 -R o/r") && review.includes("separate `git worktree`"), "isolated or remote review");
assert(review.includes("repository's conventions and the linked issue") && review.includes("Closes: #7"), "review against linked issue");
assert(review.includes("numbered findings in French: file:line, problem, severity, suggested fix"), "actionable review report");
assert(review.includes("do not edit any file") && review.includes("create commits") && review.includes("Do not push, post a GitHub comment or review"), "review forbids edits, commits, pushes and publishing");
assert(!review.includes("## Report (in French, short bullets)") && !review.includes("5. Local commits"), "review has no implementation report or commit step");
assert(pr.startsWith("# Fix pull request o/r#8") && pr.includes("PR's branch `h`"), "fix on PR branch");
assert(pr.includes("make only the requested changes") && pr.includes("unresolved requested change") && pr.includes("post no replies"), "fix scope and no review replies");
assert(failing.includes("CI / test: failure") && failing.includes("Handle empty input") && failing.includes('<comment author="author">'), "fix context keeps checks, reviews and comments");
assert(failing.includes("Reproduce failing checks locally") && failing.includes("targeted checks") && failing.includes("I'll push myself"), "fix reproduction, validation and publication rules");

for (const b of [issue, pr, review, failing, run]) assert(!/[éèàêç]/.test(b.replace(/in French/, "")), "instructions in English only");
assert(issue.includes("Report (in French"), "report asked in French");

console.log("brief.test ok");
