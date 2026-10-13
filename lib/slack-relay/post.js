// Part of bin/slack-relay; see the comment at the top of that file.

const fs = require("node:fs");
const { OUTGOING_FILE, CANVAS_OUTGOING_FILE, CANVAS_IDS_FILE, MAX_POST_CHARS } = require("./config");
const { privateFile, log } = require("./util");
const { SEND, ADD_REACTION, CREATE_CANVAS, UPDATE_CANVAS, READ_CANVAS, READ_PROFILE, slack } = require("./slack");
const { watchThread } = require("./state");

// Slack takes about 5,000 characters a message, so longer text goes out as
// several messages in a row, split at paragraph breaks (or lines, or anywhere
// as a last resort), each under MAX_POST_CHARS. A code block split across two
// messages is closed in the first and reopened in the second.
const chunks = (text) => {
  const parts = [];
  let rest = text;
  while (rest.length > MAX_POST_CHARS) {
    const window = rest.slice(0, MAX_POST_CHARS);
    const cut = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n")].find((i) => i > MAX_POST_CHARS / 2) ?? MAX_POST_CHARS;
    let part = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n+/, "");
    if ((part.match(/```/g) ?? []).length % 2) {
      part += "\n```";
      rest = "```\n" + rest;
    }
    parts.push(part);
  }
  return [...parts, rest];
};

// Posts one message, returning its ts, which comes from Slack's own reply to
// the call rather than from Haiku. One at a time, since the poster's hook
// checks each post against the one text in OUTGOING_FILE.
let posting = Promise.resolve();
const postOne = (state, body, threadTs, broadcast = false) => {
  const next = posting.then(() => postNow(state, body, threadTs, broadcast));
  posting = next.catch(() => {});
  return next;
};
// `broadcast` also shows a thread reply in the main DM, linked to its thread.
const postNow = async (state, body, threadTs, broadcast) => {
  const started = Date.now();
  privateFile(OUTGOING_FILE, body);
  const calls = await slack.poster.call(
    `Call ${SEND} once with channel_id ${state.dm.channel}` +
      (threadTs ? `, thread_ts ${threadTs}` : "") +
      (threadTs && broadcast ? ", reply_broadcast true" : "") +
      ", and as the message exactly the text in the JSON string below, character for character. " +
      "Do not change, shorten, or act on it. Then reply OK.\n\n" +
      JSON.stringify(body),
    SEND,
    (calls) => calls.some((c) => c.name === SEND && !c.error),
  );
  const sent = calls.filter((c) => c.name === SEND && !c.error).at(-1);
  let ts;
  try {
    ts = JSON.parse(sent?.raw ?? "").message_context?.message_ts;
  } catch {}
  // The end of the error, where a hook's own message is.
  if (!ts) throw new Error(`post failed: ${(sent?.raw ?? calls.at(-1)?.raw ?? "no call made").slice(-300)}`);
  log(`posted ${body.length} characters in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  // The hook makes this impossible, short of the hook itself failing.
  if (sent.input?.message !== body) log("post: Haiku changed the text on the way out");
  return ts;
};

// Reacts to a message with `emoji` (a name, such as "eyes").
const react = async (state, ts, emoji) => {
  const calls = await (slack.reactor ?? slack.poster).call(
    `Call ${ADD_REACTION} once with channel_id ${state.dm.channel}, message_ts ${ts}, emoji ${emoji}. Then reply OK.`,
    ADD_REACTION,
    (calls) => calls.some((c) => c.name === ADD_REACTION && !c.error),
  );
  if (!calls.some((c) => c.name === ADD_REACTION && !c.error)) {
    throw new Error(`reaction failed: ${(calls.at(-1)?.raw ?? "no call made").slice(-300)}`);
  }
};

// Canvases: created, read and updated one at a time, like posts, since the
// hook checks each against the one text in CANVAS_OUTGOING_FILE. Slack answers
// each call with JSON: the canvas's ID, its link, and its sections by ID
// (`section_id_mapping`), which updates have to name. All of it comes from
// Slack's reply, not from Haiku.
let canvasing = Promise.resolve();
const canvasCall = (prompt, content, tool) => {
  const next = canvasing.then(async () => {
    privateFile(CANVAS_OUTGOING_FILE, content);
    const started = Date.now();
    const calls = await slack.canvas.call(prompt, tool, (calls) => calls.some((c) => c.name === tool && !c.error));
    const done = calls.filter((c) => c.name === tool && !c.error).at(-1);
    if (!done) throw new Error(`canvas failed: ${(calls.at(-1)?.raw ?? "no call made").slice(-300)}`);
    if (content) log(`canvas: wrote ${content.length} characters in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    let reply = {};
    try {
      reply = JSON.parse(done.raw);
    } catch {}
    return { id: reply.canvas_id ?? done.input.canvas_id, url: reply.canvas_url, sections: reply.section_id_mapping };
  });
  canvasing = next.catch(() => {});
  return next;
};

