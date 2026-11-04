import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { theme, closeOverlay, readTextFile } from "herdr";
import { Repo } from "./git.js";
import { fileState, hunkRows } from "./parse.js";
import { glyph, spinner, button, checkbox, letterColor, confirm, MONO } from "./ui.js";

const LINES = 3000; // per side of a file; more says so

// Zed's review: every changed file on the left, the picked one's diff on the right, unstaged hunks
// then staged ones. Clicking a hunk's header stages or unstages that hunk alone. { root, on, path? }.
export class Diff {
  constructor({ root, on, path }, overlay, cx) {
    this.repo = new Repo(root, on); this.overlay = overlay; this.path = path ?? null; this.files = []; this.rows = []; this.width = 600;
    this.reload(cx);
    cx.timer.every(10000, (cx) => { if (!this.busy) this.reload(cx); });
  }

  reload(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const st = await this.repo.status();
        this.files = st.files; this.hasHead = Boolean(st.branch.oid);
        if (!this.files.some((f) => f.path === this.path)) this.path = this.files[0]?.path ?? null;
        await this.show(this.path);
        this.error = null;
      } catch (e) { this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }
  file() { return this.files.find((f) => f.path === this.path) ?? null; }

  // Rows for the virtual list, each with a key: "u:2" is unstaged hunk 2's header, "u:2:7" its 7th line.
  async show(path) {
    const gen = (this.gen = (this.gen ?? 0) + 1), current = () => gen === this.gen && path === this.path;
    const f = this.files.find((x) => x.path === path);
    if (!f) { if (current()) { this.rows = []; this.sides = null; } return; }
    let sides = null;
    const rows = [], add = (key, row) => rows.push({ key, ...row });
    if (f.untracked) {
      const text = await readTextFile(`${this.repo.root}/${path}`, { on: this.repo.on }).catch(() => null);
      add("t", { kind: "title", text: "New file · not tracked yet" });
      if (text === null) add("x", { kind: "note", text: "Can't show this file (binary, too large or unreadable)" });
      else if (text.includes("\0")) add("x", { kind: "note", text: "Binary file" });
      else text.replace(/\n$/, "").split("\n").slice(0, LINES).forEach((l, n) => add(`n:${n}`, { kind: "+", next: n + 1, text: l || " " }));
    } else {
      const [unstaged, staged] = await Promise.all([this.repo.diff(path, false), this.repo.diff(path, true, f.orig)]);
      sides = { u: unstaged, s: staged };
      // A staged rename's hunks come with the rename itself: staging goes by the whole file there.
      for (const [side, d, title, verb] of [["u", unstaged, "Unstaged", "Stage hunk"], ["s", staged, f.orig ? "Staged rename" : "Staged", f.orig ? null : "Unstage hunk"]]) {
        if (!d.hunks.length) continue;
        add(`t${side}`, { kind: "title", text: `${title} · ${d.hunks.length} hunk${d.hunks.length > 1 ? "s" : ""}` });
        let shown = 0;
        d.hunks.forEach((h, n) => {
          add(`${side}:${n}`, { kind: "@", text: h.head, verb });
          for (const [m, r] of hunkRows(h).entries()) if (shown++ < LINES) add(`${side}:${n}:${m}`, r);
        });
        if (shown > LINES) add(`${side}:more`, { kind: "note", text: `${shown - LINES} more lines not shown` });
      }
      if (!rows.length) add("x", { kind: "note", text: f.binary ? "Binary file changed" : f.orig ? `Renamed from ${f.orig}, no change inside` : "No text change" });
    }
    if (current()) { this.rows = rows; this.sides = sides; this.width = Math.max(600, ...rows.map((r) => Math.min(r.text.length, 400) * 7 + 120)); }
  }

