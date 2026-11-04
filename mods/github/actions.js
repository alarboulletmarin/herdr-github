import { v_flex, h_flex } from "gpui-base";
import { div, svg, image } from "gpui-kit";
import { run, notify, openOverlay, closeOverlay, knownAgents, spaces, shared, setShared } from "herdr";
import { glyph, under } from "./ui.js";
import { marked } from "./work.js";

// Records what is being done about owner/repo#N (work.js). A stage you set by hand is never overwritten by a brief or an agent.
export function setWork(key, stage, extra = { by: "hand" }) {
  const marks = shared("github.work") ?? {};
  if (extra.by !== "hand" && marks[key]?.by === "hand") return;
  setShared("github.work", marked(marks, key, stage, extra));
}

export function copied(cx, text, title, body) {
  cx.write_to_clipboard(text);
  notify({ title, body, level: "success", timeout: 2500 });
}

// The agent menu: a popup of this mod listing the installed agents, under the button that asked.
export function pickAgent(task) {
  openOverlay({ mod: "github", kind: "popup", width: 260, height: 300, at: under(260), props: { agentMenu: task } });
}

// Starts the agent in a new tab, in the clone's space when there is one, with the brief as its first message.
export function launch(agent, { name, brief, folder, space, ref }) {
  const args = { name: name.slice(0, 48), argv: agent.run, task: brief };
  if (ref) setWork(ref, "doing", { by: "agent", tab: args.name });
  const home = space ?? spaces().find((s) => !s.machine && folder && s.folder === folder)?.id ?? spaces().find((s) => s.active)?.id;
  if (home) args.space = home;
  if (folder) args.folder = folder;
  run("tab.new", args);
  notify({ title: `${agent.name} started`, body: name, level: "success", timeout: 3000 });
}

export class AgentMenu {
  constructor(task, overlay, cx) {
    this.task = task; this.overlay = overlay; this.agents = null;
    cx.spawn(async (cx) => { this.agents = (await knownAgents().catch(() => [])).filter((a) => a.installed && a.run?.length); cx.notify(); });
  }
  render(cx, t) {
    const list = this.agents;
    return v_flex().id("agent-menu").size_full().p(6).gap(1).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(div().px(8).pt(4).pb(6).text_size(11).font_semibold().text_color(t.dim).child(`Start an agent on ${this.task.name}`))
      .when(!list, (e) => e.child(div().px(8).py(6).text_color(t.muted).child("Looking for agents…")))
      .when(list?.length === 0, (e) => e.child(div().px(8).py(6).text_size(12).text_color(t.muted).child("No agent installed. Add one in programs.json.")))
      .children((list ?? []).map((a, n) => h_flex().id(`agent-${n}`).h(32).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(() => { launch(a, this.task); closeOverlay(this.overlay); })
        .child(div().size(16).flex_none().when(Boolean(a.icon), (e) => e.child(a.tint ? svg(a.icon).size(16).text_color(t.muted) : image(a.icon).size(16))))
        .child(div().flex_1().truncate().child(a.name))))
      .child(div().flex_1())
      .child(h_flex().px(8).py(6).gap(6).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(glyph("folder", 12, t.dim)).child(div().truncate().child(this.task.folder ?? "Not cloned here: the agent will clone it")));
  }
}

// Copy link / reference / number / brief: under its button, or at the pointer for a right-click.
export function copyMenu(items, at = under(300)) {
  openOverlay({ mod: "github", kind: "popup", width: 300, height: 14 + items.length * 48, at, props: { copyMenu: items } });
}
export function renderCopyMenu(items, overlay, t) {
  return v_flex().id("copy-menu").size_full().p(6).gap(1).bg(t.popover).text_color(t.foreground).text_size(12)
    .children(items.map(([label, text, preview], n) => v_flex().id(`copy-${n}`).h(46).flex_none().justify_center().px(8).rounded(6).cursor_pointer()
      .hover((e) => e.bg(t.hover))
      .on_click((_e, cx) => { copied(cx, text, "Copied", preview ?? text); closeOverlay(overlay); })
      .child(div().font_semibold().child(label))
      .child(div().text_size(11).text_color(t.muted).truncate().child(preview ?? text))));
}
