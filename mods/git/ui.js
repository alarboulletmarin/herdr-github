import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { setShared, openOverlay } from "herdr";

export const icon = (name) => `mods/git/icons/${name}.svg`;
export const glyph = (name, size, color) => svg(icon(name)).size(size).flex_none().text_color(color);
export const spinner = (size, color) => svg("mods/workspace-chrome/spinner.svg").size(size).flex_none().text_color(color).spin(900);
export const MONO = "JetBrains Mono";

// A file's letter in Zed's colors, from the theme's terminal palette.
export const letterColor = (letter, t) => ({ A: t.ansi2, D: t.ansi1, U: t.ansi1, R: t.ansi4 ?? t.ansi6 })[letter] ?? t.blocked ?? t.ansi3;

// Where the last button was pressed (window px): a menu it opens hangs under it.
let pressed = null;
export function under(width, gap = 4, bounds = pressed) {
  return bounds ? { x: Math.max(4, bounds.x + bounds.width - width), y: bounds.y + bounds.height + gap } : "pointer";
}

export function button(id, label, t, onClick, { primary = false, invisible = false, enabled = true, icon: name = null, small = false, tooltip = null } = {}) {
  const solid = primary && enabled, h = small ? 24 : 28;
  return h_flex().id(id).h(h).px(label === "" ? 6 : small ? 8 : 10).gap(6).flex_none().items_center().justify_center().rounded(6).text_size(12).font_medium()
    .bg(solid ? t.solid : invisible ? "#00000000" : t.raised).border_1().border_color(solid ? t.solid : invisible ? "#00000000" : t.border)
    .text_color(solid ? t.solid_foreground : enabled ? (invisible ? t.muted : t.foreground) : t.dim)
    .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); if (e.bounds) pressed = e.bounds; })
    .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(solid ? t.solid : t.hover).text_color(solid ? t.solid_foreground : t.foreground)).on_click(onClick))
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
    .when(Boolean(name), (e) => e.child(name === "spin" ? spinner(13, t.muted) : glyph(name, 13, solid ? t.solid_foreground : enabled ? (invisible ? t.muted : t.foreground) : t.dim)))
    .when(label !== "", (e) => e.child(label));
}

// Zed's staging checkbox: on, off, or partial (some of it staged).
export function checkbox(id, state, t, onClick) {
  const on = state !== "off";
  return div().id(id).size(14).flex_none().flex().items_center().justify_center().rounded(3).cursor_pointer()
    .border_1().border_color(on ? t.accent : t.border).bg(on ? t.accent : "#00000000")
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click(onClick)
    .when(on, (e) => e.child(glyph(state === "partial" ? "minus" : "check", 11, t.accent_foreground ?? t.background)));
}

// Popups and dialogs ask the panel to act through shared("git.do"), so the work outlives them.
export function ask(root, action, arg = null) { setShared("git.do", { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, at: Date.now(), root, action, arg }); }
// Asks before throwing work away; the panel does it on a click of `yes`.
export function confirm(title, detail, root, action, arg, yes, alternative = null) {
  openOverlay({ mod: "git", kind: "dialog", modal: true, width: 420, height: alternative ? 230 : 190, props: { confirm: { title, detail, root, action, arg, yes, alternative } } });
}
