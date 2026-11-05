import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, InputState, Input, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, theme, props, shared, setShared, openOverlay, closeOverlay, notify, watchFolder, nextCommand } from "herdr";
import { Repo } from "./git.js";
import { fileState, treeRows, folderCheck, syncAction, gist } from "./parse.js";
import { glyph, spinner, button, checkbox, letterColor, under, ask, confirm, MONO } from "./ui.js";
import { Diff } from "./diff.js";
import { History } from "./history.js";
import { NextCommit } from "./next-commit.js";

const ROWS = 400; // drawn at most; a bigger change set says how many more
const remembered = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; } };

// The focused terminal's folder and machine, as Herdr's Changes panel finds it.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const where = () => JSON.stringify(location());


export default class Git extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.nextCommit) { this.dialog = new NextCommit(p.nextCommit, p.overlay, cx); return; }
    if (p.diff) { this.dialog = new Diff(p.diff, p.overlay, cx); return; }
    if (p.history) { this.dialog = new History(p.history, p.overlay, cx); return; }
    if (p.menu) { this.menu = { ...p.menu, overlay: p.overlay }; return; }
    if (p.branches) { this.initBranches(p.branches, p.overlay, cx); return; }
    if (p.confirm) { this.confirming = { ...p.confirm, overlay: p.overlay }; return; }

    this.st = null; this.view = remembered("view", "tree"); this.collapsed = new Set(); this.amend = false;
    this.doneId = shared("git.do")?.id;
    this.box = TextareaState.new({ placeholder: "Commit message (Ctrl+Enter)" });
    this.box.set_auto_grow(2, 8);
    this.box.on("change", (_e, cx) => { const any = Boolean(this.box.value().trim()); if (any !== this.typed) { this.typed = any; cx.notify(); } });
    this.box.on("submit", (e, cx) => { if (e.secondary) this.commit(cx); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "refresh") this.refresh(cx);
        else if (c === "history" && this.repo) this.openHistory();
        else if (c === "diff" && this.repo) this.openDiff(null);
        else if (c === "commit") this.commit(cx);
      }
    });
  }

  // ---- reading ----
  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = where();
    if (context !== this.context) { this.context = context; this.repo = undefined; this.st = null; this.error = null; this.watched = null; }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const repo = this.repo?.root ? this.repo : await Repo.at(cwd, on);
        if (where() !== context) return;
        if (repo?.root !== this.repo?.root) this.switchMessage(repo?.root ?? null, repo?.on);
        this.repo = repo;
        if (!repo) { this.st = null; return; }
        const st = await repo.status();
        if (where() !== context) return;
        this.st = st; this.error = null;
        this.watch(repo, cx);
      } catch (e) { if (where() === context) this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }
  // Each repository keeps its own half-written message; Amend never carries over to another one.
  switchMessage(root, on) {
    (this.messages ??= {});
    if (this.msgRoot) this.messages[this.msgRoot] = this.box.value();
    this.msgRoot = root; this.amend = false; this.noVerify = false;
    this.signoff = root ? remembered(`signoff:${JSON.stringify([on ?? null, root])}`, false) : false;
    const text = (root && this.messages[root]) || "";
    this.box.set_value(text); this.typed = Boolean(text.trim());
  }
  // Every change under the folder (.git/index too) refreshes the list; reads don't write there.
  watch(repo, cx) {
    if (repo.on || this.watched === repo.root) return;
    const root = (this.watched = repo.root);
    cx.spawn(async (cx) => {
      try { while (this.watched === root) { await watchFolder(root); if (this.watched === root) this.refresh(cx); } }
      catch { this.watched = null; }
    });
  }

  // ---- acting: one git command at a time, then a fresh status ----
  act(label, cx, work, after = null) {
    if (this.busy || !this.repo) return;
    this.busy = label; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try { const out = await work(this.repo); after?.(out); }
      catch (e) { this.error = String(e?.message ?? e); notify({ title: `${label.replace(/…$/, "")} failed`, body: gist(this.error), level: "error" }); }
      finally { this.busy = null; this.loading = false; this.refresh(cx); cx.notify(); }
    });
  }
  hasHead() { return Boolean(this.st?.branch.oid); }
  toggle(paths, check, cx) { this.act(check === "off" ? "Staging…" : "Unstaging…", cx, (r) => check === "off" ? r.stage(paths) : r.unstage(paths, this.hasHead(), this.st?.files ?? [])); }

  staged() { return (this.st?.files ?? []).filter((f) => fileState(f).check !== "off"); }
  commit(cx, { message = this.box.value(), amend = this.amend, signoff = this.signoff, noVerify = this.noVerify } = {}) {
    message = message.trim();
    if (!message && !amend) return;
    this.act(amend ? "Amending…" : "Committing…", cx, (r) => r.commit(message, amend, { signoff, noVerify }), () => {
      if (this.box.value().trim() === message) { this.box.set_value(""); this.typed = false; }
      this.amend = false; this.noVerify = false;
    });
  }
  // Amend starts from the last commit's message, as Zed does; unticking leaves the box alone.
  toggleAmend(cx) {
    this.amend = !this.amend; cx.notify();
    const repo = this.repo;
    if (this.amend && !this.box.value().trim() && repo) cx.spawn(async (cx) => {
      const msg = await repo.read(["log", "-1", "--format=%B"]).catch(() => "");
      if (this.amend && this.repo === repo && !this.box.value().trim()) { this.box.set_value(msg.trim()); this.typed = Boolean(msg.trim()); cx.notify(); }
    });
  }
  // Undo the last commit, keeping its changes staged and its message in the box. Only for a commit that
  // isn't on the upstream yet: rewriting pushed history is a job for a terminal.
  uncommit(cx) {
    this.act("Uncommitting…", cx, async (r) => { const msg = await r.read(["log", "-1", "--format=%B"]); await r.run(["reset", "--soft", "HEAD~1"]); return msg; },
      (msg) => { this.box.set_value(msg.trim()); this.typed = true; });
  }
  sync(action, cx, remote = null) {
    const b = this.st?.branch ?? {}, remotes = this.st?.remotes ?? [];
    if (!remotes.length) return;
    if (!["fetch", "fetch-from", "fetch-all"].includes(action) && !b.head) return;
    if (["pull", "pull-rebase", "push", "force-push"].includes(action) && !b.upstream) return;
    if (action === "publish") {
      if (remotes.length > 1) return this.openRemotes("push-to");
      remote = remotes[0].name;
    }
    const verb = action.startsWith("fetch") ? "Fetching…" : action.startsWith("pull") ? "Pulling…" : "Pushing…";
    this.act(verb, cx, (r) => r.sync(action, { remote, upstream: Boolean(b.upstream) }), () => {
      if (!action.startsWith("fetch")) notify({ title: action.startsWith("pull") ? "Pulled" : action === "publish" ? "Published" : "Pushed", body: b.head ?? "", level: "success", timeout: 2500 });
    });
  }
  // A request from a popup or dialog (shared "git.do"), seen in render. Two copies on one repository (the
  // side panel and a pane) both see it: the first to claim it runs it. A spawned body runs at once, inside
  // this render, up to its first await: yield first, or act's notify throws mid-render with busy already
  // set ("Fetching…" for ever). Check and claim stay one synchronous step after that, so only one copy runs it.
  // ponytail: relies on mod copies sharing one script thread; separate runtimes would need an ack from the doer.
  claim(asked, cx) {
    if (asked.root !== this.repo?.root) return;
    cx.spawn(async (cx) => {
      await cx.sleep(0);
      if (shared("git.claimed") === asked.id) return;
      setShared("git.claimed", asked.id);
      this.perform(asked, cx);
    });
  }
  // What popups and dialogs asked for (shared "git.do"), once, for this repository only.
  perform({ action, arg }, cx) {
    const file = (path) => this.st?.files.find((f) => f.path === path);
    switch (action) {
      case "fetch": case "fetch-all": case "pull": case "pull-rebase": case "push": case "force-push": case "publish": return this.sync(action, cx);
      case "fetch-from": case "push-to": return this.sync(action, cx, arg);
      case "pick-fetch": return this.openRemotes("fetch-from");
      case "pick-push": return this.openRemotes("push-to");
      case "review": return this.openDiff(null);
      case "history": return this.openHistory();
      case "switch": return this.switchBranch(arg, cx);
      case "switch-merge": return this.switchBranch(arg, cx, { merge: true });
      case "switch-stash": return this.switchBranch(arg, cx, { stash: true });
      case "create": return this.act(`Creating ${arg}…`, cx, (r) => r.run(["switch", "-c", arg]));
      case "stash": return this.act("Stashing…", cx, (r) => r.run(["stash", "push", "--include-untracked", "-m", arg || `WIP on ${this.st?.branch.head ?? "HEAD"}`]));
      case "pop": return this.act("Popping the stash…", cx, async (r) => r.run(["stash", "pop", await r.stashRef(arg.ref, arg.oid)]));
      case "apply": return this.act("Applying the stash…", cx, async (r) => r.run(["stash", "apply", await r.stashRef(arg.ref, arg.oid)]));
      case "drop": return this.act("Dropping the stash…", cx, async (r) => r.run(["stash", "drop", await r.stashRef(arg.ref, arg.oid)]));
      case "discard": { const f = file(arg); return f && this.act("Discarding…", cx, (r) => r.discard(f)); }
      case "commit": return this.commit(cx, arg);
      case "uncommit": return this.uncommit(cx);
      case "refresh": return this.refresh(cx);
    }
  }

  switchBranch(name, cx, options = {}) {
    this.act(`Switching to ${name}…`, cx, async (r) => {
      try {
        await r.switchBranch(name, options);
        if (options.stash) notify({ title: `Switched to ${name}`, body: "Your changes are in the stash.", level: "success" });
      } catch (e) {
        // Offer recovery only for Git's local-change refusal, not invalid refs or worktree locks.
        if (!options.merge && !options.stash && /would be overwritten|local changes|commit your changes or stash/i.test(String(e?.message ?? e))) {
          confirm("Local changes prevent switching", `${name}\nCarry changes attempts a merge and can leave conflicts.\nStash and switch keeps changes in the stash, without applying them.`, r.root, "switch-merge", name, "Carry changes", { action: "switch-stash", arg: name, label: "Stash and switch" });
          return;
        }
        throw e;
      }
    });
  }

  // ---- opening things ----
  spec() { return { root: this.repo.root, on: this.repo.on }; }
  openDiff(path) { openOverlay({ mod: "git", kind: "dialog", width: 0.9, height: 0.9, props: { diff: { ...this.spec(), path } } }); }
  openNextCommit() { openOverlay({ mod: "git", kind: "dialog", width: 0.9, height: 0.9, props: { nextCommit: { ...this.spec(), message: this.box.value(), amend: this.amend, signoff: this.signoff, noVerify: this.noVerify } } }); }
  openHistory() { openOverlay({ mod: "git", kind: "dialog", width: 0.92, height: 0.9, props: { history: this.spec() } }); }
  openBranches() { openOverlay({ mod: "git", kind: "popup", width: 360, at: under(360, 4, this.branchBounds), props: { branches: { ...this.spec(), head: this.st?.branch.head } } }); }
  openRemotes(action) {
    const remotes = this.st?.remotes ?? [];
    if (!remotes.length) return;
    if (remotes.length === 1) { ask(this.repo.root, action, remotes[0].name); return; }
    const items = remotes.map((r) => [action, r.name, action === "fetch-from" ? "arrow-down" : "arrow-up", true, r.name, null, (action === "fetch-from" ? r.fetch : r.push) ?? r.fetch]);
    openOverlay({ mod: "git", kind: "popup", width: 380, height: 12 + items.length * 32, at: under(380), props: { menu: { ...this.spec(), kind: "remotes", items } } });
  }
  openMore() {
    const b = this.st?.branch ?? {}, stashes = this.st?.stashes ?? [], any = (this.st?.files.length ?? 0) > 0, remotes = this.st?.remotes ?? [];
    const network = remotes.length > 0 && !this.busy, branch = network && Boolean(b.head), upstream = branch && Boolean(b.upstream);
    const reason = !remotes.length ? "Add a remote first" : this.busy ? "A git command is running" : !b.head ? "HEAD is detached: switch to a branch" : !b.upstream ? "No upstream: use Push to… first" : null;
    const items = [["fetch", "Fetch", "refresh", network, null, !network ? reason : null], ["pick-fetch", "Fetch from…", "refresh", network, null, !network ? reason : null],
      ...(remotes.length > 1 ? [["fetch-all", "Fetch all", "refresh", network, null, !network ? reason : null]] : []),
      ["pull", "Pull", "arrow-down", upstream, null, !upstream ? reason : null], ["pull-rebase", "Pull (rebase)", "arrow-down", upstream, null, !upstream ? reason : null],
      ["push", "Push", "arrow-up", upstream, null, !upstream ? reason : null], ["pick-push", "Push to…", "arrow-up", branch, null, !branch ? reason : null],
      ["force-ask", "Force push…", "arrow-up", upstream, null, !upstream ? reason : null],
      null, ["review", "Review changes", "diff"], ["history", "History and graph", "history"],
      null, ["stash", "Stash all changes", "archive", any], ...(stashes.length ? [["pop", `Pop ${stashes[0].ref}`, "archive", true, stashes[0]]] : []),
      ...stashes.slice(0, 6).map((s) => ["stash-menu", `${s.ref} · ${s.subject}`, "clock", true, s])];
    openOverlay({ mod: "git", kind: "popup", width: 300, height: 12 + items.reduce((h, i) => h + (i ? 32 : 9), 0), at: under(300), props: { menu: { ...this.spec(), kind: "more", branch: b.head, upstream: b.upstream, items } } });
  }
  fileMenu(f) {
    const items = [["diff", "Open diff", "diff"], ["copy", "Copy path", "copy"], null, ["discard-ask", f.untracked ? "Delete this new file…" : "Discard changes…", "discard"]];
    openOverlay({ mod: "git", kind: "popup", width: 240, height: 12 + 3 * 32 + 9, at: "pointer", props: { menu: { kind: "file", root: this.repo.root, on: this.repo.on, path: f.path, untracked: f.untracked, items } } });
  }

  // ---- drawing ----
  // files: the row's section, so a folder's checkbox covers what that section lists under it, nothing else.
  row(r, t, cx, sec, files) {
    const f = r.file, s = f ? fileState(f) : null, check = f ? s.check : folderCheck(files, r.path);
    const paths = f ? [f.path] : files.filter((x) => x.path.startsWith(`${r.path}/`)).map((x) => x.path);
    const folded = r.dir && this.collapsed.has(r.path);
    return h_flex().id(`row-${sec}-${r.dir ? "d" : "f"}-${r.path}`).h(26).flex_none().pl(8 + r.depth * 14).pr(10).gap(6).items_center().rounded(5).cursor_pointer().hover((x) => x.bg(t.hover))
      .on_click((_e, cx) => { if (r.dir) { folded ? this.collapsed.delete(r.path) : this.collapsed.add(r.path); cx.notify(); } else this.openDiff(f.path); })
      .when(!r.dir, (e) => e.on_mouse_down("right", () => this.fileMenu(f)))
      .child(r.dir ? glyph(folded ? "chevron-right" : "chevron-down", 12, t.dim) : div().w(12).flex_none())
      .child(checkbox(`check-${sec}-${r.path}`, check, t, (_e, cx) => this.toggle(paths, check, cx)))
      .child(r.dir ? glyph("folder", 13, t.muted) : div().w(13).flex_none().text_size(11).font_semibold().text_color(letterColor(s.letter, t)).child(s.letter))
      .child(div().flex_1().min_w(0).truncate().text_color(r.dir ? t.muted : s.letter === "D" ? t.dim : t.foreground).child(r.name))
      .when(Boolean(f?.orig), (e) => e.child(div().max_w(120).truncate().text_size(11).text_color(t.dim).child(`← ${f.orig.split("/").pop()}`)))
      .when(f?.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f?.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }
  section(id, label, files, t, cx) {
    if (!files.length) return [];
    const checks = files.map((f) => fileState(f).check), check = checks.every((c) => c === "on") ? "on" : checks.every((c) => c === "off") ? "off" : "partial";
    const head = h_flex().id(`section-${id}`).h(28).flex_none().px(8).gap(6).items_center().text_size(11.5).font_semibold().text_color(t.muted)
      .child(div().w(12).flex_none())
      .child(checkbox(`check-section-${id}`, check, t, (_e, cx) => this.toggle(files.map((f) => f.path), check, cx)))
      .child(div().child(label)).child(div().text_color(t.dim).child(String(files.length)));
    const rows = this.view === "tree" ? treeRows(files, this.collapsed)
      : [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => ({ dir: false, path: f.path, name: f.path, depth: 0, file: f }));
    return [head, ...rows.map((r) => this.row(r, t, cx, id, files))];
  }

  render(cx) {
    const t = theme();
    if (this.dialog) return this.dialog.render(cx);
    if (this.menu) return renderMenu(this.menu, t);
    if (this.picking) return this.renderBranches(t);
    if (this.confirming) return renderConfirm(this.confirming, t);

    if (where() !== this.context) this.refresh(cx);
    const asked = shared("git.do");
    if (asked?.id && asked.id !== this.doneId) { this.doneId = asked.id; this.claim(asked, cx); }

    const shell = v_flex().id("git").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13);
    if (!this.repo) return shell.child(this.title(t, null)).child(div().p(14).text_color(t.dim).child(this.error ?? (this.repo === null ? "Not a git repository. Focus a terminal inside one." : "Looking for a repository…")));
    const st = this.st, files = st?.files ?? [], b = st?.branch ?? {};
    const conflicts = files.filter((f) => f.conflict), tracked = files.filter((f) => !f.conflict && !f.untracked), untracked = files.filter((f) => f.untracked);
    const rows = [...this.section("conflicts", "Conflicts", conflicts, t, cx), ...this.section("tracked", "Tracked", tracked, t, cx), ...this.section("untracked", "Untracked", untracked, t, cx)];
    const staged = this.staged().length, sync = syncAction(b);
    const canCommit = !this.busy && Boolean(this.amend || (this.typed && (staged > 0 || tracked.length > 0 || conflicts.length > 0)));
    const commitLabel = this.amend ? "Amend" : staged > 0 ? `Commit ${staged}` : "Commit tracked";
    const canUncommit = Boolean(st?.last) && !st.last.root && (!b.upstream || b.ahead > 0);

    return shell
      .child(this.title(t, b, sync))
      .child(h_flex().flex_none().h(34).px(10).gap(6).items_center().border_b(1).border_color(t.border).text_size(12).text_color(t.muted)
        .child(div().flex_1().min_w(0).truncate().child(files.length ? `${files.length} changed · ${staged} staged` : "No changes"))
        .child(button("view", "", t, (_e, cx) => { this.view = this.view === "tree" ? "list" : "tree"; localStorage.setItem("view", JSON.stringify(this.view)); cx.notify(); }, { icon: this.view === "tree" ? "list" : "tree", invisible: true, small: true, tooltip: this.view === "tree" ? "Show as a list" : "Show as a tree" }))
        .child(button("diff-all", "", t, () => this.openDiff(null), { icon: "diff", invisible: true, small: true, tooltip: "Review every change", enabled: files.length > 0 }))
        .child(button("stage-all", staged === files.length && files.length ? "Unstage all" : "Stage all", t, (_e, cx) => this.toggle(["."], staged === files.length ? "on" : "off", cx), { small: true, enabled: files.length > 0 && !this.busy })))
      .child(v_flex().id("files").flex_1().min_h(0).overflow_y_scrollbar().p(4)
        .children(rows.slice(0, ROWS))
        .when(rows.length > ROWS, (e) => e.child(div().px(10).py(6).text_size(11).text_color(t.dim).child(`${rows.length - ROWS} more rows: open the review to see them all`)))
        .when(!files.length && Boolean(st), (e) => e.child(v_flex().items_center().gap(6).py(28).text_color(t.dim).child(glyph("check", 20, t.dim)).child("Working tree clean"))))
      .when(Boolean(this.error), (e) => e.child(div().px(12).py(6).text_size(11.5).text_color(t.ansi1).child(this.error)))
      .child(v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("message").px(10).py(8).rounded(8).border_1().border_color(t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.box).w_full().text_size(12.5).text_color(t.foreground)))
        .child(h_flex().gap(8).items_center()
          .child(h_flex().id("amend").gap(6).items_center().cursor_pointer().text_size(12).text_color(this.amend ? t.foreground : t.muted).when(this.hasHead(), (e) => e.on_click((_e, cx) => this.toggleAmend(cx)))
            .child(checkbox("amend-box", this.amend ? "on" : "off", t, (_e, cx) => { if (this.hasHead()) this.toggleAmend(cx); })).child("Amend"))
          .child(this.commitOption("signoff", "Sign off", this.signoff, t, (_e, cx) => {
            this.signoff = !this.signoff; localStorage.setItem(`signoff:${JSON.stringify([this.repo.on ?? null, this.repo.root])}`, JSON.stringify(this.signoff)); cx.notify();
          }))
          .child(this.commitOption("no-verify", "Skip hooks", this.noVerify, t, (_e, cx) => { this.noVerify = !this.noVerify; cx.notify(); })))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1())
          .when(Boolean(this.busy), (e) => e.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child(spinner(12, t.muted)).child(this.busy)))
          .child(button("next-commit", "Preview", t, () => this.openNextCommit(), { icon: "diff", enabled: !this.busy && Boolean(st) && (this.amend || files.some((f) => !f.untracked)), tooltip: "Preview the next commit" }))
          .child(button("commit", commitLabel, t, (_e, cx) => this.commit(cx), { primary: true, icon: "commit", enabled: canCommit }))))
      .when(Boolean(st?.last), (e) => e.child(h_flex().flex_none().h(34).px(10).gap(8).items_center().border_t(1).border_color(t.border).text_size(12)
        .child(glyph("commit", 13, t.dim)).child(div().font_family(MONO).text_size(11).text_color(t.dim).child(st.last.short))
        .child(div().flex_1().min_w(0).truncate().child(st.last.subject)).child(div().text_color(t.dim).child(st.last.when))
        .child(button("uncommit", "Uncommit", t, (_e, cx) => this.uncommit(cx), { small: true, icon: "undo", enabled: canUncommit && !this.busy, tooltip: canUncommit ? "Undo it, keeping its changes staged" : st.last.root ? "The first commit has nothing to go back to" : "Already pushed: undo it from a terminal" }))));
  }
  title(t, b, sync) {
    return h_flex().flex_none().h(42).px(8).gap(4).items_center().border_b(1).border_color(t.border)
      .child(h_flex().id("branch").flex_1().min_w(0).h(28).px(6).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.branchBounds = e.bounds; })
        .on_click(() => b && this.openBranches())
        .child(glyph("branch", 14, t.muted))
        .child(div().min_w(0).truncate().font_semibold().child(b ? b.head ?? `detached ${b.oid?.slice(0, 7) ?? ""}` : "Git"))
        .when(Boolean(b), (e) => e.child(glyph("chevron-down", 12, t.muted)))
        .when(Boolean(b?.upstream) && (b.ahead || b.behind), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`${b.ahead ? `↑${b.ahead}` : ""}${b.behind ? ` ↓${b.behind}` : ""}`))))
      .when(Boolean(b), (e) => e
        .child(this.loading && !this.busy ? div().px(6).child(spinner(13, t.dim)) : div())
        .child(button("history", "", t, () => this.openHistory(), { icon: "history", invisible: true, tooltip: "History and graph" }))
        .child(button("sync", sync.label, t, (_e, cx) => this.sync(sync.action, cx), { icon: { pull: "arrow-down", push: "arrow-up", publish: "arrow-up" }[sync.action] ?? "refresh", enabled: !this.busy && (this.st?.remotes?.length ?? 0) > 0, tooltip: this.st?.remotes?.length ? null : "Add a remote first" }))
        .child(button("more", "", t, () => this.openMore(), { icon: "more", invisible: true, tooltip: "Fetch, pull, push, stash" })));
  }

  commitOption(id, label, checked, t, toggle) {
    return h_flex().id(id).gap(6).items_center().cursor_pointer().text_size(12).text_color(checked ? t.foreground : t.muted).on_click(toggle)
      .child(checkbox(`${id}-box`, checked ? "on" : "off", t, toggle)).child(label);
  }

  // ---- the branch picker (a popup of this mod) ----
  initBranches(spec, overlay, cx) {
    this.picking = { ...spec, overlay, list: null, q: "", selected: 0 };
    this.branchFocus = cx.focus_handle(); this.branchScroll = VirtualListScrollHandle.new();
    this.filter = InputState.new({ placeholder: "Switch to or create a branch…" });
    this.filter.on("change", (_e, cx) => { this.picking.q = this.filter.value().trim(); this.picking.selected = 0; this.branchScroll.scroll_to_item(0); cx.notify(); });
    this.filter.on("submit", () => this.chooseBranch());
    this.filter.focus();
    cx.spawn(async (cx) => { try { this.picking.list = await new Repo(spec.root, spec.on).branches(); } catch (e) { this.picking.error = String(e?.message ?? e); } cx.notify(); });
  }
  branchItems() {
    const p = this.picking, list = (p.list ?? []).filter((b) => b.name.toLowerCase().includes(p.q.toLowerCase()));
    const local = list.filter((b) => !b.remote).sort((a, b) => Number(b.name === p.head) - Number(a.name === p.head));
    const remote = list.filter((b) => b.remote), items = [...local];
    if (remote.length) items.push({ section: true, name: "Remote" }, ...remote);
    const fresh = p.list && p.q && !(p.list ?? []).some((b) => b.name === p.q) && /^[^\s~^:?*[\\]+$/.test(p.q);
    if (fresh) items.unshift({ name: p.q, create: true });
    return items;
  }
  chooseBranch() {
    const b = this.branchItems().filter((b) => !b.section)[this.picking.selected];
    if (b) this.pickBranch(b.name, b.create);
  }
  branchKey(e, cx) {
    const p = this.picking, items = this.branchItems(), choices = items.filter((b) => !b.section);
    if (e.key === "escape") { cx.stop_propagation(); closeOverlay(p.overlay); }
    else if (e.key === "enter") { cx.stop_propagation(); this.chooseBranch(); }
    else if (e.key === "up" || e.key === "down") {
      cx.stop_propagation();
      p.selected = Math.max(0, Math.min(choices.length - 1, p.selected + (e.key === "down" ? 1 : -1)));
      const index = items.indexOf(choices[p.selected]);
      if (index >= 0) this.branchScroll.scroll_to_item(index, "center");
      cx.notify();
    }
  }
  pickBranch(name, create = false) {
    const p = this.picking;
    if (!name || !p.list) return;
    if (name !== p.head || create) ask(p.root, create ? "create" : "switch", name);
    closeOverlay(p.overlay);
  }
  renderBranches(t) {
    const p = this.picking, items = this.branchItems(), choices = items.filter((b) => !b.section), selected = choices[p.selected];
    const height = Math.min(330, items.reduce((h, b) => h + (b.section ? 24 : 32), 0));
    const key = (b) => `${b.section ? "section" : b.create ? "create" : b.remote ? "remote" : "local"}-${b.name}`;
    return v_flex().id("branches").w_full().p(6).gap(4).bg(t.popover).text_color(t.foreground).text_size(13)
      .track_focus(this.branchFocus).on_key_down((e, cx) => this.branchKey(e, cx))
      .child(div().h(30).flex_none().px(8).flex().items_center().rounded(6).border_1().border_color(t.border).child(Input.new(this.filter).w_full().text_size(12.5)))
      .when(!p.list || !items.length, (e) => e.child(div().px(8).py(6).text_color(p.error ? t.ansi1 : t.muted).child(p.error ?? (p.list ? "No matching branches" : "Reading branches…"))))
      .when(items.length > 0, (e) => e.child(v_virtual_list("branch-list", items.length, items.map((b) => b.section ? 24 : 32), (i) => key(items[i]), (range) => items.slice(range.start, range.end).map((b) => {
        if (b.section) return div().h(24).flex_none().px(8).pt(4).text_size(11).text_color(t.dim).child("Remote");
        // Rows take no handlers inside a virtual list: the list's on_item_click picks by key.
        return h_flex().h(32).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().text_color(b.remote ? t.muted : t.foreground)
          .when(b === selected, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
          .child(div().w(14).flex_none().when(b.create || (!b.remote && b.name === p.head), (e) => e.child(glyph(b.create ? "plus" : "check", 14, t.foreground))))
          .child(div().flex_1().min_w(0).truncate().child(b.create ? `Create branch “${b.name}”` : b.remote ? `origin/${b.name}` : b.name))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(b.when ?? ""));
      })).h(height).w_full().track_scroll(this.branchScroll)
        .on_item_click((k) => { const b = items.find((b) => !b.section && key(b) === k); if (b) this.pickBranch(b.name, b.create); })));
  }
}

