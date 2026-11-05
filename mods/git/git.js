import { exec } from "herdr";
import { parseStatus, parseNumstat, parseDiff, patchOf, parseLog, LOG_FORMAT } from "./parse.js";

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie): the folder watch
// would see it, and every refresh would start the next one. (Herdr's Changes panel does the same.)
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
// File names are names, not patterns: "[a].txt" must not also mean "a.txt".
const LITERAL = ["--literal-pathspecs"];

// One repository: its top folder and the machine it lives on (null: this one).
export class Repo {
  constructor(root, on) { this.root = root; this.on = on; }
  static async at(cwd, on) {
    const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
    return r.code === 0 ? new Repo(r.stdout.trim(), on) : null;
  }
  async run(args, read = false) {
    // herdr stops a command after 30 s and rejects with that reason, so the panel never waits longer.
    const r = await exec("git", [...LITERAL, ...(read ? READ : []), ...args], { cwd: this.root, on: this.on });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
    return r.stdout;
  }
  read(args) { return this.run(args, true); }

  async status() {
    const { branch, files } = parseStatus(await this.read(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]));
    const outs = branch.oid ? [await this.read(["diff", "HEAD", "--numstat", "-z", "--no-renames"])]
      : [await this.read(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await this.read(["diff", "--numstat", "-z", "--no-renames"])];
    const stats = parseNumstat(outs);
    for (const f of files) Object.assign(f, stats[f.path] ?? { add: 0, del: 0, binary: false });
    const last = branch.oid ? await this.read(["log", "-1", "--format=%h%x1f%s%x1f%ar%x1f%P"]).then((o) => { const [short, subject, when, parents] = o.trim().split("\x1f"); return { short, subject, when, root: !parents }; }) : null;
    // A stash is named by its position (stash@{0}), which moves; its oid lets a confirm check it is still the same one.
    const stashes = (await this.read(["stash", "list", "--format=%gd%x1f%s%x1f%cr%x1f%H"]).catch(() => "")).split("\n").filter(Boolean).map((l) => { const [ref, subject, when, oid] = l.split("\x1f"); return { ref, subject, when, oid }; });
    return { branch, files, last, stashes, remotes: await this.remotes() };
  }

  async remotes() {
    const out = await this.read(["remote", "-v"]), remotes = new Map();
    for (const line of out.split("\n")) {
      const m = /^(\S+)\s+(.*?) \((fetch|push)\)$/.exec(line);
      if (m) { const r = remotes.get(m[1]) ?? { name: m[1] }; r[m[3]] = m[2]; remotes.set(m[1], r); }
    }
    return [...remotes.values()];
  }
  sync(action, { remote = null, upstream = false } = {}) {
    if (action === "fetch" || action === "fetch-from") return this.run(["fetch", "--prune", ...(remote ? [remote] : [])]);
    if (action === "fetch-all") return this.run(["fetch", "--all", "--prune"]);
    if (action === "pull" || action === "pull-rebase") return this.run(["pull", ...(action === "pull-rebase" ? ["--rebase"] : [])]);
    return this.run(["push", ...(action === "force-push" ? ["--force-with-lease"] : []), ...(remote && !upstream ? ["-u"] : []), ...(remote ? [remote, "HEAD"] : [])]);
  }