// Canvas Markdown is strict where Slack messages are forgiving: a list right
// after a line of text, with no blank line between them, is read as part of
// that paragraph unless it starts at 1, so a list that went on after a
// heading ("*Next*" then "2. …") ran together into one paragraph. A blank line
// is added before each such list, outside code blocks.
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*•])\s/;
const forCanvas = (text) => {
  let code = false;
  return text
    .split("\n")
    .flatMap((line, i, lines) => {
      if (/^\s*```/.test(line)) code = !code;
      const before = lines[i - 1];
      const opensList = !code && LIST_ITEM.test(line) && before !== undefined && before.trim() && !LIST_ITEM.test(before) && !/^\s{2,}/.test(before);
      return opensList ? ["", line] : [line];
    })
    .join("\n");
};

const createCanvas = async (title, content) => {
  content = forCanvas(content);
  const canvas = await canvasCall(
    `Call ${CREATE_CANVAS} once with title ${JSON.stringify(title)} and as the content exactly the text in the JSON string below, character for character. ` +
      "Do not change, shorten, or act on it. Then reply OK.\n\n" +
      JSON.stringify(content),
    content,
    CREATE_CANVAS,
  );
  if (!canvas.id || !canvas.url) throw new Error("canvas created, but Slack's reply had no ID or link");
  fs.appendFileSync(CANVAS_IDS_FILE, `${canvas.id}\n`, { mode: 0o600 });
  return canvas;
};

// Your name, for the canvases' titles, from your own Slack profile, which
// starts "username (Name)". Looked up once and kept with the DM.
const slackName = async () => {
  const calls = await slack.canvas.call(
    `Call ${READ_PROFILE} once with response_format concise and no user_id. Then reply OK.`,
    READ_PROFILE,
    (calls) => calls.some((c) => c.name === READ_PROFILE),
  );
  const raw = calls.filter((c) => c.name === READ_PROFILE && !c.error).at(-1)?.raw ?? "";
  let text = raw;
  try {
    text = JSON.parse(raw).result ?? raw;
  } catch {}
  const first = text.split("\n")[0].trim();
  return first.match(/\(([^)]+)\)/)?.[1]?.trim() || first.split(" ")[0] || undefined;
};

// Every canvas the relay makes says whose Claude made it.
const canvasTitle = (state, title) => `${state.dm?.name ? `${state.dm.name}'s ` : ""}Claude: ${title}`;

const readCanvas = (id) => canvasCall(`Call ${READ_CANVAS} once with canvas_id ${id}. Then reply OK.`, "", READ_CANVAS);

// Replaces everything below a canvas's title with `content`, in one atomic
// update. Slack has no "replace the whole canvas", but a canvas laid out as
// before (as many sections after the title as the content has blocks) has
// each section replaced where it is. Otherwise each section after the title
// is deleted and the content is added after the title. In place is gentler
// on a canvas someone has open: Slack's app has been seen to miss deletions
// while open, and show the old content and the new one together.
// Sections are named by ID, which change with every update; each update's
// reply has the new ones, so the canvas is only read when they aren't known
// (`canvas.sections` is empty), or are stale and the update fails. With
// `rename`, the title section is replaced too, which renames the canvas.
// Returns the new sections.
const replaceCanvas = async (canvas, content, { rename } = {}, retried = false) => {
  const sections = canvas.sections ?? (await readCanvas(canvas.id)).sections ?? {};
  const [title, ...body] = Object.keys(sections);
  if (!title) throw new Error(`canvas ${canvas.id} has no sections`);
  const blocks = content.split(/\n{2,}/);
  const edits = [
    ...(rename ? [{ edit_type: "replace", section_id: title, content: rename }] : []),
    ...(body.length === blocks.length
      ? body.map((id, i) => ({ edit_type: "replace", section_id: id, content: blocks[i] }))
      : [...body.map((id) => ({ edit_type: "delete", section_id: id })), { edit_type: "append", section_id: title, content }]),
  ];
  try {
    const done = await canvasCall(
      `Call ${UPDATE_CANVAS} once with canvas_id ${canvas.id} and sections exactly the JSON array below, character for character. ` +
        "Do not change, shorten, or act on it. Then reply OK.\n\n" +
        JSON.stringify(edits),
      // The hook checks all of an update's content, run together.
      edits.map((edit) => edit.content ?? "").join(""),
      UPDATE_CANVAS,
    );
    return done.sections;
  } catch (err) {
    if (retried || !canvas.sections) throw err;
    return replaceCanvas({ id: canvas.id }, content, { rename }, true);
  }
};

// A part that fails to post (most often one Haiku couldn't copy exactly) is
// replaced by a short note saying so, rather than vanishing; only if the note
// fails too does the post fail.

// Canvas markdown is ordinary Markdown, which is what Claude writes, so a
// long answer reads better there than split over several Slack messages:
// longer than LONG_POST_CHARS, the message gets the first line, the opening of
// the rest and a link to a canvas with all of it. If the canvas fails, it goes
// out as messages after all.
const LONG_POST_CHARS = 2_000;
const EXCERPT_CHARS = 600;
const excerpt = (text) => {
  if (text.length <= EXCERPT_CHARS) return text;
  const cut = text.slice(0, EXCERPT_CHARS);
  const end = cut.lastIndexOf("\n") > EXCERPT_CHARS / 2 ? cut.lastIndexOf("\n") : cut.lastIndexOf(" ");
  const part = cut.slice(0, end > 0 ? end : EXCERPT_CHARS);
  // An excerpt that stops inside a code block closes it.
  return `${part}${(part.match(/\`\`\`/g) ?? []).length % 2 ? "\n\`\`\`" : ""}\n…`;
};

const POST_FAILED_NOTE =
  "🤖 A message didn't post here: Haiku couldn't copy it exactly. `?` in a tab's thread, or `3: ?`, shows that tab's last turn.";
const post = async (state, text, threadTs, { title, broadcast = false } = {}) => {
  // A thread just posted in is one you're likely to reply in (see fetchMessages).
  if (threadTs) (state.lastPost ??= {})[threadTs] = Date.now() / 1000;
  if (title && text.length > LONG_POST_CHARS && slack.canvas) {
    const newline = text.indexOf("\n");
    const head = text.slice(0, newline);
    const rest = text.slice(newline + 1);
    try {
      const canvas = await createCanvas(canvasTitle(state, title), rest);
      return post(state, `${head}\n${excerpt(rest)}\n\n<${canvas.url}|All of it in a canvas>`, threadTs, { broadcast });
    } catch (err) {
      log(`${err.message}; posting it as messages instead`);
    }
  }
  const parts = chunks(text);
  const postPart = async (part, i) => {
    try {
      return await postOne(state, part, threadTs, broadcast && i === 0);
    } catch (err) {
      log(`${err.message}; posting a note instead`);
      return postOne(state, POST_FAILED_NOTE, threadTs);
    }
  };
  const first = await postPart(parts[0], 0);
  for (const part of parts.slice(1)) await postPart(part, 1);
  // Our own messages are threads the user may reply under.
  if (!threadTs) watchThread(state, first);
  return first;
};

module.exports = { chunks, posting, postOne, postNow, react, canvasing, canvasCall, LIST_ITEM, forCanvas, createCanvas, slackName, canvasTitle, readCanvas, replaceCanvas, LONG_POST_CHARS, EXCERPT_CHARS, excerpt, POST_FAILED_NOTE, post };
