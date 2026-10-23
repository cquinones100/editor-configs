#!/usr/bin/env node

// The PR view as GitHub draws it, as images in the pane: a trial beside
// tmux/pr-view.sh (M-v), which draws it as text. Run in a pane by
// tmux/pr-image.sh, from the M-p palette.
//
//   pr-image.js [<dir>]   the PR of <dir>'s branch (default: the current directory)
//
// The description comes as GitHub renders it (the pull request's body_html,
// read with a GET, so links, mentions and checklists are GitHub's own), into a
// page with GitHub's dark stylesheet and Mermaid drawing each diagram,
// opened in a headless Chrome: mermaid-cli's puppeteer, found from its global
// install, since this repository installs no packages for it. The page is
// screenshotted a pane-sized page at a time, and each page shown through the
// kitty graphics protocol, which Ghostty speaks, passed through tmux (the
// pane's allow-passthrough). j, k, the arrows, Space and b page; g and G go
// to the ends; q closes it.
//
// Images in tmux are its weak point: tmux doesn't know they are there, so a
// tab switch or a resize can leave one stale until the page is drawn again,
// which r does.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CSS = "https://cdn.jsdelivr.net/npm/github-markdown-css@5.8.1/github-markdown-dark.css";
const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";
const WIDTH = 900;

const fail = (message) => {
  process.stdout.write(`\n  \x1b[31m${message}\x1b[0m\n\n  \x1b[38;5;244mPress any key to close.\x1b[0m`);
  process.stdin.setRawMode?.(true);
  process.stdin.once("data", () => process.exit(0));
};

const puppeteer = () => {
  try {
    const root = execFileSync("pnpm", ["root", "-g"], { encoding: "utf8" }).trim();
    // Its real path: pnpm links it in from its store, and puppeteer sits beside
    // it there.
    return require(require.resolve("puppeteer", { paths: [fs.realpathSync(path.join(root, "@mermaid-js/mermaid-cli"))] }));
  } catch {
    return undefined;
  }
};

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// GitHub's HTML, Mermaid blocks turned back into their source for Mermaid to draw.
const pageFor = (pr, html) => {
  // GitHub wraps a diagram's source in a section its own viewer fills in.
  const diagrams = html.replace(/<section[^>]*data-type="mermaid"[^>]*>[\s\S]*?<pre lang="mermaid"[^>]*>([\s\S]*?)<\/pre>[\s\S]*?<\/section>/g, (_, inner) => `<pre class="mermaid">${inner}</pre>`);
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${CSS}">
<style>body { background: #0d1117; margin: 0; } .markdown-body { box-sizing: border-box; width: ${WIDTH}px; padding: 32px; } pre.mermaid { background: transparent; }</style>
</head><body><article class="markdown-body">
<h1>${escapeHtml(pr.title)} <span style="color:#7d8590">#${pr.number}</span></h1>
<p><em>${pr.isDraft ? "Draft" : pr.state} · ${escapeHtml(pr.author?.login ?? "")} wants to merge <code>${escapeHtml(pr.headRefName)}</code> into <code>${escapeHtml(pr.baseRefName)}</code></em></p>
${diagrams}
</article>
<script src="${MERMAID}"></script>
<script>mermaid.initialize({ startOnLoad: false, theme: "dark" }); mermaid.run().finally(() => { document.body.dataset.done = "1"; });</script>
</body></html>`;
};

// A kitty graphics image, in chunks, wrapped for tmux to pass through.
const show = (png, cols, rows) => {
  const data = png.toString("base64");
  const chunks = data.match(/.{1,4096}/g) ?? [];
  const tmux = (seq) => (process.env.TMUX ? `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\` : seq);
  let out = "\x1b[H\x1b[2J" + tmux("\x1b_Ga=d\x1b\\");
  chunks.forEach((chunk, i) => {
    const more = i < chunks.length - 1 ? 1 : 0;
    const head = i === 0 ? `a=T,f=100,c=${cols},r=${rows},q=2,m=${more}` : `m=${more}`;
    out += tmux(`\x1b_G${head};${chunk}\x1b\\`);
  });
  process.stdout.write(out);
};

const main = async () => {
  const dir = path.resolve(process.argv[2] ?? process.cwd());
  process.stdout.write("\n  \x1b[38;5;244mReading the PR…\x1b[0m");
  let pr;
  try {
    pr = JSON.parse(execFileSync("gh", ["pr", "view", "--json", "number,title,url,state,isDraft,author,baseRefName,headRefName,body"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return fail("No PR for this branch.");
  }
  const repo = /github\.com\/([^/]+\/[^/]+)\/pull/.exec(pr.url)?.[1];
  let html;
  try {
    html = execFileSync("gh", ["api", "-H", "Accept: application/vnd.github.full+json", `repos/${repo}/pulls/${pr.number}`, "--jq", ".body_html // \"\""], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return fail("Couldn't read the description as GitHub renders it.");
  }
  const lib = puppeteer();
  if (!lib) return fail("This needs mermaid-cli's puppeteer: pnpm add -g @mermaid-js/mermaid-cli");

  process.stdout.write("\r  \x1b[38;5;244mDrawing it…\x1b[0m   ");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pr-image-"));
  process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));
  const file = path.join(work, "pr.html");
  fs.writeFileSync(file, pageFor(pr, html));
  const browser = await lib.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: 800, deviceScaleFactor: 2 });
  await page.goto(`file://${file}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("body[data-done]", { timeout: 15_000 }).catch(() => {});
  const height = await page.evaluate(() => document.querySelector(".markdown-body").getBoundingClientRect().height);

  // A page is as tall as the pane, by the pane's shape in cells, a cell about
  // twice as tall as it is wide.
  const cols = process.stdout.columns || 80;
  const rows = (process.stdout.rows || 24) - 1;
  const pageHeight = Math.max(200, Math.round((WIDTH * rows * 2.1) / cols));
  const pages = Math.max(1, Math.ceil(height / pageHeight));
  const shots = [];
  for (let i = 0; i < pages; i++) {
    shots.push(await page.screenshot({ clip: { x: 0, y: i * pageHeight, width: WIDTH, height: Math.min(pageHeight, height - i * pageHeight) }, type: "png" }));
  }
  await browser.close();
  // For checking the drawing without a terminal: the pages as PNGs, and out.
  if (process.env.PR_IMAGE_DUMP) {
    shots.forEach((png, i) => fs.writeFileSync(path.join(process.env.PR_IMAGE_DUMP, `page-${i + 1}.png`), png));
    process.exit(0);
  }

  let at = 0;
  const draw = () => {
    show(shots[at], cols, rows);
    process.stdout.write(`\x1b[${rows + 1};1H\x1b[38;5;244m page ${at + 1}/${pages}   j k space b: page   r: redraw   q: close\x1b[0m`);
  };
  process.stdin.setRawMode(true);
  process.stdin.on("data", (key) => {
    const k = key.toString();
    if (k === "q" || k === "\x03" || k === "\x1b") {
      process.stdout.write("\x1b[2J");
      process.exit(0);
    }
    if (["j", " ", "\x1b[B", "\x1b[6~"].includes(k)) at = Math.min(pages - 1, at + 1);
    else if (["k", "b", "\x1b[A", "\x1b[5~"].includes(k)) at = Math.max(0, at - 1);
    else if (k === "g") at = 0;
    else if (k === "G") at = pages - 1;
    draw();
  });
  draw();
};

main().catch((err) => fail(err.message.split("\n")[0]));
