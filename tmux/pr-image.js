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

// The marks kitty's Unicode placeholders carry for a cell's row and column,
// from kitty's gen/rowcolumn-diacritics.txt: the nth mark means row or
// column n.
const MARKS = [
  0x0305, 0x030D, 0x030E, 0x0310, 0x0312, 0x033D, 0x033E, 0x033F, 0x0346, 0x034A, 0x034B, 0x034C, 0x0350, 0x0351, 0x0352, 0x0357,
  0x035B, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369, 0x036A, 0x036B, 0x036C, 0x036D, 0x036E, 0x036F, 0x0483, 0x0484,
  0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599, 0x059C, 0x059D, 0x059E, 0x059F, 0x05A0, 0x05A1,
  0x05A8, 0x05A9, 0x05AB, 0x05AC, 0x05AF, 0x05C4, 0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657, 0x0658,
  0x0659, 0x065A, 0x065B, 0x065D, 0x065E, 0x06D6, 0x06D7, 0x06D8, 0x06D9, 0x06DA, 0x06DB, 0x06DC, 0x06DF, 0x06E0, 0x06E1, 0x06E2,
  0x06E4, 0x06E7, 0x06E8, 0x06EB, 0x06EC, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736, 0x073A, 0x073D, 0x073F, 0x0740, 0x0741, 0x0743,
  0x0745, 0x0747, 0x0749, 0x074A, 0x07EB, 0x07EC, 0x07ED, 0x07EE, 0x07EF, 0x07F0, 0x07F1, 0x07F3, 0x0816, 0x0817, 0x0818, 0x0819,
  0x081B, 0x081C, 0x081D, 0x081E, 0x081F, 0x0820, 0x0821, 0x0822, 0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082A, 0x082B, 0x082C,
  0x082D, 0x0951, 0x0953, 0x0954, 0x0F82, 0x0F83, 0x0F86, 0x0F87, 0x135D, 0x135E, 0x135F, 0x17DD, 0x193A, 0x1A17, 0x1A75, 0x1A76,
  0x1A77, 0x1A78, 0x1A79, 0x1A7A, 0x1A7B, 0x1A7C, 0x1B6B, 0x1B6D, 0x1B6E, 0x1B6F, 0x1B70, 0x1B71, 0x1B72, 0x1B73, 0x1CD0, 0x1CD1,
  0x1CD2, 0x1CDA, 0x1CDB, 0x1CE0, 0x1DC0, 0x1DC1, 0x1DC3, 0x1DC4, 0x1DC5, 0x1DC6, 0x1DC7, 0x1DC8, 0x1DC9, 0x1DCB, 0x1DCC, 0x1DD1,
  0x1DD2, 0x1DD3, 0x1DD4, 0x1DD5, 0x1DD6, 0x1DD7, 0x1DD8, 0x1DD9, 0x1DDA, 0x1DDB, 0x1DDC, 0x1DDD, 0x1DDE, 0x1DDF, 0x1DE0, 0x1DE1,
  0x1DE2, 0x1DE3, 0x1DE4, 0x1DE5, 0x1DE6, 0x1DFE, 0x20D0, 0x20D1, 0x20D4, 0x20D5, 0x20D6, 0x20D7, 0x20DB, 0x20DC, 0x20E1, 0x20E7,
  0x20E9, 0x20F0, 0x2CEF, 0x2CF0, 0x2CF1, 0x2DE0, 0x2DE1, 0x2DE2, 0x2DE3, 0x2DE4, 0x2DE5, 0x2DE6, 0x2DE7, 0x2DE8, 0x2DE9, 0x2DEA,
  0x2DEB, 0x2DEC, 0x2DED, 0x2DEE, 0x2DEF, 0x2DF0, 0x2DF1, 0x2DF2, 0x2DF3, 0x2DF4, 0x2DF5, 0x2DF6, 0x2DF7, 0x2DF8, 0x2DF9, 0x2DFA,
  0x2DFB, 0x2DFC, 0x2DFD, 0x2DFE, 0x2DFF, 0xA66F, 0xA67C, 0xA67D, 0xA6F0, 0xA6F1, 0xA8E0, 0xA8E1, 0xA8E2, 0xA8E3, 0xA8E4, 0xA8E5,
  0xA8E6, 0xA8E7, 0xA8E8, 0xA8E9, 0xA8EA, 0xA8EB, 0xA8EC, 0xA8ED, 0xA8EE, 0xA8EF, 0xA8F0, 0xA8F1, 0xAAB0, 0xAAB2, 0xAAB3, 0xAAB7,
  0xAAB8, 0xAABE, 0xAABF, 0xAAC1, 0xFE20, 0xFE21, 0xFE22, 0xFE23, 0xFE24, 0xFE25, 0xFE26, 0x10A0F, 0x10A38, 0x1D185, 0x1D186, 0x1D187,
  0x1D188, 0x1D189, 0x1D1AA, 0x1D1AB, 0x1D1AC, 0x1D1AD, 0x1D242, 0x1D243, 0x1D244,
];
// Its ID, which the placeholders carry as their 256-colour foreground: above
// 15, since tmux rewrites colours 0 to 15 as the basic ones, which carry no ID.
const IMAGE = 222;

