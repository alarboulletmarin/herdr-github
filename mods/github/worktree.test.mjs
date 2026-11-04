// node mods/github/worktree.test.mjs : prepareWorktree (actions.js) against a real clone and its origin, with a stand-in for herdr.
import { registerHooks } from "module";
import assert from "assert";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const top = mkdtempSync(join(tmpdir(), "herdr-wt-"));
const stub = `import { execFile } from "child_process";
export const exec = (cmd, args = [], { cwd } = {}) => new Promise((ok) => execFile(cmd, args, { cwd }, (e, stdout, stderr) => ok({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
export const home = () => ${JSON.stringify(join(top, "home"))};
const none = () => null; export { none as run, none as notify, none as openOverlay, none as closeOverlay, none as setShared };
export const knownAgents = async () => [], spaces = () => [], panes = () => [], agents = () => [], shared = () => null;`;
registerHooks({ resolve: (spec, ctx, next) => spec === "herdr" ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
  : spec === "gpui-kit" || spec === "gpui-base" ? { url: `data:text/javascript,${encodeURIComponent("const f = () => new Proxy(() => f(), { get: () => f }); export const div = f, svg = f, image = f, v_flex = f, h_flex = f;")}`, shortCircuit: true }
  : next(spec, ctx) });
const { prepareWorktree } = await import("./actions.js");

const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
try {
  const origin = join(top, "origin.git"), clone = join(top, "clone");
  sh(top, "init", "-q", "--bare", "-b", "main", origin); sh(top, "clone", "-q", origin, clone);
  sh(clone, "config", "user.email", "t@t"); sh(clone, "config", "user.name", "t");
  writeFileSync(join(clone, "a"), "1\n"); sh(clone, "add", "a"); sh(clone, "commit", "-qm", "one"); sh(clone, "push", "-q", "origin", "main"); sh(clone, "remote", "set-head", "origin", "main");
  writeFileSync(join(clone, "a"), "dirty\n"); // the clone's own uncommitted work is left alone

  const task = { folder: clone, ref: "me/proj#12", work: { kind: "issue", number: 12, title: "Export a note", labels: ["bug"] } };
  const wt = await prepareWorktree(task);
  assert.deepEqual(wt, { folder: join(top, "home/.herdr/worktrees/proj/fix-12-export-a-note"), branch: "fix/12-export-a-note", base: "origin/main", reused: false });
  assert.equal(sh(wt.folder, "rev-parse", "--abbrev-ref", "HEAD"), "fix/12-export-a-note");
  assert.equal(sh(clone, "status", "--porcelain"), "M a", "the clone keeps its changes and its branch");
  assert.equal(sh(clone, "rev-parse", "--abbrev-ref", "HEAD"), "main");

  const again = await prepareWorktree(task);
  assert.equal(again.folder, wt.folder); assert.equal(again.reused, true, "a second start reuses it");

  // The branch exists but its worktree was removed: checked out again, not recreated.
  sh(clone, "worktree", "remove", "--force", wt.folder);
  const back = await prepareWorktree(task);
  assert.equal(back.reused, true); assert.equal(back.base, null); assert.ok(existsSync(back.folder));

  // No origin/HEAD (offline, or never set): the clone's current branch is the base.
  sh(clone, "remote", "set-head", "origin", "--delete"); sh(clone, "config", "remote.origin.followRemoteHEAD", "never"); // git ≥ 2.48 would recreate it on fetch
  const other = await prepareWorktree({ ...task, ref: "me/proj#13", work: { kind: "issue", number: 13, title: "Other", labels: [] } });
  assert.equal(other.base, "main"); assert.equal(other.branch, "feat/13-other");
} finally { rmSync(top, { recursive: true, force: true }); }
console.log("worktree ok");
