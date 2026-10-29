// One call to a tool of Claude's connectors (Notion, Google Drive, Slack),
// for scripts that can't reach them otherwise: a headless Haiku with no
// built-in tools but tool search, and only that one tool allowed, told to load
// it and call it once with the given input. Tool search keeps every other
// connector's tool definitions out of its context: with them all loaded, a
// call read about 230,000 tokens a turn and cost about $0.05, against well
// under a cent this way. The answer is the call's own result, taken
// from the stream rather than from what Haiku says, so it is what the
// connector gave. Its stdin is closed, so it doesn't wait for input, and it
// keeps no session. Claude Code's own bin is added to the PATH, for the
// sidebar daemon, which tmux starts without it. A result too large for the
// conversation is saved to a file, which is read instead. Used by
// lib/link-view.js, lib/search.js and the meeting notes
// (lib/sidebar/meetings.js).
//
//   const text = await callConnector("mcp__claude_ai_Notion__notion-fetch", { id: url });

const fs = require("node:fs");
const os = require("node:os");
const { execFile } = require("node:child_process");

const callConnector = (tool, input, { timeout = 120_000 } = {}) =>
  new Promise((resolve, reject) => {
    const prompt = `Load ${tool} with ToolSearch (query "select:${tool}"), then call it once, with exactly this input: ${JSON.stringify(input)}. Then reply "done".`;
    const child = execFile(
      "claude",
      ["-p", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--tools", "ToolSearch", "--allowedTools", `ToolSearch,${tool}`, "--max-turns", "4", prompt],
      { cwd: os.tmpdir(), env: { ...process.env, PATH: `${process.env.PATH}:${os.homedir()}/.local/bin`, ENABLE_TOOL_SEARCH: "true", MAX_MCP_OUTPUT_TOKENS: "200000" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout },
      (err, stdout) => {
        if (err) return reject(new Error(err.code === "ENOENT" ? "Claude Code isn't installed" : `Claude didn't answer (${String(err.message).split("\n")[0]})`));
        const parts = stdout.split("\n").flatMap((line) => {
          try {
            const content = JSON.parse(line).message?.content;
            return Array.isArray(content) ? content : [];
          } catch {
            return [];
          }
        });
        const use = parts.find((p) => p.type === "tool_use" && p.name === tool);
        const result = use && parts.find((p) => p.type === "tool_result" && p.tool_use_id === use.id);
        if (!result) return reject(new Error("the connector wasn't called; is it connected in Claude?"));
        const text = Array.isArray(result.content) ? result.content.map((c) => c.text ?? "").join("") : String(result.content ?? "");
        // Claude Code says where it put a result too large to show, as text
        // or as the result's content blocks in JSON; the file is read and
        // removed, being this call's alone.
        const saved = /(?:has been saved to|Full output saved to:) (\/\S+?\.(txt|json))\b/.exec(text);
        if (saved) {
          try {
            const raw = fs.readFileSync(saved[1], "utf8");
            fs.rmSync(saved[1], { force: true });
            return resolve(saved[2] === "json" ? JSON.parse(raw).map((c) => c.text ?? "").join("") : raw);
          } catch {}
        }
        if (result.is_error) return reject(new Error(text.split("\n")[0] || "the connector refused"));
        resolve(text);
      },
    );
    child.stdin.end();
  });

module.exports = { callConnector };
