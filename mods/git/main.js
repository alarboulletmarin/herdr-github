import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, InputState, Input } from "gpui-base";
import { spaces, panes, focused, theme, props, shared, setShared, openOverlay, closeOverlay, notify, watchFolder, nextCommand } from "herdr";
import { Repo } from "./git.js";
import { fileState, treeRows, folderCheck, syncAction } from "./parse.js";
import { glyph, spinner, button, checkbox, letterColor, under, ask, confirm, MONO } from "./ui.js";
import { Diff } from "./diff.js";
import { History } from "./history.js";

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
        if (repo?.root !== this.repo?.root) this.switchMessage(repo?.root ?? null);
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
  switchMessage(root) {
    (this.messages ??= {});
    if (this.msgRoot) this.messages[this.msgRoot] = this.box.value();
    this.msgRoot = root; this.amend = false;
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
      catch (e) { this.error = String(e?.message ?? e); notify({ title: `${label.replace(/…$/, "")} failed`, body: this.error, level: "error" }); }
      finally { this.busy = null; this.loading = false; this.refresh(cx); cx.notify(); }
    });
  }
  hasHead() { return Boolean(this.st?.branch.oid); }
  toggle(paths, check, cx) { this.act(check === "off" ? "Staging…" : "Unstaging…", cx, (r) => check === "off" ? r.stage(paths) : r.unstage(paths, this.hasHead(), this.st?.files ?? [])); }

  staged() { return (this.st?.files ?? []).filter((f) => fileState(f).check !== "off"); }
  commit(cx) {
    const message = this.box.value().trim(), staged = this.staged().length > 0;
    if (!message && !this.amend) return;
    if (!staged && !this.amend && !(this.st?.files ?? []).some((f) => !f.untracked)) return;
    const args = ["commit", ...(staged || this.amend ? [] : ["-a"]), ...(this.amend ? ["--amend"] : []), ...(message ? ["-m", message] : ["--no-edit"])];
    this.act(this.amend ? "Amending…" : "Committing…", cx, (r) => r.run(args), () => { this.box.set_value(""); this.typed = false; this.amend = false; });
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
  sync(action, cx) {
    const label = { fetch: "Fetching…", pull: "Pulling…", push: "Pushing…", publish: "Publishing…" }[action];
    this.act(label, cx, async (r) => {
      if (action === "fetch") return r.run(["fetch", "--prune"]);
      if (action === "pull") return r.run(["pull"]);
      if (action === "push") return r.run(["push"]);
      const remote = (await r.read(["remote"])).split("\n").find(Boolean);
      if (!remote) throw new Error("No remote to publish to: add one with git remote add");
      return r.run(["push", "-u", remote, "HEAD"]);
    }, () => action !== "fetch" && notify({ title: { pull: "Pulled", push: "Pushed", publish: "Published" }[action], body: this.st?.branch.head ?? "", level: "success", timeout: 2500 }));
  }
  // What popups and dialogs asked for (shared "git.do"), once, for this repository only.
  perform({ action, arg }, cx) {
    const file = (path) => this.st?.files.find((f) => f.path === path);
    switch (action) {
      case "fetch": case "pull": case "push": case "publish": return this.sync(action, cx);
      case "switch": return this.act(`Switching to ${arg}…`, cx, (r) => r.run(["switch", arg]));
      case "create": return this.act(`Creating ${arg}…`, cx, (r) => r.run(["switch", "-c", arg]));
      case "stash": return this.act("Stashing…", cx, (r) => r.run(["stash", "push", "--include-untracked", "-m", arg || `WIP on ${this.st?.branch.head ?? "HEAD"}`]));
      case "pop": return this.act("Popping the stash…", cx, async (r) => r.run(["stash", "pop", await r.stashRef(arg.ref, arg.oid)]));
      case "apply": return this.act("Applying the stash…", cx, async (r) => r.run(["stash", "apply", await r.stashRef(arg.ref, arg.oid)]));
      case "drop": return this.act("Dropping the stash…", cx, async (r) => r.run(["stash", "drop", await r.stashRef(arg.ref, arg.oid)]));
      case "discard": { const f = file(arg); return f && this.act("Discarding…", cx, (r) => r.discard(f)); }
      case "uncommit": return this.uncommit(cx);
      case "refresh": return this.refresh(cx);
    }
  }

  // ---- opening things ----
  spec() { return { root: this.repo.root, on: this.repo.on }; }
  openDiff(path) { openOverlay({ mod: "git", kind: "dialog", width: 0.9, height: 0.9, props: { diff: { ...this.spec(), path } } }); }
  openHistory() { openOverlay({ mod: "git", kind: "dialog", width: 0.92, height: 0.9, props: { history: this.spec() } }); }
  openBranches() { openOverlay({ mod: "git", kind: "popup", width: 320, height: 420, at: under(320), props: { branches: { ...this.spec(), head: this.st?.branch.head } } }); }
  openMore() {
    const b = this.st?.branch ?? {}, stashes = this.st?.stashes ?? [], any = (this.st?.files.length ?? 0) > 0;
    const items = [["fetch", "Fetch", "refresh"], ["pull", "Pull", "arrow-down", Boolean(b.upstream)], [b.upstream ? "push" : "publish", b.upstream ? "Push" : "Publish branch", "arrow-up", Boolean(b.head)],
      null, ["stash", "Stash all changes", "archive", any], ...(stashes.length ? [["pop", `Pop ${stashes[0].ref}`, "archive", true, stashes[0]]] : []),
      ...stashes.slice(0, 6).map((s) => ["stash-menu", `${s.ref} · ${s.subject}`, "clock", true, s])];
    openOverlay({ mod: "git", kind: "popup", width: 300, height: 12 + items.reduce((h, i) => h + (i ? 32 : 9), 0), at: under(300), props: { menu: { kind: "more", root: this.repo.root, items } } });
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
    if (asked?.id && asked.id !== this.doneId) {
      this.doneId = asked.id;
      // Two copies on one repository (the side panel and a pane) both see the request: the first to claim
      // it runs it. Check and claim happen before any await, out of render (no notify or setShared there).
      // ponytail: relies on mod copies sharing one script thread; separate runtimes would need an ack from the doer.
      if (asked.root === this.repo?.root) cx.spawn(async (cx) => {
        if (shared("git.claimed") === asked.id) return;
        setShared("git.claimed", asked.id);
        this.perform(asked, cx);
      });
    }

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
          .child(div().flex_1())
          .when(Boolean(this.busy), (e) => e.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child(spinner(12, t.muted)).child(this.busy)))
          .child(button("commit", commitLabel, t, (_e, cx) => this.commit(cx), { primary: true, icon: "commit", enabled: canCommit }))))
      .when(Boolean(st?.last), (e) => e.child(h_flex().flex_none().h(34).px(10).gap(8).items_center().border_t(1).border_color(t.border).text_size(12)
        .child(glyph("commit", 13, t.dim)).child(div().font_family(MONO).text_size(11).text_color(t.dim).child(st.last.short))
        .child(div().flex_1().min_w(0).truncate().child(st.last.subject)).child(div().text_color(t.dim).child(st.last.when))
        .child(button("uncommit", "Uncommit", t, (_e, cx) => this.uncommit(cx), { small: true, icon: "undo", enabled: canUncommit && !this.busy, tooltip: canUncommit ? "Undo it, keeping its changes staged" : st.last.root ? "The first commit has nothing to go back to" : "Already pushed: undo it from a terminal" }))));
  }
  title(t, b, sync) {
    return h_flex().flex_none().h(42).px(8).gap(4).items_center().border_b(1).border_color(t.border)
      .child(h_flex().id("branch").flex_1().min_w(0).h(28).px(6).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => b && this.openBranches())
        .child(glyph("branch", 14, t.muted))
        .child(div().min_w(0).truncate().font_semibold().child(b ? b.head ?? `detached ${b.oid?.slice(0, 7) ?? ""}` : "Git"))
        .when(Boolean(b), (e) => e.child(glyph("chevron-down", 12, t.muted)))
        .when(Boolean(b?.upstream) && (b.ahead || b.behind), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`${b.ahead ? `↑${b.ahead}` : ""}${b.behind ? ` ↓${b.behind}` : ""}`))))
      .when(Boolean(b), (e) => e
        .child(this.loading && !this.busy ? div().px(6).child(spinner(13, t.dim)) : div())
        .child(button("history", "", t, () => this.openHistory(), { icon: "history", invisible: true, tooltip: "History and graph" }))
        .child(button("sync", sync.label, t, (_e, cx) => this.sync(sync.action, cx), { icon: { pull: "arrow-down", push: "arrow-up", publish: "arrow-up" }[sync.action] ?? "refresh", enabled: !this.busy }))
        .child(button("more", "", t, () => this.openMore(), { icon: "more", invisible: true, tooltip: "Fetch, pull, push, stash" })));
  }

  // ---- the branch picker (a popup of this mod) ----
  initBranches(spec, overlay, cx) {
    this.picking = { ...spec, overlay, list: null, q: "" };
    this.filter = InputState.new({ placeholder: "Switch to or create a branch…" });
    this.filter.on("change", (_e, cx) => { this.picking.q = this.filter.value().trim(); cx.notify(); });
    this.filter.on("submit", () => this.pickBranch(this.picking.q, true));
    cx.spawn(async (cx) => { try { this.picking.list = await new Repo(spec.root, spec.on).branches(); } catch (e) { this.picking.error = String(e?.message ?? e); } cx.notify(); });
  }
  pickBranch(name, typed = false) {
    const p = this.picking;
    if (!name) return;
    const exists = (p.list ?? []).some((b) => b.name === name);
    if (name !== p.head) ask(p.root, exists || !typed ? "switch" : "create", name);
    closeOverlay(p.overlay);
  }
  renderBranches(t) {
    const p = this.picking, q = p.q.toLowerCase(), list = (p.list ?? []).filter((b) => b.name.toLowerCase().includes(q));
    const fresh = p.q && !(p.list ?? []).some((b) => b.name === p.q) && /^[^\s~^:?*[\\]+$/.test(p.q);
    return v_flex().id("branches").size_full().p(6).gap(2).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(div().mx(2).mb(4).h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).child(Input.new(this.filter).w_full().text_size(12.5)))
      .when(Boolean(fresh), (e) => e.child(menuRow("create", `Create branch “${p.q}”`, "plus", t, () => this.pickBranch(p.q, true))))
      .child(v_flex().id("branch-list").h(330).overflow_y_scrollbar().gap(1)
        .when(!p.list && !p.error, (e) => e.child(div().px(8).py(6).text_color(t.muted).child("Reading branches…")))
        .when(Boolean(p.error), (e) => e.child(div().px(8).py(6).text_color(t.ansi1).child(p.error)))
        .children(list.map((b) => h_flex().id(`b-${b.name}`).h(32).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => this.pickBranch(b.name))
          .child(div().w(14).flex_none().when(b.name === p.head, (e) => e.child(glyph("check", 14, t.foreground))))
          .child(div().flex_1().min_w(0).truncate().child(b.name)).child(div().flex_none().text_size(11).text_color(t.dim).child(b.when)))));
  }
}

