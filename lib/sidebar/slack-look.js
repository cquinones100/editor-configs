// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// The Slack view's look, run by the daemon in the background in place of a
// Slack tab looping /slack-updates: every SLACK_LOOK_MS while you're at the
// Mac, and when you go to the view. It reaches Slack through Claude's
// connector (lib/connector.js), a headless Haiku allowed one tool at a time
// with no session kept, so a look costs a few cheap calls and nothing grows.
//
// One search does it all: every message since the last look, in the
// conversations you are in, a page (SEARCH_PAGE) to a call, at most
// MAX_PAGES. Each result is sorted into what the view shows, as
// /slack-updates sorts them: a DM or group DM ("dm"), one that mentions you
// ("mention"), a reply by someone else in a thread you started ("thread"),
// or anything in the channels listed in ~/.config/slack-updates/config.json
// ("channel"); and what you wrote yourself ("replied", which tells the view
// that what came before it in that DM or thread was read). The rest is
// dropped. What it found goes through the skill's scripts/save.js, the one
// writer of STATE_DIR/slack.json, which also leaves out the relay's own DM.
//
// Your member ID and the threads you started in the last day are kept in
// STATE_DIR/slack-look.json. The connector answers in text, which
// resultsFrom parses, so a change to its layout belongs there.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { STATE_DIR } = require("./config");
const { callConnector } = require("../connector");

const SLACK_LOOK_MS = 2 * 60_000;
const SEARCH_PAGE = 20;
const MAX_PAGES = 10;
const DAY_MS = 24 * 60 * 60_000;
const SLACK = "mcp__claude_ai_Slack__";
const STATE = () => path.join(STATE_DIR, "slack-look.json");
const SAVE = path.join(__dirname, "../../claude/skills/slack-updates/scripts/save.js");
const CHANNELS = () => path.join(os.homedir(), ".config/slack-updates/config.json");

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

// The search's detailed results, one block each:
//   ### Result 1 of 20
//   Channel: DM (ID: D0…)            or  Channel: #general (ID: C0…)
//   Participants: Ada (ID: U1), Bo (ID: U2)
//   From: Ada (ID: U1)  [BOT]
//   Message_ts: 1793282136.936439
//   Permalink: [link](https://….slack.com/archives/D0…/p1793…?thread_ts=1793…&cid=D0…)
//   Text:
//   …
//   ---
const resultsFrom = (text) =>
  String(text ?? "")
    .split(/^### Result \d+ of \d+\s*$/m)
    .slice(1)
    .map((block) => {
      const field = (name) => new RegExp(`^${name}: (.*)$`, "m").exec(block)?.[1]?.trim() ?? "";
      const channel = /^(.*) \(ID: (\w+)\)$/.exec(field("Channel"));
      const from = /^(.*?) \(ID: (\w+)\)/.exec(field("From"));
      const link = /\[link\]\((https:\/\/[^)\s]+)\)/.exec(field("Permalink"))?.[1];
      const participants = [...field("Participants").matchAll(/([^,]+?) \(ID: (\w+)\)/g)].map((m) => ({ name: m[1].replace(/ *<[^>]*>/g, "").trim(), id: m[2] }));
      const at = block.search(/^Text:/m);
      const body = at < 0 ? "" : block.slice(at).replace(/^Text: ?\n?/, "").replace(/\n---\s*$/, "");
      return {
        channel: channel?.[2] ?? "",
        where: channel?.[1] ?? "",
        user: from?.[2] ?? "",
        from: (from?.[1] ?? "").replace(/ *<[^>]*>/g, ""),
        bot: /\[BOT\]/.test(field("From")),
        participants,
        ts: field("Message_ts"),
        thread: link ? new URL(link).searchParams.get("thread_ts") ?? undefined : undefined,
        link,
        text: body.trim(),
      };
    })
    .filter((m) => m.channel && /^\d+(\.\d+)?$/.test(m.ts));