function menuRow(id, label, icon, t, onClick, enabled = true, tooltip = null, detail = null) {
  return h_flex().id(id).h(32).flex_none().px(8).gap(8).items_center().rounded(6).text_color(enabled ? t.foreground : t.dim)
    .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick))
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
    .child(glyph(icon, 14, enabled ? t.muted : t.dim)).child(div().min_w(0).truncate().when(Boolean(detail), (e) => e.flex_none()).when(!detail, (e) => e.flex_1()).child(label))
    .when(Boolean(detail), (e) => e.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(detail)));
}

// Items: [action, label, icon, enabled?, arg?, tooltip?, detail?] or null (a line).
function renderMenu(m, t) {
  const done = () => closeOverlay(m.overlay);
  return v_flex().id("menu").size_full().p(6).gap(0).bg(t.popover).text_color(t.foreground).text_size(13)
    .children(m.items.map((i, n) => {
      if (!i) return div().h(1).my(4).bg(t.border);
      const [action, label, icon, enabled = true, arg, tooltip, detail] = i;
      const stash = arg;
      return menuRow(`m-${n}`, label, icon, t, (_e, cx) => {
        if (action === "diff") openOverlay({ mod: "git", kind: "dialog", width: 0.9, height: 0.9, props: { diff: { root: m.root, on: m.on, path: m.path } } });
        else if (action === "force-ask") confirm("Force push this branch?", `${m.branch} → ${m.upstream}\nThis rewrites remote history using --force-with-lease.\nGit refuses if the remote changed since your last fetch.`, m.root, "force-push", null, "Force push");
        else if (action === "copy") cx.write_to_clipboard(m.path);
        else if (action === "discard-ask") confirm(m.untracked ? "Delete this new file?" : "Discard its changes?", `${m.path}\n${m.untracked ? "The file isn't tracked: it is deleted, and git can't bring it back." : "Staged and unstaged changes go back to the last commit. Git can't bring them back."}`, m.root, "discard", m.path, m.untracked ? "Delete" : "Discard");
        else if (action === "stash-menu") { done(); return openOverlay({ mod: "git", kind: "popup", width: 240, height: 12 + 3 * 32, at: "pointer", props: { menu: { kind: "stash", root: m.root, items: [["apply", `Apply ${stash.ref}`, "archive", true, stash], ["pop", `Pop ${stash.ref}`, "archive", true, stash], ["drop-ask", "Drop…", "discard", true, stash]] } } }); }
        else if (action === "drop-ask") confirm(`Drop ${stash.ref}?`, `${stash.subject}\nIts changes are gone for good.`, m.root, "drop", { ref: stash.ref, oid: stash.oid }, "Drop");
        else ask(m.root, action, m.kind === "remotes" ? arg : stash ? { ref: stash.ref, oid: stash.oid } : null);
        done();
      }, enabled, tooltip, detail);
    }));
}

function renderConfirm(c, t) {
  return v_flex().id("confirm").size_full().p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
    .child(div().text_size(15).font_semibold().child(c.title))
    .children(c.detail.split("\n").map((l, n) => div().text_color(n ? t.muted : t.foreground).when(!n, (e) => e.font_family(MONO)).text_size(n ? 12.5 : 12).child(l)))
    .child(div().flex_1())
    .child(h_flex().gap(8).justify_end()
      .child(button("no", "Cancel", t, () => closeOverlay(c.overlay)))
      .when(Boolean(c.alternative), (e) => e.child(button("alternative", c.alternative.label, t, () => { ask(c.root, c.alternative.action, c.alternative.arg); closeOverlay(c.overlay); })))
      .child(h_flex().id("yes").h(28).px(12).items_center().rounded(6).bg(t.ansi1).text_color("#ffffff").font_medium().text_size(12).cursor_pointer().hover((s) => s.opacity(0.88))
        .on_click(() => { ask(c.root, c.action, c.arg); closeOverlay(c.overlay); }).child(c.yes)));
}
