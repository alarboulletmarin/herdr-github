import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { theme, closeOverlay } from "herdr";
import { Repo } from "./git.js";
import { hunkRows } from "./parse.js";
import { glyph, spinner, button, ask, MONO } from "./ui.js";

// Read-only: the message belongs to this preview; the panel runs its commit after the dialog closes.
export class NextCommit {
  constructor({ root, on, message, amend, signoff = false, noVerify = false }, overlay, cx) {
    this.repo = new Repo(root, on); this.overlay = overlay; this.message = message; this.amend = amend; this.signoff = signoff; this.noVerify = noVerify;
    this.files = []; this.rows = []; this.path = null; this.width = 600;
    this.load(cx);
  }
  load(cx) {
    if (this.loading) return;
    this.loading = true; this.error = null;
    cx.spawn(async (cx) => {
      try {
        const data = await this.repo.nextCommit(this.amend);
        this.files = data.files; this.tracked = data.tracked;
        this.pick(this.files.some((f) => f.path === this.path) ? this.path : this.files[0]?.path ?? null);
      } catch (e) { this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }
  pick(path) {
    this.path = path;
    const diff = this.files.find((f) => f.path === path)?.diff, rows = [];
    if (diff) {
      for (const text of diff.header) rows.push({ kind: "@", text });
      for (const h of diff.hunks) { rows.push({ kind: "@", text: h.head }); for (const r of hunkRows(h)) rows.push(r); }
    }
    this.rows = rows; this.width = rows.reduce((w, r) => Math.max(w, r.text.length * 7 + 120), 600);
  }
  commit() {
    ask(this.repo.root, "commit", { message: this.message, amend: this.amend, signoff: this.signoff, noVerify: this.noVerify });
    closeOverlay(this.overlay);
  }
  line(r, t) {
    if (r.kind === "@") return div().w_full().h(20).flex_none().px(12).bg(t.raised).text_color(t.muted).whitespace_nowrap().child(r.text);
    const bg = r.kind === "+" ? `${t.ansi2}1c` : r.kind === "-" ? `${t.ansi1}1c` : null;
    return h_flex().w_full().h(20).flex_none().gap(8).when(Boolean(bg), (e) => e.bg(bg))
      .child(div().w(36).flex_none().text_right().text_color(t.dim).child(r.old === undefined ? "" : String(r.old)))
      .child(div().w(36).flex_none().text_right().text_color(t.dim).child(r.next === undefined ? "" : String(r.next)))
      .child(div().w(10).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim).child(r.kind === " " ? "" : r.kind))
      .child(div().flex_1().whitespace_nowrap().child(r.text));
  }
  render(cx) {
    const t = theme(), files = this.files, rows = this.rows;
    const msg = (this.message || (this.amend ? "Keep the last commit message" : "No commit message")).split("\n");
    const label = this.amend ? "Amend" : this.tracked ? "Commit tracked" : "Staged";
    const summary = this.loading ? "Reading changes…" : `${label}: ${files.length} ${files.length === 1 ? "file" : "files"}${this.tracked ? ", untracked files not included" : ""}`;
    const canCommit = !this.loading && !this.error && Boolean(this.message.trim() || this.amend) && (this.amend || files.length > 0);
    return v_flex().id("next-commit").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().h(48).px(16).gap(8).items_center().border_b(1).border_color(t.border)
        .child(glyph("commit", 15, t.muted)).child(div().font_semibold().child("Next commit"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(this.repo.root))
        .when(this.loading, (e) => e.child(spinner(13, t.muted)))
        .child(button("next-refresh", "", t, (_e, cx) => { this.load(cx); cx.notify(); }, { icon: "refresh", invisible: true, enabled: !this.loading, tooltip: "Refresh preview" }))
        .child(button("next-submit", this.amend ? "Amend" : "Commit", t, () => this.commit(), { primary: true, icon: "commit", enabled: canCommit }))
        .child(button("next-close", "", t, () => closeOverlay(this.overlay), { icon: "close", invisible: true, tooltip: "Close (Esc)" })))
      .child(div().flex_none().px(16).py(8).text_color(t.muted).child(`${summary}${this.signoff ? " · Sign off" : ""}${this.noVerify ? " · Skip hooks" : ""}`))
      // As tall as its lines (21 px each, measured), up to 6 of them; longer scrolls (a scroller alone takes its max).
      .child(v_flex().id("next-message").flex_none().h(18 + 21 * Math.min(6, msg.length)).overflow_y_scrollbar().px(16).py(8).gap(2).border_y(1).border_color(t.border).font_family(MONO).text_size(12)
        .children(msg.map((l) => div().flex_none().child(l || " "))))
      .when(Boolean(this.error), (e) => e.child(div().flex_none().px(16).py(8).text_color(t.ansi1).child(this.error)))
      .child(h_flex().flex_1().min_h(0)
        .child(div().w(300).flex_none().h_full().relative().border_r(1).border_color(t.border)
          .child(v_virtual_list("next-files", files.length, 28, (i) => files[i].path, (range) => files.slice(range.start, range.end).map((f) =>
            h_flex().w_full().h(28).flex_none().px(10).gap(8).items_center().cursor_pointer().when(f.path === this.path, (e) => e.bg(t.selected)).hover((e) => e.bg(t.hover))
              .child(div().flex_1().min_w(0).truncate().child(f.orig ? `${f.orig} → ${f.path}` : f.path))
              .child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`))
              .child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`))))
            .size_full().on_item_click((key, cx) => { this.pick(key); cx.notify(); }))
          .child(Scrollbar.vertical("next-files").viewport_from_layout().absolute().inset_0()))
        .child(div().flex_1().min_w(0).h_full().relative().font_family(MONO).text_size(12)
          .child(div().id("next-x").size_full().overflow_x_scrollbar()
            .child(div().w_full().min_w(this.width).h_full()
              .child(v_virtual_list("next-rows", rows.length, 20, (i) => `${this.path}:${i}`, (range) => rows.slice(range.start, range.end).map((r) => this.line(r, t))).size_full())))
          .child(Scrollbar.vertical("next-rows").viewport_from_layout().absolute().inset_0())
          .when(!files.length && !this.loading && !this.error, (e) => e.child(div().absolute().top(12).left(12).text_color(t.dim).child(this.amend ? "No staged changes. Only the commit message will change." : "No changes to commit")))));
  }
}
