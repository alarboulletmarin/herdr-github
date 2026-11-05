// node mods/git/parse.test.mjs : against a real repository built in a temporary folder.
import { parseStatus, fileState, parseNumstat, parseDiff, patchOf, hunkRows, parseLog, LOG_FORMAT, lane, treeRows, folderCheck, syncAction, gist } from "./parse.js";
import assert from "assert";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "herdr-git-")), sh = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const write = (p, s) => { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), s); };
try {
  sh("init", "-q", "-b", "main"); sh("config", "user.email", "t@t"); sh("config", "user.name", "t");
  const empty = parseStatus(sh("status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"));
  assert.equal(empty.branch.head, "main"); assert.equal(empty.branch.oid, null, "no commit yet"); assert.deepEqual(empty.files, []);
  write("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n"); write("gone.txt", "x\n"); write("old name.txt", "same\n"); write("src/app/deep/x.js", "x\n");
  sh("add", "-A"); sh("commit", "-qm", "one");
  write("a.txt", "ONE\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\nTWELVE\n"); // two hunks, both unstaged
  write("staged.txt", "s\n"); sh("add", "staged.txt");
  write("src/app/deep/x.js", "y\n"); sh("add", "src/app/deep/x.js"); write("src/app/deep/x.js", "z\n"); // partly staged
  sh("rm", "-q", "gone.txt"); sh("mv", "old name.txt", "new name.txt");
  write("café é.txt", "u\n"); write("src/new|odd.md", "n\n");
  const s = parseStatus(sh("status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"));
  const by = Object.fromEntries(s.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(by).sort(), ["a.txt", "café é.txt", "gone.txt", "new name.txt", "src/app/deep/x.js", "src/new|odd.md", "staged.txt"].sort());
  assert.equal(by["new name.txt"].orig, "old name.txt", "rename keeps its origin");
  assert.deepEqual(fileState(by["a.txt"]), { letter: "M", check: "off" });
  assert.deepEqual(fileState(by["staged.txt"]), { letter: "A", check: "on" });
  assert.deepEqual(fileState(by["src/app/deep/x.js"]), { letter: "M", check: "partial" });
  assert.deepEqual(fileState(by["gone.txt"]), { letter: "D", check: "on" });
  assert.deepEqual(fileState(by["new name.txt"]), { letter: "R", check: "on" });
  assert.deepEqual(fileState(by["café é.txt"]), { letter: "A", check: "off" }, "untracked, accents and space");
  assert.equal(s.branch.oid?.length, 40);

  const stats = parseNumstat([sh("diff", "HEAD", "--numstat", "-z", "--no-renames")]);
  assert.deepEqual(stats["a.txt"], { add: 2, del: 2, binary: false });
  assert.equal(stats["gone.txt"].del, 1);

  const d = parseDiff(sh("diff", "--no-color", "--", "a.txt"));
  assert.equal(d.hunks.length, 2, "two separate hunks");
  assert.ok(d.header[0].startsWith("diff --git"));
  // Stage only the second hunk through git apply, the way the diff dialog does.
  execFileSync("sh", ["-c", 'printf "%s" "$1" | git apply --cached -', "sh", patchOf(d.header, d.hunks[1])], { cwd: dir });
  assert.match(sh("diff", "--cached", "--", "a.txt"), /\+TWELVE/); assert.doesNotMatch(sh("diff", "--cached", "--", "a.txt"), /\+ONE/);
  const back = parseDiff(sh("diff", "--cached", "--no-color", "--", "a.txt"));
  execFileSync("sh", ["-c", 'printf "%s" "$1" | git apply --cached -R -', "sh", patchOf(back.header, back.hunks[0])], { cwd: dir });
  assert.equal(sh("diff", "--cached", "--", "a.txt"), "", "unstaged again");
  assert.deepEqual(parseDiff(""), { header: [], hunks: [] });

  const rows = hunkRows(d.hunks[0]);
  assert.deepEqual(rows.find((r) => r.kind === "-"), { kind: "-", old: 1, text: "1" });
  assert.deepEqual(rows.find((r) => r.kind === "+"), { kind: "+", next: 1, text: "ONE" });
  assert.deepEqual(hunkRows({ head: "@@ -3 +3 @@", lines: ["+", "\\ No newline at end of file"] }), [{ kind: "+", next: 3, text: " " }, { kind: "\\", text: "\\ No newline at end of file" }]);

  sh("add", "-A"); sh("commit", "-qm", "two | with a pipe"); sh("switch", "-qc", "side"); write("side.txt", "s\n"); sh("add", "-A"); sh("commit", "-qm", "side");
  sh("switch", "-q", "main"); write("main.txt", "m\n"); sh("add", "-A"); sh("commit", "-qm", "main"); sh("merge", "-q", "--no-edit", "side");
  const log = parseLog(sh("log", "--graph", "--date-order", `--format=${LOG_FORMAT}`));
  const commits = log.filter((l) => l.commit);
  assert.equal(commits.length, 5); assert.ok(log.some((l) => !l.commit), "connector lines");
  assert.equal(commits[0].commit.refs[0], "HEAD -> main"); assert.match(commits[0].commit.subject, /^Merge branch 'side'/);
  assert.ok(commits.some((c) => c.commit.subject === "two | with a pipe"));
  assert.ok(commits.some((c) => c.graph.startsWith("| *")), "a commit on the second lane");
  assert.equal(lane(0), 0); assert.equal(lane(2), 1); assert.equal(lane(3), 1);
  assert.deepEqual(parseLog(""), []);

  // A conflict.
  sh("switch", "-qc", "c1"); write("a.txt", "c1\n"); sh("commit", "-qam", "c1"); sh("switch", "-q", "main"); write("a.txt", "main\n"); sh("commit", "-qam", "m");
  try { sh("merge", "-q", "c1"); } catch { /* conflict expected */ }
  const c = parseStatus(sh("status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all")).files.find((f) => f.path === "a.txt");
  assert.equal(c.conflict, true); assert.equal(fileState(c).letter, "U");
} finally { rmSync(dir, { recursive: true, force: true }); }

