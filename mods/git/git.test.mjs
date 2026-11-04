// node mods/git/git.test.mjs : Repo (git.js) against real repositories, with a stand-in for herdr's exec.
import { registerHooks } from "module";
import assert from "assert";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// "herdr" resolves to a module whose exec runs the program here.
const stub = `import { execFile } from "child_process";
export function exec(cmd, args = [], { cwd } = {}) {
  return new Promise((ok) => execFile(cmd, args, { cwd, maxBuffer: 1 << 26 }, (e, stdout, stderr) => ok({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
}`;
registerHooks({ resolve: (spec, ctx, next) => spec === "herdr" ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true } : next(spec, ctx) });
const { Repo } = await import("./git.js");

const made = [];
function repo(files = {}, commit = true) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-git-")); made.push(dir);
  const sh = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  sh("init", "-q", "-b", "main"); sh("config", "user.email", "t@t"); sh("config", "user.name", "t");
  for (const [p, s] of Object.entries(files)) writeFileSync(join(dir, p), s);
  if (commit) { sh("add", "-A"); sh("commit", "-qm", "one"); }
  return { dir, sh, r: new Repo(dir, null), write: (p, s) => writeFileSync(join(dir, p), s) };
}
const staged = (sh) => sh("diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();

try {
  { // A partial stage previews and commits the index, not the newer working copy or other tracked edits.
    const { sh, r, write } = repo({ "café space.txt": "base\n", "other.txt": "base\n" });
    write("café space.txt", "staged\n"); sh("add", "café space.txt");
    write("café space.txt", "working\nextra\n"); write("other.txt", "unstaged\n"); write("untracked.txt", "new\n");
    sh("config", "diff.noprefix", "true");
    const p = await r.nextCommit();
    assert.equal(p.tracked, false); assert.deepEqual(p.files.map((f) => f.path), ["café space.txt"]);
    assert.equal(p.files[0].add, 1); assert.equal(p.files[0].del, 1);
    assert.ok(p.files[0].diff.hunks[0].lines.includes("+staged"));
    assert.ok(!p.files[0].diff.hunks[0].lines.includes("+working"));
    assert.match(p.files[0].diff.header[0], /^diff --git "?a\//);
    await r.commit("feat: staged message\n\nBody from the preview");
    assert.equal(sh("show", "HEAD:café space.txt"), "staged\n");
    assert.equal(sh("show", "HEAD:other.txt"), "base\n");
    assert.equal(sh("log", "-1", "--format=%B").trim(), "feat: staged message\n\nBody from the preview");
    assert.ok(!sh("ls-tree", "--name-only", "HEAD").includes("untracked.txt"));
  }
  { // Commit tracked includes modifications and deletions, leaving new files out.
    const { sh, r, write } = repo({ "[a].txt": "base\n", "gone.txt": "gone\n" });
    write("[a].txt", "tracked\nsecond\n"); rmSync(join(r.root, "gone.txt")); write("new.txt", "untracked\n");
    const p = await r.nextCommit();
    assert.equal(p.tracked, true); assert.deepEqual(p.files.map((f) => f.path).sort(), ["[a].txt", "gone.txt"]);
    const changed = p.files.find((f) => f.path === "[a].txt"), gone = p.files.find((f) => f.path === "gone.txt");
    assert.equal(changed.add, 2); assert.equal(changed.del, 1); assert.equal(gone.add, 0); assert.equal(gone.del, 1);
    await r.commit("fix: tracked changes");
    assert.equal(sh("show", "HEAD:[a].txt"), "tracked\nsecond\n");
    assert.deepEqual(sh("ls-tree", "--name-only", "HEAD").trim().split("\n"), ["[a].txt"]);
    assert.equal(sh("status", "--porcelain").trim(), "?? new.txt");
  }
  { // Initial commits preview staged additions without needing HEAD.
    const { sh, r, write } = repo({ "added.txt": "first\n" }, false);
    sh("add", "added.txt"); write("added.txt", "later\n");
    const p = await r.nextCommit();
    assert.equal(p.tracked, false); assert.equal(p.files.length, 1); assert.equal(p.files[0].add, 1);
    assert.ok(p.files[0].diff.hunks[0].lines.includes("+first"));
    await r.commit("feat: initial commit"); assert.equal(sh("show", "HEAD:added.txt"), "first\n");
  }
  { // An empty/untracked-only repository can be previewed but cannot commit tracked changes.
    const { r, write } = repo({}, false); write("new.txt", "untracked\n");
    assert.deepEqual(await r.nextCommit(), { tracked: true, files: [] });
    await assert.rejects(r.commit("empty"), /No tracked changes/);
  }
  { // Amend without a stage keeps the existing tree, including when the working copy changed.
    const { sh, r, write } = repo({ "a.txt": "base\n" });
    write("a.txt", "unstaged\n");
    assert.deepEqual(await r.nextCommit(true), { tracked: false, files: [] });
    await r.commit("fix: amended message", true);
    assert.equal(sh("show", "HEAD:a.txt"), "base\n"); assert.equal(sh("rev-list", "--count", "HEAD").trim(), "1");
    assert.equal(sh("log", "-1", "--format=%s").trim(), "fix: amended message");
    sh("add", "a.txt"); write("a.txt", "newer\n");
    const p = await r.nextCommit(true);
    assert.equal(p.tracked, false); assert.ok(p.files[0].diff.hunks[0].lines.includes("+unstaged"));
    await r.commit("", true);
    assert.equal(sh("show", "HEAD:a.txt"), "unstaged\n"); assert.equal(sh("log", "-1", "--format=%s").trim(), "fix: amended message");
  }
  { // Renames keep their metadata and binary files remain visible even without text hunks.
    const { sh, r, write } = repo({ "old name.txt": "1\n2\n3\n4\n5\n", "binary": "old\0data" });
    sh("mv", "old name.txt", "new name.txt"); write("new name.txt", "1\n2\nTHREE\n4\n5\n");
    write("binary", "new\0data"); sh("add", "-A");
    const p = await r.nextCommit(), renamed = p.files.find((f) => f.path === "new name.txt"), binary = p.files.find((f) => f.path === "binary");
    assert.equal(renamed.orig, "old name.txt"); assert.equal(renamed.add, 1); assert.equal(renamed.del, 1);
    assert.ok(renamed.diff.header.includes("rename from old name.txt"));
    assert.equal(binary.binary, true); assert.equal(binary.diff.hunks.length, 0);
    assert.ok(binary.diff.header.some((l) => l.startsWith("Binary files ")));
    await r.commit("feat: rename and binary");
    assert.equal(sh("show", "HEAD:new name.txt"), "1\n2\nTHREE\n4\n5\n"); assert.equal(sh("show", "HEAD:binary"), "new\0data");
  }
  { // Intent-to-add is tracked by commit -a even before the first commit.
    const { sh, r } = repo({ "intent.txt": "tracked new file\n" }, false);
    sh("add", "-N", "intent.txt");
    const p = await r.nextCommit();
    assert.equal(p.tracked, true); assert.equal(p.files[0].add, 1);
    await r.commit("feat: intent to add"); assert.equal(sh("show", "HEAD:intent.txt"), "tracked new file\n");
  }
  { // Pure renames have no changed lines, but the preview still shows what the index will commit.
    const { sh, r } = repo({ "old.txt": "same\n" }); sh("mv", "old.txt", "new.txt");
    const p = await r.nextCommit();
    assert.equal(p.files.length, 1); assert.equal(p.files[0].add, 0); assert.equal(p.files[0].del, 0);
    assert.ok(p.files[0].diff.header.includes("rename to new.txt"));
  }
  { // Names are literal: staging "[a].txt" leaves "a.txt" alone.
    const { sh, r, write } = repo({ "a.txt": "1\n", "[a].txt": "1\n" });
    write("a.txt", "2\n"); write("[a].txt", "2\n");
    await r.stage(["[a].txt"]);
    assert.deepEqual(staged(sh), ["[a].txt"]);
  }
  { // Unstaging a rename unstages both names.
    const { sh, r } = repo({ "old.txt": "x\n" });
    sh("mv", "old.txt", "new.txt");
    const { files } = await r.status();
    assert.equal(files[0].orig, "old.txt");
    await r.unstage(["new.txt"], true, files);
    assert.deepEqual(staged(sh), [], "nothing staged, old.txt not left deleted");
    assert.ok(existsSync(join(made.at(-1), "new.txt")), "the file itself stays");
  }
  { // Before the first commit, unstaging works even when the file changed again since git add.
    const { sh, r, write } = repo({ "f.txt": "1\n" }, false);
    sh("add", "f.txt"); write("f.txt", "2\n");
    await r.unstage(["f.txt"], false);
    assert.deepEqual(staged(sh), []); assert.equal(readFileSync(join(made.at(-1), "f.txt"), "utf8"), "2\n", "work kept");
  }
  { // Hunks apply even with diff.noprefix set.
    const { sh, r, write } = repo({ "a.txt": Array.from({ length: 12 }, (_, n) => `${n}\n`).join("") });
    sh("config", "diff.noprefix", "true");
    write("a.txt", ["A", ...Array.from({ length: 10 }, (_, n) => `${n + 1}`), "L", ""].join("\n"));
    const d = await r.diff("a.txt", false);
    assert.equal(d.hunks.length, 2);
    await r.applyHunk(d.header, d.hunks[1]);
    assert.match(sh("diff", "--cached"), /\+L/); assert.doesNotMatch(sh("diff", "--cached"), /\+A/);
    const back = await r.diff("a.txt", true);
    await r.applyHunk(back.header, back.hunks[0], { reverse: true });
    assert.deepEqual(staged(sh), []);
  }
  { // A staged rename with an edit reads as a rename, not a new file.
    const { sh, r, write } = repo({ "old.txt": "1\n2\n3\n4\n5\n" });
    sh("mv", "old.txt", "new.txt"); write("new.txt", "1\n2\nTHREE\n4\n5\n"); sh("add", "new.txt");
    const d = await r.diff("new.txt", true, "old.txt");
    assert.ok(d.header.some((l) => l === "rename from old.txt"));
    assert.equal(d.hunks.length, 1); assert.ok(d.hunks[0].lines.includes("+THREE"));
  }
  { // Branch names come back clean.
    const { sh, r } = repo({ "a": "1\n" });
    sh("branch", "feature/x");
    const names = (await r.branches()).map((b) => b.name).sort();
    assert.deepEqual(names, ["feature/x", "main"]);
  }
  { // A stash moved since it was picked is refused.
    const { sh, r, write } = repo({ "a": "1\n" });
    write("a", "2\n"); sh("stash", "push", "-q", "-m", "first");
    const [first] = (await r.status()).stashes;
    assert.equal(first.ref, "stash@{0}"); assert.equal(first.oid.length, 40);
    assert.equal(await r.stashRef(first.ref, first.oid), "stash@{0}");
    write("a", "3\n"); sh("stash", "push", "-q", "-m", "second");
    await assert.rejects(r.stashRef(first.ref, first.oid), /changed since/);
  }
  { // The first commit knows it has no parent (no Uncommit); the next one does.
    const { sh, r, write } = repo({ "a": "1\n" });
    assert.equal((await r.status()).last.root, true);
    write("a", "2\n"); sh("commit", "-qam", "two");
    assert.equal((await r.status()).last.root, false);
  }
  { // Discard: tracked back to HEAD, added removed, untracked deleted, a rename back under its old name.
    const { sh, r, write, dir } = repo({ "m.txt": "1\n", "old.txt": "o\n" });
    write("m.txt", "2\n"); write("new-file.txt", "n\n"); write("added.txt", "a\n"); sh("add", "added.txt"); sh("mv", "old.txt", "moved.txt");
    for (const f of (await r.status()).files) await r.discard(f);
    assert.equal(readFileSync(join(dir, "m.txt"), "utf8"), "1\n");
    assert.ok(!existsSync(join(dir, "new-file.txt")) && !existsSync(join(dir, "added.txt")));
    assert.ok(existsSync(join(dir, "old.txt")));
    assert.equal(sh("status", "--porcelain"), "", "nothing left: the rename is undone too");
  }
} finally { for (const d of made) rmSync(d, { recursive: true, force: true }); }
console.log("git ok");
