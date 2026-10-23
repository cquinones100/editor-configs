#!/usr/bin/env node

// For tmux/pr-view.sh and tmux/ticket-view.sh: turns a PR (gh's JSON) or a
// Linear ticket (its GraphQL answer) into the Markdown glow draws, with each
// Mermaid diagram drawn as text by mermaid-ascii, and puts the drawings back
// into glow's output untouched.
//
//   pr-view.js prepare <pr.json> <dir> <columns>       writes <dir>/pr.md
//   pr-view.js ticket <ticket.json> <dir> <columns>    writes <dir>/pr.md
//   pr-view.js splice <dir> < glow's output            prints it with the drawings in
//
// glow wraps every line to the pane, a code block's too, which cuts a
// drawing's boxes apart, so a drawing goes in as a placeholder line and comes
// back after. A left-to-right flowchart wider than the pane is drawn top to
// bottom instead, which is as wide as its widest box; one still wider is left
// whole, for the pager to cut at the pane's edge (less -S) rather than wrap.
// A diagram mermaid-ascii can't draw (it does flowcharts and sequence
// diagrams) keeps its source, said so.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MARK = "PRVIEWDIAGRAM";
const widest = (text) => Math.max(0, ...text.split("\n").map((line) => [...line].length));

const draw = (source, dir, n, columns) => {
  const file = path.join(dir, `${n}.mmd`);
  const run = (text) => {
    fs.writeFileSync(file, text);
    try {
      return execFileSync("mermaid-ascii", ["-f", file, "--max-width", String(columns), "-x", "2", "-y", "1"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\s+$/, "");
    } catch {
      return undefined;
    }
  };
  let drawn = run(source);
  const sideways = /^\s*(flowchart|graph)\s+(LR|RL)\b/m;
  if (drawn !== undefined && widest(drawn) > columns && sideways.test(source)) {
    drawn = run(source.replace(sideways, "$1 TD")) ?? drawn;
  }
  return drawn;
};

// Each Mermaid block in <text> drawn and swapped for its placeholder; <where>
// says where a diagram that can't be drawn is shown properly.
let drawings = 0;
const diagrams = (text, dir, columns, where) =>
  (text ?? "").replace(/\r/g, "").replace(/^[ \t]*```+[ \t]*mermaid[ \t]*\n([\s\S]*?)^[ \t]*```+[ \t]*$/gm, (whole, source) => {
    const n = ++drawings;
    const drawn = draw(source, dir, n, columns);
    if (drawn === undefined || drawn === "") return `_A Mermaid diagram mermaid-ascii cannot draw; ${where} shows it:_\n\n\`\`\`mermaid\n${source}\`\`\``;
    fs.writeFileSync(path.join(dir, `${n}.txt`), drawn);
    return `${MARK}${n}`;
  });

const prepare = (prFile, dir, columns) => {
  const pr = JSON.parse(fs.readFileSync(prFile, "utf8"));
  const header = `# ${pr.title} #${pr.number}\n\n_${pr.isDraft ? "Draft" : pr.state} · ${pr.author?.login ?? "someone"} wants to merge \`${pr.headRefName}\` into \`${pr.baseRefName}\`_\n\n---\n\n`;
  fs.writeFileSync(path.join(dir, "pr.md"), header + diagrams(pr.body, dir, columns, "M-r on GitHub"));
};

// A Linear ticket as its page lays it out: title, the facts in its side panel,
// the description, sub-issues and related tickets, then the comments, oldest
// first, each reply under the comment it answers.
const day = (iso) => (iso ?? "").slice(0, 10);
// Linear links every ticket it names, and glow prints a link's whole URL after
// its text, so a link that only names a ticket is shown as the ID alone.
const tidy = (text) => (text ?? "").replace(/\[([A-Z][A-Z0-9]*-\d+)\]\(<?https:\/\/linear\.app\/[^)\s>]*>?\)/g, "**$1**").replace(/<?https:\/\/linear\.app\/[^/\s]+\/issue\/([A-Z][A-Z0-9]*-\d+)[^\s)>]*>?/g, "**$1**");
const ticket = (ticketFile, dir, columns) => {
  const issue = JSON.parse(fs.readFileSync(ticketFile, "utf8")).data.issue;
  const facts = [
    issue.state?.name,
    issue.priorityLabel !== "No priority" && issue.priorityLabel,
    issue.assignee ? `assigned to ${issue.assignee.name}` : "unassigned",
    issue.project?.name && `project ${issue.project.name}`,
    issue.cycle && `cycle ${issue.cycle.name ?? issue.cycle.number}`,
    issue.estimate != null && `estimate ${issue.estimate}`,
    issue.labels.nodes.length > 0 && issue.labels.nodes.map((l) => l.name).join(", "),
  ].filter(Boolean);
  const where = "M-l in Linear";
  const list = (title, rows) => (rows.length ? `\n\n## ${title}\n\n${rows.join("\n")}` : "");
  const link = (i) => `**${i.identifier}** ${i.title}${i.state ? ` _(${i.state.name})_` : ""}`;
  const relation = { blocks: "Blocks", duplicate: "Duplicates", related: "Related to", similar: "Similar to" };
  const comments = issue.comments.nodes.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const comment = (c, reply) => {
    const head = `${reply ? "↳ " : ""}**${c.user?.name ?? c.botActor?.name ?? "Someone"}** · ${day(c.createdAt)}`;
    const body = diagrams(tidy(c.body), dir, columns, where);
    return reply ? `> ${head}\n>\n${body.split("\n").map((l) => `> ${l}`).join("\n")}` : `${head}\n\n${body}`;
  };
  const threads = comments
    .filter((c) => !c.parent)
    .map((c) => [comment(c, false), ...comments.filter((r) => r.parent?.id === c.id).map((r) => comment(r, true))].join("\n\n"));
  const text = [
    `# ${issue.identifier}: ${issue.title}`,
    `\n\n_${facts.join(" · ")}_`,
    `\n\n_Opened by ${issue.creator?.name ?? "someone"} on ${day(issue.createdAt)}, updated ${day(issue.updatedAt)}${issue.parent ? ` · sub-issue of ${issue.parent.identifier} ${issue.parent.title}` : ""}_`,
    "\n\n---\n\n",
    diagrams(tidy(issue.description), dir, columns, where) || "_No description._",
    list("Sub-issues", issue.children.nodes.map((c) => `- ${link(c)}`)),
    list("Related", issue.relations.nodes.map((r) => `- ${relation[r.type] ?? r.type} ${link(r.relatedIssue)}`)),
    list("Links", issue.attachments.nodes.map((a) => `- [${a.title}](${a.url})`)),
    threads.length ? `\n\n## Comments\n\n${threads.join("\n\n---\n\n")}` : "",
  ].join("");
  fs.writeFileSync(path.join(dir, "pr.md"), text);
};

const splice = (dir) => {
  const input = fs.readFileSync(0, "utf8");
  const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
  process.stdout.write(
    input
      .split("\n")
      .map((line) => {
        const n = new RegExp(`${MARK}(\\d+)`).exec(plain(line))?.[1];
        if (!n) return line;
        return fs.readFileSync(path.join(dir, `${n}.txt`), "utf8").split("\n").map((l) => `  ${l}`).join("\n");
      })
      .join("\n"),
  );
};

const [mode, ...args] = process.argv.slice(2);
if (mode === "prepare") prepare(args[0], args[1], Number(args[2]) || 80);
else if (mode === "ticket") ticket(args[0], args[1], Number(args[2]) || 80);
else if (mode === "splice") splice(args[0]);
else {
  console.error("Usage: pr-view.js prepare|ticket <file.json> <dir> <columns> | splice <dir>");
  process.exit(1);
}
