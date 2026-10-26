// Part of bin/slack-relay; see the comment at the top of that file.
//
// Notices other programs on this Mac post in the DM through the relay, as
// `slack-relay notify`: a loop that has to reach you, such as the oncall
// skill. They go out as the app's bot, so Slack notifies you of them, unlike
// anything posted as you (a self-DM, or a channel of your own), which it never
// does. Each one is a file in OUTBOX_DIR, which the running relay posts and
// answers with `<id>.sent` (the message's ts) or `<id>.failed` (why), which
// `notify` waits for, so a caller knows whether you were reached.
//
// What it posts is only text, in the DM, like everything the relay writes (see
// slack.js), and at once, whether or not you are at the computer: a notice is
// for you to see now.

const fs = require("node:fs");
const path = require("node:path");
const { STATE_DIR, LOCK_FILE } = require("./config");
const { privateFile, log } = require("./util");
const { chunks, postOne } = require("./post");

const OUTBOX_DIR = path.join(STATE_DIR, "outbox");
// How long `notify` waits for the relay to post, which it does within a
// second unless Slack is slow to answer.
const NOTIFY_WAIT_MS = 45_000;
// Answers nobody collected, and notices left by a relay that stopped before
// posting them, are dropped after this long: a notice an hour late is noise.
const OUTBOX_KEEP_MS = 60 * 60_000;
// A short name for who sent it, shown above the notice.
const FROM = /^[\w .:-]{1,40}$/;

const relayRunning = () => {
  try {
    process.kill(Number(fs.readFileSync(LOCK_FILE, "utf8").split(" ")[0]), 0);
    return true;
  } catch {
    return false;
  }
};

// Queues `text` and waits for the relay to post it. Resolves to the message's
// ts, or rejects saying why it wasn't posted.
const notify = async (text, { from = "notice", waitMs = NOTIFY_WAIT_MS } = {}) => {
  if (!text.trim()) throw new Error("nothing to send");
  if (!FROM.test(from)) throw new Error("--from takes up to 40 letters, digits, spaces and . : _ -");
  if (!relayRunning()) throw new Error("the relay isn't running; start it with `slack-relay`");
  fs.mkdirSync(OUTBOX_DIR, { recursive: true, mode: 0o700 });
  const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(OUTBOX_DIR, id);
  // Written whole, then renamed into place, so the relay never reads half.
  privateFile(`${file}.tmp`, JSON.stringify({ from, text }));
  fs.renameSync(`${file}.tmp`, `${file}.json`);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    for (const [ending, ok] of [[".sent", true], [".failed", false]]) {
      let answer;
      try {
        answer = fs.readFileSync(file + ending, "utf8");
      } catch {
        continue;
      }
      fs.rmSync(file + ending, { force: true });
      if (ok) return answer;
      throw new Error(answer);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // Not posted in time: taken back, so it can't arrive late as well.
  fs.rmSync(`${file}.json`, { force: true });
  throw new Error("the relay didn't post it in time");
};

// In the relay: posts every queued notice, oldest first, and answers each.
const deliverOutbox = async (state) => {
  let names;
  try {
    names = fs.readdirSync(OUTBOX_DIR).sort();
  } catch {
    return;
  }
  const now = Date.now();
  names
    .filter((name) => now - Number(name.split("-")[0]) > OUTBOX_KEEP_MS)
    .forEach((name) => fs.rmSync(path.join(OUTBOX_DIR, name), { force: true }));
  for (const name of names.filter((n) => n.endsWith(".json") && now - Number(n.split("-")[0]) <= OUTBOX_KEEP_MS)) {
    const file = path.join(OUTBOX_DIR, name);
    const id = file.slice(0, -".json".length);
    let notice;
    try {
      notice = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.rmSync(file);
    } catch {
      continue;
    }
    try {
      const from = FROM.test(notice.from) ? notice.from : "notice";
      const [first, ...rest] = chunks(`🔔 **${from}**\n${String(notice.text)}`);
      const ts = await postOne(state, first);
      for (const part of rest) await postOne(state, part, ts);
      privateFile(`${id}.sent`, ts);
      log(`posted a notice from ${from}`);
    } catch (err) {
      privateFile(`${id}.failed`, err.message);
      log(`notice failed: ${err.message}`);
    }
  }
};

module.exports = { OUTBOX_DIR, NOTIFY_WAIT_MS, OUTBOX_KEEP_MS, relayRunning, notify, deliverOutbox };
