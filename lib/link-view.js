#!/usr/bin/env node
// A web page as Markdown, for tmux/link-view.sh to lay out with glow and page
// as the PR view does: fetched, its main part kept (<main>, else <article>,
// else <body>), what is no reading (scripts, styles, navigation, headers and
// footers, forms) dropped, and the rest turned into Markdown by turndown
// (lib/package.json), under the page's title and its address. Text and
// Markdown pages are kept as they are. Plain Node besides turndown.
//
//   link-view.js page <url> <out.md>

const fs = require("node:fs");
const TurndownService = require("turndown");

const MAX_BYTES = 5 * 1024 * 1024;
const DROP = ["script", "style", "noscript", "nav", "header", "footer", "aside", "form", "svg", "iframe", "button", "template"];

const page = async (url, out) => {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh) Switchboard link view", Accept: "text/html,text/markdown,text/plain;q=0.9,*/*;q=0.5" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`the site answered ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  const body = (await res.text()).slice(0, MAX_BYTES);
  if (!/html/i.test(type)) {
    if (!/text|markdown|json/i.test(type)) throw new Error(`it is ${type || "not text"}, which can't be read here`);
    fs.writeFileSync(out, `${url}\n\n---\n\n${body}`);
    return;
  }
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  turndown.remove(DROP);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.replace(/\s+/g, " ").trim() ?? url;
  const main = /<main[\s>][\s\S]*<\/main>/i.exec(body)?.[0] ?? /<article[\s>][\s\S]*<\/article>/i.exec(body)?.[0] ?? /<body[\s>][\s\S]*<\/body>/i.exec(body)?.[0] ?? body;
  const markdown = turndown.turndown(main).replace(/\n{3,}/g, "\n\n").trim();
  const decode = (text) => text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  fs.writeFileSync(out, `# ${decode(title)}\n\n${url}\n\n---\n\n${markdown}\n`);
};

const [mode, url, out] = process.argv.slice(2);
if (mode === "page" && /^https?:\/\//.test(url ?? "") && out) {
  page(url, out).catch((err) => {
    console.error(String(err.message).split("\n")[0]);
    process.exit(1);
  });
} else {
  console.error("Usage: link-view.js page <url> <out.md>");
  process.exit(2);
}