  pick(path, cx) {
    this.path = path; this.rows = []; cx.notify();
    cx.spawn(async (cx) => { try { await this.show(path); } catch (e) { this.error = String(e?.message ?? e); } cx.notify(); });
  }
  act(label, cx, work) {
    if (this.busy) return;
    this.busy = label; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try { await work(this.repo); } catch (e) { this.error = String(e?.message ?? e); }
      finally { this.busy = null; this.reload(cx); cx.notify(); }
    });
  }
  // A click on a hunk's header: git apply that hunk to the index (or back out of it).
  clicked(key, cx) {
    const m = /^([us]):(\d+)$/.exec(key);
    if (!m || !this.sides) return;
    const d = this.sides[m[1]], hunk = d.hunks[+m[2]];
    if (!hunk || (m[1] === "s" && this.file()?.orig)) return;
    this.act(m[1] === "u" ? "Staging the hunk…" : "Unstaging the hunk…", cx, (r) => r.applyHunk(d.header, hunk, { reverse: m[1] === "s" }));
  }

  line(r, t) {
    if (r.kind === "title") return h_flex().w_full().h(24).flex_none().px(12).items_center().bg(t.raised).border_b(1).border_color(t.border).font_semibold().text_color(t.muted).child(r.text);
    if (r.kind === "note") return div().w_full().h(24).flex_none().px(12).flex().items_center().text_color(t.dim).child(r.text);
    if (r.kind === "@") return h_flex().w_full().h(24).flex_none().px(12).gap(10).items_center().cursor_pointer().bg(`${t.accent}14`).hover((s) => s.bg(`${t.accent}2a`)).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().child(r.text))
      .when(Boolean(r.verb), (e) => e.child(div().flex_none().px(8).h(18).flex().items_center().rounded(4).border_1().border_color(t.border).bg(t.background).text_color(t.foreground).child(r.verb)));
    const bg = r.kind === "+" ? `${t.ansi2}1c` : r.kind === "-" ? `${t.ansi1}1c` : null;
    return h_flex().w_full().h(20).flex_none().gap(8).when(Boolean(bg), (e) => e.bg(bg))
      .child(div().w(36).flex_none().text_right().text_color(t.dim).child(r.old === undefined ? "" : String(r.old)))
      .child(div().w(36).flex_none().text_right().text_color(t.dim).child(r.next === undefined ? "" : String(r.next)))
      .child(div().w(10).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim).child(r.kind === " " ? "" : r.kind))
      .child(div().flex_1().whitespace_nowrap().child(r.text.length > 4000 ? `${r.text.slice(0, 4000)}…` : r.text));
  }

  render(cx) {
    const t = theme(), f = this.file(), s = f ? fileState(f) : null;
    return v_flex().id("diff").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().h(48).px(16).gap(8).items_center().border_b(1).border_color(t.border)
        .child(glyph("diff", 15, t.muted)).child(div().font_semibold().child("Review changes")).child(div().text_size(12).text_color(t.muted).child(this.repo.root))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.ansi1).child(this.error ?? ""))
        .when(Boolean(this.busy), (e) => e.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child(spinner(12, t.muted)).child(this.busy)))
        .child(button("refresh", "", t, (_e, cx) => this.reload(cx), { icon: "refresh", invisible: true, tooltip: "Refresh" }))
        .child(button("close", "", t, () => closeOverlay(this.overlay), { icon: "close", invisible: true, tooltip: "Close (Esc)" })))
      .child(h_flex().flex_1().min_h(0)
        .child(v_flex().id("diff-files").w(300).flex_none().h_full().overflow_y_scrollbar().p(6).gap(1).border_r(1).border_color(t.border)
          .when(!this.files.length, (e) => e.child(div().p(10).text_color(t.dim).child(this.loading ? "Reading changes…" : "Working tree clean")))
          .children(this.files.slice(0, 1000).map((x) => {
            const xs = fileState(x), parts = x.path.split("/"), name = parts.pop();
            return h_flex().id(`df-${x.path}`).h(28).flex_none().px(8).gap(7).items_center().rounded(6).cursor_pointer().when(x.path === this.path, (e) => e.bg(t.selected)).hover((h) => h.bg(t.hover))
              .on_click((_e, cx) => this.pick(x.path, cx))
              .child(checkbox(`dc-${x.path}`, xs.check, t, (_e, cx) => this.act(xs.check === "off" ? "Staging…" : "Unstaging…", cx, (r) => xs.check === "off" ? r.stage([x.path]) : r.unstage([x.path], this.hasHead, this.files))))
              .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(letterColor(xs.letter, t)).child(xs.letter))
              .child(h_flex().flex_1().min_w(0).child(div().min_w(0).truncate().child(name)).when(parts.length > 0, (e) => e.child(div().pl(6).min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))));
          })))
        .child(v_flex().flex_1().min_w(0).h_full()
          .when(Boolean(f), (e) => e.child(h_flex().flex_none().h(40).px(12).gap(8).items_center().border_b(1).border_color(t.border)
            .child(div().text_size(11).font_semibold().text_color(letterColor(s.letter, t)).child(s.letter))
            .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(12).child(f.orig ? `${f.orig} → ${f.path}` : f.path))
            .when(f.add > 0 || f.del > 0, (x) => x.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
            .child(button("file-stage", s.check === "on" ? "Unstage file" : "Stage file", t, (_e, cx) => this.act("Staging…", cx, (r) => s.check === "on" ? r.unstage([f.path], this.hasHead, this.files) : r.stage([f.path])), { small: true, enabled: !this.busy }))
            .child(button("file-discard", f.untracked ? "Delete…" : "Discard…", t, () => confirm(f.untracked ? "Delete this new file?" : "Discard its changes?", `${f.path}\n${f.untracked ? "The file isn't tracked: it is deleted, and git can't bring it back." : "Staged and unstaged changes go back to the last commit. Git can't bring them back."}`, this.repo.root, "discard", f.path, f.untracked ? "Delete" : "Discard"), { small: true, icon: "discard" }))))
          .child(div().flex_1().min_h(0).relative().font_family(MONO).text_size(12)
            .child(div().id("diff-x").size_full().overflow_x_scrollbar()
              .child(div().w_full().min_w(this.width).h_full()
                .child(v_virtual_list("diff-rows", this.rows.length, this.rows.map((r) => r.kind === "title" || r.kind === "@" || r.kind === "note" ? 24 : 20), (i) => this.rows[i].key,
                  (range) => this.rows.slice(range.start, range.end).map((r) => this.line(r, t))).size_full().on_item_click((key, cx) => this.clicked(key, cx)))))
            .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0())
            .when(!f && !this.loading, (e) => e.child(div().absolute().top(12).left(12).text_color(t.dim).child("Nothing to review"))))));
  }
}
