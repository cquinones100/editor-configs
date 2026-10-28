#!/usr/bin/env node
// A web page as Markdown, for tmux/link-view.sh to lay out with glow and page
// as the PR view does: fetched, its main part kept (<main>, else <article>,
// else <body>), what is no reading (scripts, styles, navigation, headers and
// footers, forms) dropped, and the rest turned into Markdown by turndown
// (lib/package.json), under the page's title and its address. Text and
// Markdown pages are kept as they are. Plain Node besides turndown.
//
// A Notion page or a Google Doc or Slides deck can't be fetched that way, being
// private, so `doc` asks Claude's connectors for it: a headless Haiku with no
// tools but the one connector call (notion-fetch, or Drive's
// read_file_content), whose answer is taken from the call's result rather than
// from what Haiku says, so the page is shown as the connector gave it.
//
//   link-view.js page <url> <out.md>
//   link-view.js doc <url> <out.md>

const fs = require("node:fs");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
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

const NOTION = /^https:\/\/([a-z0-9-]+\.)?notion\.(so|site|com)\//i;
const GOOGLE = /^https:\/\/docs\.google\.com\/(document|presentation)\/d\/([A-Za-z0-9_-]+)/;

// Which connector call reads a link, and with what.
const callFor = (url) => {
  if (NOTION.test(url)) return { tool: "mcp__claude_ai_Notion__notion-fetch", input: { id: url } };
  const google = GOOGLE.exec(url);
  if (google) return { tool: "mcp__claude_ai_Google_Drive__read_file_content", input: { fileId: google[2] } };
  return undefined;
};

// Notion's Markdown carries HTML for what Markdown lacks: its tables become
// Markdown tables, bold and italics Markdown's, and its other tags (callouts,
// columns, mentions) give way to their text.
const notionMarkdown = (text) => {
  const content = /<content>([\s\S]*)<\/content>/.exec(text)?.[1] ?? text;
  const inline = (html) =>
    html
      .replace(/<(b|strong)>([\s\S]*?)<\/\1>/g, "**$2**")
      .replace(/<(i|em)>([\s\S]*?)<\/\1>/g, "_$2_")
      .replace(/<code>([\s\S]*?)<\/code>/g, "`$1`")
      .replace(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, "[$2]($1)")
      .replace(/<mention-[a-z]+ [^>]*title="([^"]*)"[^>]*\/>/g, "$1")
      .replace(/<\/?[a-z][a-z-]*(\s[^>]*)?\/?>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const tables = content.replace(/<table[^>]*>([\s\S]*?)<\/table>/g, (_, table) => {
    const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
      [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) => inline(cell[1]).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")),
    );
    if (!rows.length) return "";
    const line = (cells) => `| ${cells.join(" | ")} |`;
    return [line(rows[0]), line(rows[0].map(() => "---")), ...rows.slice(1).map(line)].join("\n");
  });
  return inline(tables).replace(/\n{3,}/g, "\n\n").trim();
};

const doc = async (url, out) => {
  const call = callFor(url);
  if (!call) throw new Error("it isn't a Notion page or a Google Doc or Slides deck");
  const prompt = `Call ${call.tool} once, with exactly this input: ${JSON.stringify(call.input)}. Then reply "done".`;
  // No built-in tools and no tool search, so the one tool allowed is all it has.
  const { stdout } = await promisify(execFile)(
    "claude",
    ["-p", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--tools", "", "--allowedTools", call.tool, "--max-turns", "3", prompt],
    { cwd: os.tmpdir(), env: { ...process.env, ENABLE_TOOL_SEARCH: "false" }, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
  ).catch((err) => {
    throw new Error(err.code === "ENOENT" ? "Claude Code isn't installed" : `Claude didn't answer (${String(err.message).split("\n")[0]})`);
  });
  const events = stdout.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const parts = events.flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []));
  const use = parts.find((p) => p.type === "tool_use" && p.name === call.tool);
  const result = use && parts.find((p) => p.type === "tool_result" && p.tool_use_id === use.id);
  if (!result) throw new Error("the connector wasn't called; is it connected in Claude?");
  const text = Array.isArray(result.content) ? result.content.map((c) => c.text ?? "").join("") : String(result.content ?? "");
  if (result.is_error) throw new Error(text.split("\n")[0] || "the connector refused");
  const body = JSON.parse(text);
  const markdown = NOTION.test(url) ? notionMarkdown(body.text ?? "") : String(body.fileContent ?? "").trim();
  fs.writeFileSync(out, `# ${body.title ?? url}\n\n${url}\n\n---\n\n${markdown}\n`);
};

const [mode, url, out] = process.argv.slice(2);
const modes = { page, doc };
if (modes[mode] && /^https?:\/\//.test(url ?? "") && out) {
  modes[mode](url, out).catch((err) => {
    console.error(String(err.message).split("\n")[0]);
    process.exit(1);
  });
} else {
  console.error("Usage: link-view.js page|doc <url> <out.md>");
  process.exit(2);
}
