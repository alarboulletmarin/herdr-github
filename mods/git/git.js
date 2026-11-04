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
    return { branch, files, last, stashes };
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
  // The stash at ref, only if it is still the one the person picked.
  async stashRef(ref, oid) {
    const now = (await this.read(["rev-parse", "--verify", "-q", ref]).catch(() => "")).trim();
    if (!oid || now !== oid) throw new Error(`${ref} changed since you picked it: open the menu again`);
    return ref;
  }
  async log({ all = false, limit = 400 } = {}) {
    return parseLog(await this.read(["log", "--graph", "--date-order", ...(all ? ["--all"] : []), "-n", String(limit), `--format=${LOG_FORMAT}`]));
  }
  async show(hash) {
    const [info, patch] = await Promise.all([
      this.read(["show", "-s", "--format=%H%x1f%an%x1f%ae%x1f%ad%x1f%B", "--date=format:%Y-%m-%d %H:%M", hash]),
      this.read(["show", "--format=", "--stat=200", "--patch", "--no-color", "--no-ext-diff", hash]),
    ]);
    const [full, author, email, date, ...body] = info.split("\x1f");
    return { hash: full, author, email, date, message: body.join("\x1f").trim(), patch };
  }
  async branches() {
    const out = await this.read(["for-each-ref", "--sort=-committerdate", "refs/heads", "--format=%(refname:short)%1f%(committerdate:relative)%1f%(upstream:short)"]);
    return out.split("\n").filter(Boolean).map((l) => { const [name, when, upstream] = l.split("\x1f"); return { name, when, upstream }; });
  }
}