// The tree.
const f = (path, x = ".", y = "M") => ({ path, x, y, untracked: false, conflict: false });
const files = [f("src/app/deep/x.js", "M", "."), f("src/app/y.js"), f("README.md"), f("src/z.js", "M", "."), f("lib/only/one/file.js")];
const rows = treeRows(files);
assert.deepEqual(rows.map((r) => `${"  ".repeat(r.depth)}${r.dir ? "▸" : ""}${r.name}`), ["▸lib/only/one", "  file.js", "▸src", "  ▸app", "    ▸deep", "      x.js", "    y.js", "  z.js", "README.md"]);
assert.deepEqual(treeRows(files, new Set(["src"])).map((r) => r.name), ["lib/only/one", "file.js", "src", "README.md"], "a folded folder hides its rows");
assert.equal(rows.find((r) => r.name === "x.js").path, "src/app/deep/x.js");
assert.equal(folderCheck(files, "src"), "partial"); assert.equal(folderCheck(files, "src/app/deep"), "on"); assert.equal(folderCheck(files, "lib/only/one"), "off");
assert.equal(folderCheck(files, "sr"), "on", "no file under a prefix that isn't a folder"); // every([]) is true: callers only ask for real folders
assert.deepEqual(treeRows([]), []);
assert.deepEqual(treeRows([f("a"), f("b")]).map((r) => r.name), ["a", "b"]);

assert.equal(syncAction({ head: null }).action, "fetch", "detached");
assert.equal(syncAction({ head: "x", upstream: null }).action, "publish");
assert.deepEqual(syncAction({ head: "x", upstream: "o/x", ahead: 2, behind: 1 }), { action: "pull", label: "Pull ↓1" }, "behind first");
assert.equal(syncAction({ head: "x", upstream: "o/x", ahead: 3, behind: 0 }).label, "Push ↑3");
assert.equal(syncAction({ head: "x", upstream: "o/x", ahead: 0, behind: 0 }).action, "fetch");
assert.equal(gist("To /tmp/o.git\n ! [rejected]        main -> main (stale info)\nerror: failed to push some refs to '/tmp/o.git'"), "! [rejected]        main -> main (stale info)");
assert.equal(gist("hook says no"), "hook says no"); assert.equal(gist(""), ""); assert.equal(gist("\n  \nfatal: bad\n"), "fatal: bad");
console.log("parse ok");