// The connector's answer: JSON with the text under `results` (or `messages`)
// and the next page's cursor in `pagination_info`, or the text itself.
const pageOf = (answer) => {
  let parsed;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return { text: answer, cursor: undefined };
  }
  return { text: parsed.results ?? parsed.messages ?? "", cursor: /cursor[^`]*`([^`]+)`/.exec(parsed.pagination_info ?? "")?.[1] };
};

// Sorts what the search found, as the section at the top says.
const sortLook = (messages, me, mine, channels) => {
  const items = [];
  const replied = [];
  messages.forEach((m) => {
    if (m.user === me) {
      replied.push({ channel: m.channel, ts: m.ts, ...(m.thread && { thread: m.thread }) });
      if (!m.thread || m.thread === m.ts) mine.add(m.ts);
      return;
    }
    const dm = /^(DM|Group DM|Multi-party DM)\b/i.test(m.where) || /^[DG]/.test(m.channel);
    const others = m.participants.filter((p) => p.id !== me).map((p) => p.name);
    const kind = dm
      ? "dm"
      : m.text.includes(`<@${me}`)
        ? "mention"
        : m.thread && m.thread !== m.ts && mine.has(m.thread)
          ? "thread"
          : channels.includes(m.channel)
            ? "channel"
            : undefined;
    if (!kind) return;
    items.push({
      kind,
      channel: m.channel,
      where: dm ? others.join(", ") || m.from : m.where,
      user: m.user,
      from: m.from,
      text: m.text.replace(/<@\w+\|([^>]+)>/g, "@$1").replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2"),
      ts: m.ts,
      ...(m.thread && m.thread !== m.ts && { thread: m.thread }),
      ...(m.link && { link: m.link }),
    });
  });
  return { items, replied };
};

const run = (args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(process.execPath, args, { encoding: "utf8", timeout: 30_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
    if (input !== undefined) child.stdin.end(input);
  });

const lookSlack = async (log = () => {}, call = callConnector) => {
  const state = readJson(STATE(), {});
  if (!state.me) {
    const profile = await call(`${SLACK}slack_read_user_profile`, { response_format: "detailed" });
    state.me = /User ID: (U[A-Z0-9]{6,})/.exec(profile)?.[1];
    if (!state.me) throw new Error("couldn't tell your Slack member ID");
  }
  // save.js says where to look from: the last look less an overlap, and a day
  // back for your own messages until it keeps some.
  const [, since, mineSince] = (await run([SAVE, "--since"])).split(" ").map(Number);
  const from = Math.min(since, mineSince || since);
  const channels = readJson(CHANNELS(), {}).channels ?? [];
  const mine = new Set((state.mine ?? []).filter((ts) => Date.now() - Number(ts) * 1000 < DAY_MS));
  const day = new Date((from - 86_400) * 1000).toISOString().slice(0, 10);
  const messages = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await call(`${SLACK}slack_search_public_and_private`, {
      filters: `after:${day}`,
      after: String(from),
      sort: "timestamp",
      limit: SEARCH_PAGE,
      include_context: false,
      include_bots: true,
      only_my_channels: true,
      response_format: "detailed",
      ...(cursor && { cursor }),
    });
    const { text, cursor: next } = pageOf(answer);
    messages.push(...resultsFrom(text));
    if (!next) break;
    cursor = next;
  }
  // Messages from before the last look were only searched for your own.
  const { items, replied } = sortLook(
    messages.filter((m) => m.user === state.me || Number(m.ts) >= since),
    state.me,
    mine,
    channels,
  );
  await run([SAVE], JSON.stringify({ items, replied }));
  state.mine = [...mine].slice(-500);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE(), JSON.stringify(state));
  log(`slack: looked, ${items.length} new, ${replied.length} of yours`);
};

module.exports = { SLACK_LOOK_MS, resultsFrom, pageOf, sortLook, lookSlack };
