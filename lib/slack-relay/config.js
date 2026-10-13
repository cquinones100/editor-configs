// Part of bin/slack-relay; see the comment at the top of that file.

const os = require("node:os");
const path = require("node:path");

const WINDOW_NAME = "slack-relay";
const STATE_DIR = path.join(os.homedir(), ".local/state/slack-relay");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const LOG_FILE = path.join(STATE_DIR, "relay.log");
const MAX_LOG_BYTES = 1_000_000;
// Turn ends and waits reported by the Claude Code hooks (tmux/agent-state.sh);
// see newEvents.
const EVENTS_FILE = path.join(STATE_DIR, "events.jsonl");
// The text of the post being made, which the poster's hook checks the post
// against (see dmOnly).
const OUTGOING_FILE = path.join(STATE_DIR, "outgoing.txt");
// The same for canvases, which have their own session (see canvasOnly), and
// the canvases the relay made, the only ones it may change.
const CANVAS_OUTGOING_FILE = path.join(STATE_DIR, "canvas-outgoing.txt");
const CANVAS_IDS_FILE = path.join(STATE_DIR, "canvases.txt");
// Only one relay listens to the DM at a time.
const LOCK_FILE = path.join(STATE_DIR, "relay.lock");

// The events file is also watched, so a hook's event is acted on at once.
const TAB_POLL_MS = 1_000;
// READERS readers take turns at the quick checks: a check starts this long
// after the previous one started, if one is free. Once you have written
// nothing (no message, no reaction) for QUIET_AFTER_MS, the checks slow to
// one every QUIET_STAGGER_MS, and the first thing you send puts them back.
// Every check is a Haiku turn, and checking every 0.8 seconds around the
// clock measured about 3,800 turns an hour; slowed when you're quiet, the
// first message after a quiet spell waits a few seconds rather than one.
const READ_STAGGER_MS = 800;
const QUIET_AFTER_MS = 10 * 60_000;
const QUIET_STAGGER_MS = 5_000;
const READERS = 3;
// Threads with a message in this window are "hot": every quick check reads
// their new replies directly (see fetchMessages), at most MAX_HOT of them.
// Kept small on purpose: each hot thread is one more call for Haiku to write
// in every quick check, and with 7 of them a check took twice as long and its
// reader filled up and restarted every minute, so messages waited 5-10
// seconds. Quieter threads are the wide reader's.
const HOT_THREAD_MS = 10 * 60_000;
const MAX_HOT = 4;
// Every WIDE_POLL_MS a separate reader reads back far enough to see new
// replies under any watched message, hot or not, following up to WIDE_PAGES
// pages of the DM. That read is big (a day of the DM), so it has a reader of
// its own, which restarts often without ever holding up a quick check.
// Every 30 seconds rather than 5: it is the most expensive read (a day of
// the DM each time), and only replies under older messages wait for it.
const WIDE_POLL_MS = 30_000;
const WIDE_PAGES = 4;
// Your replies are looked for under messages of the last day, up to this many.
const THREAD_WINDOW_MS = 24 * 60 * 60_000;
const MAX_THREADS = 30;
const SCREEN_LINES = 30;
// A tab that reports no state (a Claude started before the hooks) counts as
// done once its screen has stopped changing for this long.
const QUIET_SCREEN_MS = 20_000;
const FOLLOW_UP_LIMIT_MS = 60 * 60_000;
// How long a tab that isn't busy may take to pick up a typed message before
// the relay says it hasn't.
const PICKUP_WARN_MS = 30_000;
// Claude Code writes the transcript behind the session, by tens of seconds for
// one running in the background, so a turn reported ended is read again until
// the transcript has caught up, for up to this long, before it is posted as
// it is (with its final message from the Stop hook, when the hook gave one).
const REPLY_WAIT_MS = 60_000;
const MAX_POST_CHARS = 3_500;

const VERSION = /^\d+\.\d+\.\d+$/;
const OWN_MESSAGE = /^(🤖|:robot_face:)/;

module.exports = { WINDOW_NAME, STATE_DIR, STATE_FILE, LOG_FILE, MAX_LOG_BYTES, EVENTS_FILE, OUTGOING_FILE, CANVAS_OUTGOING_FILE, CANVAS_IDS_FILE, LOCK_FILE, TAB_POLL_MS, READ_STAGGER_MS, QUIET_AFTER_MS, QUIET_STAGGER_MS, READERS, HOT_THREAD_MS, MAX_HOT, WIDE_POLL_MS, WIDE_PAGES, THREAD_WINDOW_MS, MAX_THREADS, SCREEN_LINES, QUIET_SCREEN_MS, FOLLOW_UP_LIMIT_MS, PICKUP_WARN_MS, REPLY_WAIT_MS, MAX_POST_CHARS, VERSION, OWN_MESSAGE };