// A kitty graphics image, shown through Unicode placeholders, which is what
// works inside tmux: the image is sent once (passed through tmux to the
// terminal, wrapped as tmux wants), with a virtual placement the size of the
// pane, and then drawn by printing placeholder characters, U+10EEEE with a
// row mark and a column mark, coloured with the image's ID. To tmux those are
// text, so they sit in this pane and move and redraw with it. After a row's
// first cell, the terminal counts the columns on.
const show = (png, cols, rows) => {
  const data = png.toString("base64");
  const chunks = data.match(/.{1,4096}/g) ?? [];
  const tmux = (seq) => (process.env.TMUX ? `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\` : seq);
  // The screen is cleared first: clearing it after would delete the image
  // just sent along with what was on screen.
  let out = "\x1b[H\x1b[2J" + tmux(`\x1b_Ga=d,d=I,i=${IMAGE},q=2\x1b\\`);
  chunks.forEach((chunk, i) => {
    const more = i < chunks.length - 1 ? 1 : 0;
    // Not quiet (q=1: errors only), so the footer can say why a page failed.
    const head = i === 0 ? `a=T,U=1,f=100,i=${IMAGE},c=${cols},r=${rows},q=1,m=${more}` : `m=${more}`;
    out += tmux(`\x1b_G${head};${chunk}\x1b\\`);
  });
  const cell = String.fromCodePoint(0x10eeee);
  out += `\x1b[38;5;${IMAGE}m`;
  for (let r = 0; r < Math.min(rows, MARKS.length); r++) {
    out += `\x1b[${r + 1};1H${cell}${String.fromCodePoint(MARKS[r])}${String.fromCodePoint(MARKS[0])}${cell.repeat(cols - 1)}`;
  }
  process.stdout.write(`${out}\x1b[39m`);
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
  // The terminal's last word on a page: kitty graphics answer an error as
  // ESC _G i=<id>;<message> ESC \.
  let said = "";
  const draw = () => {
    show(shots[at], cols, rows);
    process.stdout.write(`\x1b[${rows + 1};1H\x1b[2K\x1b[38;5;244m page ${at + 1}/${pages}   j k space b: page   r: redraw   q: close${said ? `   \x1b[31m${said}` : ""}\x1b[0m`);
  };
  process.stdin.setRawMode(true);
  process.stdin.on("data", (key) => {
    const k = key.toString();
    const reply = /\x1b_G([^\x1b]*)\x1b\\/.exec(k);
    if (reply) {
      said = reply[1];
      process.stdout.write(`\x1b[${rows + 1};1H\x1b[2K\x1b[38;5;244m page ${at + 1}/${pages}   \x1b[31m${said}\x1b[0m`);
      return;
    }
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