function menuRow(id, label, icon, t, onClick, enabled = true) {
  return h_flex().id(id).h(32).flex_none().px(8).gap(8).items_center().rounded(6).text_color(enabled ? t.foreground : t.dim)
    .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick))
    .child(glyph(icon, 14, enabled ? t.muted : t.dim)).child(div().flex_1().min_w(0).truncate().child(label));
}

// The ⋯ menu and a file's right-click menu. Items: [action, label, icon, enabled?, stash?] or null (a line).
function renderMenu(m, t) {
  const done = () => closeOverlay(m.overlay);
  return v_flex().id("menu").size_full().p(6).gap(0).bg(t.popover).text_color(t.foreground).text_size(13)
    .children(m.items.map((i, n) => {
      if (!i) return div().h(1).my(4).bg(t.border);
      const [action, label, icon, enabled = true, stash] = i;
      return menuRow(`m-${n}`, label, icon, t, (_e, cx) => {
        if (action === "diff") openOverlay({ mod: "git", kind: "dialog", width: 0.9, height: 0.9, props: { diff: { root: m.root, on: m.on, path: m.path } } });
        else if (action === "copy") cx.write_to_clipboard(m.path);
        else if (action === "discard-ask") confirm(m.untracked ? "Delete this new file?" : "Discard its changes?", `${m.path}\n${m.untracked ? "The file isn't tracked: it is deleted, and git can't bring it back." : "Staged and unstaged changes go back to the last commit. Git can't bring them back."}`, m.root, "discard", m.path, m.untracked ? "Delete" : "Discard");
        else if (action === "stash-menu") { done(); return openOverlay({ mod: "git", kind: "popup", width: 240, height: 12 + 3 * 32, at: "pointer", props: { menu: { kind: "stash", root: m.root, items: [["apply", `Apply ${stash.ref}`, "archive", true, stash], ["pop", `Pop ${stash.ref}`, "archive", true, stash], ["drop-ask", "Drop…", "discard", true, stash]] } } }); }
        else if (action === "drop-ask") confirm(`Drop ${stash.ref}?`, `${stash.subject}\nIts changes are gone for good.`, m.root, "drop", { ref: stash.ref, oid: stash.oid }, "Drop");
        else ask(m.root, action, stash ? { ref: stash.ref, oid: stash.oid } : null);
        done();
      }, enabled);
    }));
}

function renderConfirm(c, t) {
  return v_flex().id("confirm").size_full().p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
    .child(div().text_size(15).font_semibold().child(c.title))
    .children(c.detail.split("\n").map((l, n) => div().text_color(n ? t.muted : t.foreground).when(!n, (e) => e.font_family(MONO)).text_size(n ? 12.5 : 12).child(l)))
    .child(div().flex_1())
    .child(h_flex().gap(8).justify_end()
      .child(button("no", "Cancel", t, () => closeOverlay(c.overlay)))
      .child(h_flex().id("yes").h(28).px(12).items_center().rounded(6).bg(t.ansi1).text_color("#ffffff").font_medium().text_size(12).cursor_pointer().hover((s) => s.opacity(0.88))
        .on_click(() => { ask(c.root, c.action, c.arg); closeOverlay(c.overlay); }).child(c.yes)));
}
