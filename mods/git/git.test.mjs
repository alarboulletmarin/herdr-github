// node mods/git/git.test.mjs : Repo (git.js) against real repositories, with a stand-in for herdr's exec.
import { registerHooks } from "module";
import assert from "assert";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// "herdr" resolves to a module whose exec runs the program here.
const stub = `
export const spaces = () => [{ active: true, folder: "never-answers" }], panes = () => [], focused = () => null;
export const theme = () => ({}), props = () => ({}), shared = () => null, watchFolder = () => new Promise(() => {}), nextCommand = watchFolder;
export const setShared = (key, value) => { globalThis.gitAsked = value; }, openOverlay = (spec) => { globalThis.gitOverlay = spec; }, closeOverlay = () => {}, readTextFile = () => null;
export const notify = (notice) => { globalThis.gitNotice = notice; };
import { execFile } from "child_process";
export function exec(cmd, args = [], { cwd } = {}) {
  if (cwd === "never-answers") return new Promise(() => {});
  if (cwd === "late-answer") return new Promise((resolve) => { globalThis.gitLateAnswer = resolve; });
  return new Promise((ok) => execFile(cmd, args, { cwd, maxBuffer: 1 << 26 }, (e, stdout, stderr) => ok({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
}`;
const gpui = "export class View {} export const div = () => {}, svg = () => {};";
const base = "export const v_flex = () => {}, h_flex = () => {}, TextareaState = {}, Textarea = {}, InputState = {}, Input = {}, Scrollbar = {}, v_virtual_list = () => {};";
registerHooks({ resolve: (spec, ctx, next) => {
  const source = { herdr: stub, "gpui-kit": gpui, "gpui-base": base }[spec];
  return source ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true } : next(spec, ctx);
} });
const { Repo, commandAnswer } = await import("./git.js");
const { default: Git } = await import("./main.js");

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
  { // A stuck runner rejects, releases its caller, and ignores a late answer.
    const alarms = [], timer = { after(ms, fire) { const alarm = { ms, fire, cancelled: false }; alarms.push(alarm); return { cancel() { alarm.cancelled = true; } }; } };
    const r = new Repo("never-answers", null, timer);
    for (const [command, ms] of [["fetch", 90000], ["pull", 90000], ["push", 90000], ["status", 30000]]) {
      let busy = true;
      const result = r.run([command]).finally(() => { busy = false; });
      const rejected = assert.rejects(result, new RegExp(`git ${command}: no answer after ${ms / 1000} s.*restart the window`));
      assert.equal(alarms.at(-1).ms, ms); alarms.at(-1).fire(); await rejected; assert.equal(busy, false);
    }
    let applied = false;
    const late = new Repo("late-answer", null, timer).run(["fetch"]).then(() => { applied = true; });
    const rejected = assert.rejects(late, /no answer after 90 s/);
    await Promise.resolve(); alarms.at(-1).fire(); await rejected;
    globalThis.gitLateAnswer({ code: 0, stdout: "late", stderr: "" });
    await new Promise((resolve) => setImmediate(resolve)); assert.equal(applied, false);
    const ok = commandAnswer(() => Promise.resolve("ok"), timer, "status");
    assert.equal(await ok, "ok"); await Promise.resolve(); assert.equal(alarms.at(-1).cancelled, true);
    await assert.rejects(commandAnswer(() => { throw new Error("cannot start"); }, timer, "status"), /cannot start/);
  }
  { // The panel releases busy, refreshes again, and cannot apply an expired command's callback.
    const alarms = [], tasks = [], timer = { after(ms, fire) { const alarm = { ms, fire }; alarms.push(alarm); return { cancel() {} }; } };
    const cx = { timer, notify() {}, spawn(work) { tasks.push(work(cx)); } };
    const panel = new Git(); panel.repo = new Repo("late-answer", null, timer);
    let refreshed = 0, applied = false; panel.refresh = () => { refreshed++; };
    panel.act("Fetching…", cx, (r) => r.run(["fetch"]), () => { applied = true; });
    await Promise.resolve(); const firstAnswer = globalThis.gitLateAnswer;
    assert.equal(panel.busy, "Fetching…"); assert.equal(alarms.at(-1).ms, 90000);
    alarms.at(-1).fire(); await tasks.at(-1);
    assert.equal(panel.busy, null); assert.equal(refreshed, 1); assert.match(panel.error, /git fetch: no answer after 90 s/);
    assert.equal(globalThis.gitNotice.level, "error");
    panel.act("Staging…", cx, (r) => r.run(["add", "a"])); await Promise.resolve();
    const secondAnswer = globalThis.gitLateAnswer;
    firstAnswer({ code: 0, stdout: "late", stderr: "" }); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(applied, false); assert.equal(panel.busy, "Staging…");
    secondAnswer({ code: 0, stdout: "", stderr: "" }); await tasks.at(-1);
    assert.equal(panel.busy, null); assert.equal(refreshed, 2);
    // A refresh on the same stuck runner also leaves loading, ready for the next timer tick.
    delete panel.refresh; panel.repo = new Repo("never-answers", null, timer);
    panel.refresh(cx); assert.equal(panel.loading, true); assert.equal(alarms.at(-1).ms, 30000);
    alarms.at(-1).fire(); await tasks.at(-1); assert.equal(panel.loading, false);
  }
  { // Menu availability and popup dimensions follow the repository state without new exec calls.
    const panel = new Git(); panel.repo = new Repo("unused", "machine");
    panel.st = { branch: { head: "main", upstream: null }, remotes: [], stashes: [], files: [] };
    panel.openMore(); let menu = globalThis.gitOverlay.props.menu;
    for (const action of ["fetch", "pull", "push", "pick-push", "force-ask"]) {
      const row = menu.items.find((item) => item?.[0] === action); assert.equal(row[3], false); assert.match(row[5], /remote/);
    }
    panel.st.remotes = [{ name: "origin", fetch: "first", push: "push-first" }, { name: "second", fetch: "second" }];
    panel.openMore(); menu = globalThis.gitOverlay.props.menu;
    assert.ok(menu.items.some((item) => item?.[0] === "fetch-all"));
    assert.equal(globalThis.gitOverlay.height, 12 + menu.items.reduce((h, item) => h + (item ? 32 : 9), 0));
    assert.equal(menu.items.find((item) => item?.[0] === "pick-push")[3], true);
    assert.match(menu.items.find((item) => item?.[0] === "push")[5], /No upstream/);
    panel.openRemotes("push-to"); assert.equal(globalThis.gitOverlay.height, 76);
    assert.deepEqual(globalThis.gitOverlay.props.menu.items.map((item) => [item[4], item[6]]), [["origin", "push-first"], ["second", "second"]]);
    assert.equal(globalThis.gitOverlay.props.menu.on, "machine");
    panel.st.branch.head = null; panel.openMore();
    assert.match(globalThis.gitOverlay.props.menu.items.find((item) => item?.[0] === "pick-push")[5], /detached/);
  }
  { // Network actions use real bare remotes, with rebase and lease protection.
    const origin = mkdtempSync(join(tmpdir(), "herdr-git-bare-")), second = mkdtempSync(join(tmpdir(), "herdr-git-bare-")); made.push(origin, second);
    for (const dir of [origin, second]) execFileSync("git", ["init", "--bare", "-q", "-b", "main", dir]);
    const { sh, r, write } = repo({ "a": "base\n" });
    sh("remote", "add", "origin", origin); sh("remote", "add", "second", second);
    assert.deepEqual((await r.remotes()).map((remote) => [remote.name, remote.fetch, remote.push]), [["origin", origin, origin], ["second", second, second]]);
    await r.sync("push-to", { remote: "origin", upstream: false });
    assert.equal(sh("rev-parse", "--abbrev-ref", "@{upstream}").trim(), "origin/main");
    await r.sync("push-to", { remote: "second", upstream: true });
    const other = repo({}, false);
    other.sh("remote", "add", "origin", origin); other.sh("fetch", "-q", "origin"); other.sh("reset", "--hard", "origin/main");
    other.write("remote-file", "remote\n"); other.sh("add", "-A"); other.sh("commit", "-qm", "remote change"); other.sh("push", "-q", "origin", "main");
    write("local-file", "local\n"); sh("add", "-A"); sh("commit", "-qm", "local change");
    const stale = sh("rev-parse", "origin/main").trim();
    await assert.rejects(r.sync("force-push"), /stale info|rejected/);
    assert.equal(sh("rev-parse", "origin/main").trim(), stale);
    await r.sync("fetch-from", { remote: "origin" });
    assert.equal(sh("rev-parse", "origin/main").trim(), other.sh("rev-parse", "HEAD").trim());
    await r.sync("pull-rebase");
    assert.equal(sh("log", "-2", "--format=%s").trim(), "local change\nremote change");
    await r.sync("push");
    sh("branch", "temporary"); await r.sync("push-to", { remote: "second", upstream: true });
    sh("push", "-q", "second", "temporary"); await r.sync("fetch-from", { remote: "second" });
    sh("push", "-q", "second", "--delete", "temporary");
    // Recreate a stale tracking ref: fetch --prune must remove it.
    sh("update-ref", "refs/remotes/second/temporary", "HEAD");
    await r.sync("fetch-from", { remote: "second" });
    assert.equal(sh("for-each-ref", "refs/remotes/second/temporary").trim(), "");
    await r.sync("fetch-all");
    assert.deepEqual((await r.status()).remotes.map((remote) => remote.name), ["origin", "second"]);
    sh("branch", "--unset-upstream"); await r.sync("push-to", { remote: "second", upstream: false });
    assert.equal(sh("rev-parse", "--abbrev-ref", "@{upstream}").trim(), "second/main");
  }
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
  { // Changes on an agent's worktree: only what it added since origin/HEAD, not the history below it.
    const { dir: up, sh: upSh, write: upWrite } = repo({ "a": "1\n" });
    upWrite("a", "2\n"); upSh("commit", "-qam", "base two");
    const clone = mkdtempSync(join(tmpdir(), "herdr-git-")); made.push(clone);
    execFileSync("git", ["clone", "-q", up, clone]);
    const wt = join(clone, "..", `${clone.split("/").pop()}-wt`); made.push(wt);
    const sh = (...a) => execFileSync("git", a, { cwd: wt, encoding: "utf8" });
    execFileSync("git", ["worktree", "add", "-q", "-b", "feat/7-x", wt, "origin/HEAD"], { cwd: clone });
    sh("config", "user.email", "t@t"); sh("config", "user.name", "t");
    for (const n of ["agent one", "agent two"]) { writeFileSync(join(wt, "a"), n); sh("commit", "-qam", n); }
    const r = new Repo(wt, null), subjects = (ls) => ls.filter((l) => l.commit).map((l) => l.commit.subject);
    assert.deepEqual(subjects(await r.log({ range: "origin/HEAD..HEAD" })), ["agent two", "agent one"]);
    assert.deepEqual(subjects(await r.log()), ["agent two", "agent one", "base two", "one"], "no range: the whole branch");
    assert.equal(subjects(await r.log({ all: true, range: "origin/HEAD..HEAD" })).length, 4, "all ignores the range");
    upSh("commit", "--allow-empty", "-qm", "upstream later"); execFileSync("git", ["fetch", "-q"], { cwd: clone });
    assert.deepEqual(subjects(await r.log({ range: "origin/HEAD..HEAD" })), ["agent two", "agent one"], "base moved on: still only the agent's");
    const { r: bare } = repo({ "a": "1\n" }); // no remote: the range fails, History falls back to the whole branch
    await assert.rejects(bare.log({ range: "origin/HEAD..HEAD" }));
    const { r: empty } = repo({}, false);
    await assert.rejects(empty.log({ range: "origin/HEAD..HEAD" }));
  }
} finally { for (const d of made) rmSync(d, { recursive: true, force: true }); }
console.log("git ok");