  // Staging: whole paths (files or folders), or one hunk through git apply. The patch goes as an
  // argument to sh, so it works on another machine too (exec has no stdin).
  stage(paths) { return this.run(["add", "-A", "--", ...paths]); }
  // A rename is staged under both names: unstaging only the new one would leave the old one staged as deleted.
  unstage(paths, hasHead, files = []) {
    const all = [...new Set([...paths, ...files.filter((f) => f.orig && paths.includes(f.path)).map((f) => f.orig)])];
    return hasHead ? this.run(["restore", "--staged", "--", ...all]) : this.run(["rm", "-r", "-q", "--cached", "-f", "--", ...all]);
  }
  async applyHunk(header, hunk, { reverse = false, cached = true } = {}) {
    const args = ["apply", ...(cached ? ["--cached"] : []), ...(reverse ? ["-R"] : []), "-"].join(" ");
    const r = await exec("sh", ["-c", `printf "%s" "$1" | git ${args}`, "sh", patchOf(header, hunk)], { cwd: this.root, on: this.on });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "git apply failed");
  }
  // Throws away a file's changes: tracked ones back to HEAD (index and tree), untracked ones deleted.
  async discard(file) {
    if (file.untracked) return this.run(["clean", "-f", "-q", "--", file.path]);
    if (file.x === "A") return this.run(["rm", "-f", "-q", "--", file.path]);
    return this.run(["restore", "--staged", "--worktree", "--source=HEAD", "--", file.path, ...(file.orig ? [file.orig] : [])]);
  }

  // Fixed a/ and b/ prefixes whatever diff.noprefix says: git apply expects them. A staged rename is
  // diffed under both names (-M), so it reads as a rename with its edits, not a whole new file.
  async diff(path, staged, orig = null) {
    const names = staged && orig ? ["-M", "--", orig, path] : ["--", path];
    return parseDiff(await this.read(["diff", ...(staged ? ["--cached"] : []), "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--no-color", ...names]));
  }
  // The preview and the commit choose the same scope; Amend never picks up unstaged edits.
  async nextCommit(amend = false) {
    const { branch, files } = await this.status();
    if (files.some((f) => f.conflict)) throw new Error("Resolve conflicts before committing");
    const tracked = !amend && !files.some((f) => !f.untracked && f.x !== ".");
    const base = tracked ? (branch.oid ? ["HEAD"] : []) : ["--cached"];
    const changes = await Promise.all(files.filter((f) => !f.untracked && (tracked || f.x !== ".")).map(async (f) => {
      const diff = parseDiff(await this.read(["diff", ...base, "-M", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--no-color", "--", ...(f.orig ? [f.orig] : []), f.path]));
      // Count this patch, not status()'s HEAD-to-worktree totals (a partly staged file has two versions).
      const lines = diff.hunks.flatMap((h) => h.lines);
      return { path: f.path, orig: f.orig ?? null, diff, add: lines.filter((l) => l.startsWith("+")).length, del: lines.filter((l) => l.startsWith("-")).length, binary: diff.header.some((l) => l.startsWith("Binary files ")) };
    }));
    return { tracked, files: changes };
  }
  async commit(message, amend = false, { signoff = false, noVerify = false } = {}) {
    const { files } = await this.status();
    const staged = files.some((f) => !f.untracked && f.x !== ".");
    if (!staged && !amend && !files.some((f) => !f.untracked)) throw new Error("No tracked changes to commit");
    return this.run(["commit", ...(staged || amend ? [] : ["-a"]), ...(amend ? ["--amend"] : []), ...(signoff ? ["--signoff"] : []), ...(noVerify ? ["--no-verify"] : []), ...(message ? ["-m", message] : ["--no-edit"])]);
  }
  // The stash at ref, only if it is still the one the person picked.
  async stashRef(ref, oid) {
    const now = (await this.read(["rev-parse", "--verify", "-q", ref]).catch(() => "")).trim();
    if (!oid || now !== oid) throw new Error(`${ref} changed since you picked it: open the menu again`);
    return ref;
  }
  // range: a revision range such as "origin/HEAD..HEAD" (ignored with all).
  async log({ all = false, range = null, limit = 400 } = {}) {
    return parseLog(await this.read(["log", "--graph", "--date-order", "-n", String(limit), `--format=${LOG_FORMAT}`, ...(all ? ["--all"] : range ? [range, "--"] : [])]));
  }
  async show(hash) {
    const [info, patch] = await Promise.all([
      this.read(["show", "-s", "--format=%H%x1f%an%x1f%ae%x1f%ad%x1f%B", "--date=format:%Y-%m-%d %H:%M", hash]),
      this.read(["show", "--format=", "--stat=200", "--patch", "--no-color", "--no-ext-diff", hash]),
    ]);
    const [full, author, email, date, ...body] = info.split("\x1f");
    return { hash: full, author, email, date, message: body.join("\x1f").trim(), patch };
  }
  async switchBranch(name, { merge = false, stash = false } = {}) {
    // Stash passes internal pathspecs to clean: literal mode would leave untracked files behind.
    if (stash) await this.run(["--no-literal-pathspecs", "stash", "push", "--include-untracked", "-m", `Before switching to ${name}`]);
    // Explicit origin guessing avoids ambiguity when another remote has the same branch.
    return this.run(["-c", "checkout.defaultRemote=origin", "switch", ...(merge ? ["--merge"] : []), "--", name]);
  }
  async branches() {
    const out = await this.read(["for-each-ref", "--sort=-committerdate", "refs/heads", "refs/remotes/origin", "--format=%(refname)%1f%(committerdate:relative)%1f%(upstream:short)%1f%(symref)"]);
    const rows = out.split("\n").filter(Boolean).map((l) => {
      const [ref, when, upstream, symref] = l.split("\x1f"), remote = ref.startsWith("refs/remotes/");
      return { name: ref.slice(remote ? "refs/remotes/origin/".length : "refs/heads/".length), when, upstream, remote, symref };
    });
    const locals = new Set(rows.filter((b) => !b.remote).map((b) => b.name));
    return rows.filter((b) => !b.symref && (!b.remote || !locals.has(b.name))).map(({ symref, ...b }) => b);
  }
}
