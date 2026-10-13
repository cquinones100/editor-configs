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
// Whose relay this is: { "owner": "<your Slack member ID>" } (see loadOwner).
// Outside this repository, since it names a person.
const CONFIG_FILE = path.join(os.homedir(), ".config/slack-relay/config.json");
// Only one relay listens to the DM at a time.
const LOCK_FILE = path.join(STATE_DIR, "relay.lock");

// The events file is also watched, so a hook's event is acted on at once.
const TAB_POLL_MS = 1_000;
// Threads you may reply in are watched for a day, up to this many: a reply in
// one is handled as part of that conversation, and caught up after a restart.
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

module.exports = { WINDOW_NAME, STATE_DIR, STATE_FILE, LOG_FILE, MAX_LOG_BYTES, EVENTS_FILE, CONFIG_FILE, LOCK_FILE, TAB_POLL_MS, THREAD_WINDOW_MS, MAX_THREADS, SCREEN_LINES, QUIET_SCREEN_MS, FOLLOW_UP_LIMIT_MS, PICKUP_WARN_MS, REPLY_WAIT_MS, MAX_POST_CHARS, VERSION };
