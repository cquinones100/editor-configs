// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// Mission control's built-in views, after its tabs and before the plugins'.
// Each is a list of items, drawn as the plugins' are, { title, detail,
// state, time }, and an item says what Enter does with it: `tab`, go there;
// `url`, open it; `dir`, open a tab there.
//
// The work map: every piece of work in the repositories your tabs are in,
// one row each: each worktree, and a main checkout a tab is in, with its
// ticket (from the branch), the tab it is open in or none, its PR and where
// that stands, and its directory. Work with no tab open is still listed, so
// nothing in flight is forgotten. The worktrees are read with git every
// minute, in the background (refreshWorktrees), and drawing reads only that.

const os = require("node:os");
const { execFile } = require("node:child_process");
const { mergeOf } = require("./prs");

const home = os.homedir();
const tilde = (dir) => (dir && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir ?? "");

const git = (dir, args) =>
  new Promise((resolve) => execFile("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 10_000 }, (err, stdout) => resolve(err ? undefined : stdout)));

// A directory's main checkout, asked once per directory.
const mains = new Map();
const mainOf = async (dir) => {
  if (!dir) return undefined;
  if (!mains.has(dir)) {
    const common = (await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))?.trim();
    mains.set(dir, common ? common.replace(/\/\.git\/?$/, "") : undefined);
  }
  return mains.get(dir);
};

// main checkout -> [{ path, branch }], as last read.
const worktrees = new Map();
const refreshWorktrees = async (tabs) => {
  const repos = [...new Set((await Promise.all(tabs.map((t) => mainOf(t.path)))).filter(Boolean))];
  await Promise.all(
    repos.map(async (repo) => {
      const out = await git(repo, ["worktree", "list", "--porcelain"]);
      if (out === undefined) return;
      worktrees.set(
        repo,
        out.split("\n\n").filter(Boolean).map((entry) => ({
          path: /^worktree (.*)$/m.exec(entry)?.[1],
          branch: /^branch refs\/heads\/(.*)$/m.exec(entry)?.[1],
          main: entry.startsWith(`worktree ${repo}\n`),
        })).filter((w) => w.path),
      );
    }),
  );
};

// The worktrees no tab is in, as stand-ins for tabs, so their PRs are asked
// about by branch along with the tabs' (see prs.js).
const untabbed = (tabs) =>
  [...worktrees.values()].flat().filter((w) => !w.main && w.branch && !tabs.some((t) => t.path === w.path)).map((w) => ({ path: w.path, branch: w.branch }));

const TICKET = /^([a-z][a-z0-9]*-\d+)/i;
const prWords = (facts) => {
  if (!facts.pr) return "no PR";
  const c = facts.checks;
  const where = facts.merge === "merged" ? "merged" : facts.merge === "queued" ? `in merge queue${facts.position ? ` at ${facts.position}` : ""}` : c?.fail ? `✗${c.fail} failing` : c?.pending ? "checks running" : "open";
  return `#${facts.pr} ${where}`;
};
// Needing you first, then work going on, open PRs, merged ones, and work no
// tab is in last.
const rank = (row) => (row.state === "attention" ? 0 : row.state === "active" ? 1 : row.merge === "merged" ? 3 : row.tab ? 2 : 4);

// What a row is called: its tab's name, or its branch in words, without the
// ticket the row already leads with.
const named = (tab, w, ticket) => {
  const name = tab?.name ?? (w.branch ?? w.path.split("/").pop()).replace(TICKET, "").replace(/^[-_]+/, "").replace(/[-_]+/g, " ");
  return ticket ? name.replace(new RegExp(`^${ticket}:?\\s*`, "i"), "") : name;
};

const workMap = (tabs) => {
  const rows = [];
  worktrees.forEach((list) =>
    list.forEach((w) => {
      const tab = tabs.find((t) => t.path === w.path);
      if (w.main && !tab) return;
      const facts = tab ?? { ...mergeOf({ path: w.path, branch: w.branch }) };
      const ticket = TICKET.exec(w.branch ?? "")?.[1]?.toUpperCase();
      const needs = tab && (tab.state === "waiting" || tab.state === "done" || tab.flagged);
      const state = needs || facts.checks?.fail ? "attention" : tab && tab.state !== "idle" ? "active" : "idle";
      rows.push({
        title: `${ticket ? `${ticket}  ` : ""}${named(tab, w, ticket)}`,
        detail: [tab ? `tab ${tab.index}` : "no tab", prWords(facts), tilde(w.path)].join(" · "),
        state,
        merge: facts.merge,
        tab,
        dir: tab ? undefined : w.path,
      });
    }),
  );
  return rows.sort((a, b) => rank(a) - rank(b));
};

// The built-in views, as mission control draws them.
const builtInViews = (state) => [{ title: "Work map", items: workMap(state.tabs), loaded: true, builtIn: true }];

module.exports = { builtInViews, refreshWorktrees, untabbed, workMap, worktrees, mainOf };
