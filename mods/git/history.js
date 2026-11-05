import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { theme, closeOverlay } from "herdr";
import { Repo } from "./git.js";
import { lane } from "./parse.js";
import { glyph, spinner, button, MONO } from "./ui.js";

// The commit graph: `git log --graph` drawn in lanes, each lane in its own color. Pick a commit to
// read it on the right: message, author, files and patch. { root, on, range? }: with a range
// ("origin/HEAD..HEAD"), only the commits it holds until "Whole branch" is picked.
export class History {
  constructor({ root, on, range = null }, overlay, cx) {
    this.repo = new Repo(root, on); this.overlay = overlay; this.all = false; this.range = range; this.scoped = Boolean(range); this.lines = null; this.picked = null; this.patch = [];
    this.load(cx);
  }
  load(cx) {
    this.loading = true; cx.notify();
    cx.spawn(async (cx) => {
      const gen = (this.gen = (this.gen ?? 0) + 1), all = this.all, range = this.scoped ? this.range : null;
      try { const lines = await this.repo.log({ all, range }); if (gen !== this.gen) return; this.lines = lines; this.error = null; if (!this.picked) { const first = this.lines.find((l) => l.commit); if (first) this.pick(first.commit.hash, cx); } }
      catch (e) {
        // The base is unknown here (no origin/HEAD): fall back to the whole branch rather than nothing.
        if (range && !all && gen === this.gen) { this.scoped = false; this.note = `${this.range.split("..")[0]} not found: whole branch`; return this.load(cx); }
        this.error = String(e?.message ?? e); this.lines ??= [];
      }
      finally { if (gen === this.gen) { this.loading = false; cx.notify(); } }
    });
  }
  pick(hash, cx) {
    if (!hash) return;
    this.picked = hash; this.commit = null; this.patch = []; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const c = await this.repo.show(hash);
        if (this.picked !== hash) return;
        this.commit = c; this.patch = c.patch.replace(/\n$/, "").split("\n").slice(0, 4000);
      } catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  // The graph's characters, colored by lane; the commit's own dot in its lane's color, bold.
  graph(g, colors, t) {
    return h_flex().flex_none().font_family(MONO).children([...g].map((ch, col) => div().w(8).flex_none().text_center()
      .text_color(ch === " " ? t.dim : colors[lane(col) % colors.length]).when(ch === "*", (e) => e.font_bold()).child(ch === "*" ? "●" : ch === " " ? " " : ch)));
  }
  row(l, i, colors, t) {
    const c = l.commit, on = c && c.hash === this.picked;
    return h_flex().w_full().h(24).flex_none().px(10).gap(8).items_center().when(Boolean(c), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))).when(on, (e) => e.bg(t.selected))
      .child(this.graph(l.graph, colors, t))
      .when(Boolean(c), (e) => e
        .children(c.refs.slice(0, 3).map((r) => div().flex_none().px(6).h(17).flex().items_center().rounded(4).text_size(11)
          .bg(r.startsWith("HEAD") ? `${t.accent}33` : r.startsWith("tag:") ? `${t.ansi3}2a` : `${t.ansi4 ?? t.accent}22`).text_color(t.foreground).child(r.replace(/^HEAD -> /, "◉ "))))
        .child(div().flex_1().min_w(0).truncate().child(c.subject))
        .child(div().flex_none().w(120).truncate().text_size(11.5).text_color(t.muted).child(c.author))
        .child(div().flex_none().w(90).truncate().text_size(11.5).text_color(t.dim).child(c.when))
        .child(div().flex_none().font_family(MONO).text_size(11).text_color(t.dim).child(c.short)));
  }
  patchLine(line, t) {
    const color = line.startsWith("+") && !line.startsWith("+++") ? t.ansi2 : line.startsWith("-") && !line.startsWith("---") ? t.ansi1 : line.startsWith("@@") ? t.ansi6 ?? t.accent : line.startsWith("diff --git") ? t.foreground : t.muted;
    return div().w_full().h(18).flex_none().px(12).whitespace_nowrap().text_color(color).when(line.startsWith("diff --git"), (e) => e.font_semibold().bg(t.raised)).child(line.slice(0, 2000) || " ");
  }

  render(cx) {
    const t = theme(), lines = this.lines ?? [], c = this.commit;
    const colors = [t.ansi4, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi1, t.ansi12, t.ansi10].filter(Boolean);
    return v_flex().id("history").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().h(48).px(16).gap(8).items_center().border_b(1).border_color(t.border)
        .child(glyph("history", 15, t.muted)).child(div().font_semibold().child("History")).child(div().text_size(12).text_color(t.muted).child(this.repo.root))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(this.error ? t.ansi1 : t.muted).child(this.error ?? this.note ?? ""))
        .when(this.loading, (e) => e.child(spinner(13, t.muted)))
        .when(Boolean(this.range) && !this.all, (e) => e.child(button("scope", this.scoped ? `Since ${this.range.split("..")[0]}` : "Whole branch", t, (_e, cx) => { this.scoped = !this.scoped; this.note = null; this.picked = null; this.load(cx); }, { small: true, icon: "history", tooltip: "Only the commits added since the base, or the whole branch" })))
        .child(button("all", this.all ? "All branches" : "This branch", t, (_e, cx) => { this.all = !this.all; this.load(cx); }, { small: true, icon: "branch", tooltip: "Show every branch, or the checked-out one" }))
        .child(button("close", "", t, () => closeOverlay(this.overlay), { icon: "close", invisible: true, tooltip: "Close (Esc)" })))
      .child(h_flex().flex_1().min_h(0)
        .child(div().flex_1().min_w(0).h_full().relative().text_size(12.5)
          .child(v_virtual_list("log", lines.length, 24, (i) => String(i), (range) => lines.slice(range.start, range.end).map((l, n) => this.row(l, range.start + n, colors, t)))
            .size_full().on_item_click((key, cx) => this.pick(lines[+key]?.commit?.hash, cx)))
          .child(Scrollbar.vertical("log").viewport_from_layout().absolute().inset_0())
          .when(!lines.length && !this.loading, (e) => e.child(div().absolute().top(12).left(12).text_color(t.dim).child(this.scoped && !this.all ? `No commits since ${this.range.split("..")[0]}` : "No commits yet"))))
        .child(v_flex().w_2_5().flex_none().h_full().min_h(0).border_l(1).border_color(t.border)
          .child(v_flex().flex_none().p(14).gap(6).border_b(1).border_color(t.border)
            .child(div().text_size(14).font_semibold().child(c ? c.message.split("\n")[0] : this.picked ? "Loading…" : "Pick a commit"))
            .when(Boolean(c) && c.message.includes("\n"), (e) => e.child(div().text_size(12.5).text_color(t.muted).child(c.message.split("\n").slice(1).join("\n").trim())))
            .when(Boolean(c), (e) => e.child(h_flex().gap(8).text_size(12).text_color(t.muted).child(div().text_color(t.foreground).child(c.author)).child(div().child(c.date))
              .child(div().flex_1()).child(h_flex().id("hash").gap(4).items_center().cursor_pointer().font_family(MONO).text_size(11).hover((s) => s.text_color(t.foreground))
                .on_click((_e, cx) => cx.write_to_clipboard(c.hash)).tooltip("Copy the full hash").child(glyph("copy", 11, t.dim)).child(c.hash.slice(0, 10))))))
          .child(div().flex_1().min_h(0).relative().font_family(MONO).text_size(11.5)
            .child(div().id("patch-x").size_full().overflow_x_scrollbar()
              .child(div().w_full().min_w(Math.max(500, ...this.patch.map((l) => Math.min(l.length, 300) * 7 + 30))).h_full()
                .child(v_virtual_list("patch", this.patch.length, 18, (i) => String(i), (range) => this.patch.slice(range.start, range.end).map((l) => this.patchLine(l, t))).size_full())))
            .child(Scrollbar.vertical("patch").viewport_from_layout().absolute().inset_0()))));
  }
}
