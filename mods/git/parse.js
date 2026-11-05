// Pure readers of git's machine output, and the patches the panel feeds back to it. No herdr here: parse.test.mjs runs them in node.

// `git status --porcelain=v2 --branch -z --untracked-files=all`: the branch, and every changed path with
// its staged (x) and unstaged (y) letters ("." = unchanged). Renames carry `orig`.
export function parseStatus(out) {
  const branch = { head: null, upstream: null, ahead: 0, behind: 0, oid: null };
  const files = [], fields = out.split("\0");
  for (let n = 0; n < fields.length; n++) {
    const f = fields[n];
    if (!f) continue;
    if (f.startsWith("# branch.oid ")) branch.oid = f.slice(13) === "(initial)" ? null : f.slice(13);
    else if (f.startsWith("# branch.head ")) branch.head = f.slice(14) === "(detached)" ? null : f.slice(14);
    else if (f.startsWith("# branch.upstream ")) branch.upstream = f.slice(18);
    else if (f.startsWith("# branch.ab ")) { const [a, b] = f.slice(12).split(" "); branch.ahead = +a; branch.behind = -b; }
    else if (f[0] === "?") files.push({ path: f.slice(2), x: ".", y: "?", untracked: true, conflict: false });
    else if (f[0] === "1") { const p = f.split(" "); files.push({ path: p.slice(8).join(" "), x: p[1][0], y: p[1][1], untracked: false, conflict: false }); }
    else if (f[0] === "2") { const p = f.split(" "); files.push({ path: p.slice(9).join(" "), orig: fields[++n], x: p[1][0], y: p[1][1], untracked: false, conflict: false }); }
    else if (f[0] === "u") { const p = f.split(" "); files.push({ path: p.slice(10).join(" "), x: p[1][0], y: p[1][1], untracked: false, conflict: true }); }
  }
  return { branch, files };
}

// How a file reads in the list: one letter (A M D R U), and whether it is staged, partly or not.
export function fileState(f) {
  const staged = !f.untracked && f.x !== ".", unstaged = f.untracked || f.y !== ".";
  const letter = f.conflict ? "U" : f.untracked ? "A" : [f.x, f.y].find((c) => c === "D") ?? [f.x, f.y].find((c) => c === "R") ?? [f.x, f.y].find((c) => c === "A") ?? "M";
  return { letter, check: staged && unstaged ? "partial" : staged ? "on" : "off" };
}

// `git diff --numstat -z`: { path: { add, del, binary } }, summed over several outputs.
export function parseNumstat(outs) {
  const stats = {};
  for (const out of outs) for (const entry of out.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (!parts.length) continue;
    const path = parts.join("\t").replace(/^\n/, ""), old = stats[path] ?? { add: 0, del: 0, binary: false };
    stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: old.binary || a === "-" };
  }
  return stats;
}

// One file's `git diff` cut into its header (diff --git … +++ b/…) and hunks (@@ … and its lines).
export function parseDiff(text) {
  const lines = text.replace(/\n$/, "").split("\n"), first = lines.findIndex((l) => l.startsWith("@@"));
  if (!text.trim() || first < 0) return { header: lines.filter(Boolean), hunks: [] };
  const hunks = [];
  for (const line of lines.slice(first)) {
    if (line.startsWith("@@")) hunks.push({ head: line, lines: [] });
    else hunks[hunks.length - 1].lines.push(line);
  }
  return { header: lines.slice(0, first), hunks };
}

// A patch git apply takes for one hunk: the file's header, then that hunk alone.
export const patchOf = (header, hunk) => [...header, hunk.head, ...hunk.lines, ""].join("\n");

// Numbered rows for drawing a hunk: old and new line numbers, as the Changes panel shows them.
export function hunkRows(hunk) {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(hunk.head) ?? [0, 0, 0];
  let old = +m[1], next = +m[2];
  return hunk.lines.map((line) => {
    const kind = line[0], text = line.slice(1) || " ";
    if (kind === "-") return { kind, old: old++, text };
    if (kind === "+") return { kind, next: next++, text };
    if (kind === " ") return { kind, old: old++, next: next++, text };
    return { kind: "\\", text: line };
  });
}

// `git log --graph --format=%x1f%H%x1f%h%x1f%D%x1f%s%x1f%an%x1f%ar`: the graph drawn on the left of
// each line, and the commit when the line has one (connector lines have only the graph).
export const LOG_FORMAT = "%x1f%H%x1f%h%x1f%D%x1f%s%x1f%an%x1f%ar";
export function parseLog(out) {
  return out.replace(/\n$/, "").split("\n").filter((l) => l.length).map((line) => {
    const cut = line.indexOf("\x1f");
    if (cut < 0) return { graph: line.trimEnd(), commit: null };
    const [hash, short, refs, subject, author, when] = line.slice(cut + 1).split("\x1f");
    return { graph: line.slice(0, cut).trimEnd(), commit: { hash, short, refs: refs ? refs.split(", ") : [], subject, author, when } };
  });
}
// A lane per two graph columns, so each branch keeps its color down the graph.
export const lane = (col) => Math.floor(col / 2);

// The panel's tree: folders first then files, by name; a folder with a single folder inside reads as one
// ("src/app"). collapsed: the folders folded shut. Rows: { dir, path, name, depth, file? }.
export function treeRows(files, collapsed = new Set()) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/"); let node = root;
    for (const part of parts.slice(0, -1)) { if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] }); node = node.dirs.get(part); }
    node.files.push({ name: parts[parts.length - 1], file: f });
  }
  const rows = [];
  const walk = (node, prefix, depth) => {
    for (const [name0, child0] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let name = name0, child = child0;
      while (child.files.length === 0 && child.dirs.size === 1) { const [[n, c]] = child.dirs; name += `/${n}`; child = c; }
      const path = prefix + name;
      rows.push({ dir: true, path, name, depth });
      if (!collapsed.has(path)) walk(child, `${path}/`, depth + 1);
    }
    for (const { name, file } of node.files.sort((a, b) => a.name.localeCompare(b.name))) rows.push({ dir: false, path: file.path, name, depth, file });
  };
  walk(root, "", 0);
  return rows;
}
// A folder's checkbox: on when every file under it is staged, off when none is, partial otherwise.
export function folderCheck(files, dir) {
  const under = files.filter((f) => f.path.startsWith(`${dir}/`)).map((f) => fileState(f).check);
  return under.every((c) => c === "on") ? "on" : under.every((c) => c === "off") ? "off" : "partial";
}

// What the sync button does: publish a branch with no upstream, pull when behind, push when ahead, else fetch.
export function syncAction(b) {
  if (!b.head) return { action: "fetch", label: "Fetch" };
  if (!b.upstream) return { action: "publish", label: "Publish" };
  if (b.behind > 0) return { action: "pull", label: `Pull ↓${b.behind}` };
  if (b.ahead > 0) return { action: "push", label: `Push ↑${b.ahead}` };
  return { action: "fetch", label: "Fetch" };
}
// The line of a git error worth a toast: push prints "To <url>" first and the reason after.
export const gist = (text) => { const lines = String(text).split("\n").map((l) => l.trim()).filter(Boolean); return lines.find((l) => /^(error|fatal|!)/.test(l)) ?? lines[0] ?? ""; };
