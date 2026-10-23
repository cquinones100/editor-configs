#!/usr/bin/env node

// For tmux/pr-view.sh: turns a PR (gh's JSON) into the Markdown glow draws,
// with each Mermaid diagram drawn as text by mermaid-ascii, and puts the
// drawings back into glow's output untouched.
//
//   pr-view.js prepare <pr.json> <dir> <columns>   writes <dir>/pr.md
//   pr-view.js splice <dir> < glow's output        prints it with the drawings in
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

const prepare = (prFile, dir, columns) => {
  const pr = JSON.parse(fs.readFileSync(prFile, "utf8"));
  const header = `# ${pr.title} #${pr.number}\n\n_${pr.isDraft ? "Draft" : pr.state} · ${pr.author?.login ?? "someone"} wants to merge \`${pr.headRefName}\` into \`${pr.baseRefName}\`_\n\n---\n\n`;
  let n = 0;
  const body = (pr.body ?? "").replace(/\r/g, "").replace(/^[ \t]*```+[ \t]*mermaid[ \t]*\n([\s\S]*?)^[ \t]*```+[ \t]*$/gm, (whole, source) => {
    n++;
    const drawn = draw(source, dir, n, columns);
    if (drawn === undefined || drawn === "") return `_A Mermaid diagram mermaid-ascii cannot draw; M-r shows it on GitHub:_\n\n\`\`\`mermaid\n${source}\`\`\``;
    fs.writeFileSync(path.join(dir, `${n}.txt`), drawn);
    return `${MARK}${n}`;
  });
  fs.writeFileSync(path.join(dir, "pr.md"), header + body);
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
else if (mode === "splice") splice(args[0]);
else {
  console.error("Usage: pr-view.js prepare <pr.json> <dir> <columns> | splice <dir>");
  process.exit(1);
}
