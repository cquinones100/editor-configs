// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// Mission control's PR board: your pull requests in the repositories your
// tabs are in, as columns by where they stand: Draft, In review, Approved, In
// merge queue, and Merged in the last MERGED_DAYS. Fetched every
// BOARD_POLL_MS in the background with two searches, through gh, and drawing
// reads only the last answer; a failed fetch keeps it. Only those
// repositories, so old pull requests elsewhere stay off the board.

const { execFile } = require("node:child_process");
const { repoOf } = require("./prs");

const BOARD_POLL_MS = 120_000;
const MERGED_DAYS = 7;
const COLUMNS = ["Draft", "In review", "Approved", "In merge queue", "Merged"];
const FIELDS = "... on PullRequest { number title url isDraft state reviewDecision mergedAt repository { nameWithOwner } mergeQueueEntry { position } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }";

const board = { columns: COLUMNS.map((title) => ({ title, items: [] })), loaded: false, error: undefined };

const columnOf = (pr) =>
  pr.state === "MERGED" ? "Merged" : pr.mergeQueueEntry ? "In merge queue" : pr.isDraft ? "Draft" : pr.reviewDecision === "APPROVED" ? "Approved" : "In review";

// A board card: the PR and its title, then where it is, its checks and its
// review. Failing checks or changes asked for need you.
const itemOf = (pr) => {
  const checks = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  const failing = checks === "FAILURE" || checks === "ERROR";
  const marks = [pr.repository.nameWithOwner.split("/")[1], failing ? "✗ checks" : checks === "PENDING" ? "⏳ checks" : checks === "SUCCESS" ? "✓ checks" : "", pr.reviewDecision === "CHANGES_REQUESTED" ? "changes requested" : "", pr.mergeQueueEntry ? `queue ${pr.mergeQueueEntry.position}` : ""].filter(Boolean);
  return {
    title: `#${pr.number} ${pr.title}`,
    detail: marks.join(" · "),
    state: failing || pr.reviewDecision === "CHANGES_REQUESTED" ? "attention" : pr.state === "MERGED" ? "idle" : "active",
    url: pr.url,
    time: pr.mergedAt ? Date.parse(pr.mergedAt) : undefined,
    column: columnOf(pr),
  };
};

// Lays out search results as the board.
const boardFrom = (prs) => {
  const seen = new Set();
  const columns = COLUMNS.map((title) => ({ title, items: [] }));
  prs.filter((pr) => pr?.number && !seen.has(pr.url) && seen.add(pr.url)).map(itemOf).forEach((item) => columns.find((c) => c.title === item.column).items.push(item));
  columns.find((c) => c.title === "Merged").items.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  return columns;
};

const fetchBoard = (tabs, changed, log = () => {}) => {
  const repos = [...new Set(tabs.map((t) => repoOf(t.path)).filter(Boolean))].filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
  if (!repos.length) return Promise.resolve();
  const scope = repos.map((r) => `repo:${r}`).join(" ");
  const since = new Date(Date.now() - MERGED_DAYS * 86_400_000).toISOString().slice(0, 10);
  const query = `query($open: String!, $merged: String!) { open: search(query: $open, type: ISSUE, first: 50) { nodes { ${FIELDS} } } merged: search(query: $merged, type: ISSUE, first: 30) { nodes { ${FIELDS} } } }`;
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["api", "graphql", "-f", `query=${query}`, "-f", `open=is:pr is:open author:@me ${scope}`, "-f", `merged=is:pr is:merged author:@me merged:>=${since} ${scope}`],
      { encoding: "utf8", timeout: 30_000 },
      (err, stdout) => {
        board.loaded = true;
        if (err) {
          board.error = String(err.message).split("\n")[0];
          log(`PR board: ${board.error}`);
        } else {
          try {
            const data = JSON.parse(stdout).data;
            board.columns = boardFrom([...(data.open?.nodes ?? []), ...(data.merged?.nodes ?? [])]);
            board.error = undefined;
          } catch (parseErr) {
            board.error = parseErr.message;
          }
        }
        changed();
        resolve();
      },
    );
  });
};

// The view: the columns, and their items in column order for the cursor.
const boardView = () => ({
  title: "PRs",
  board: true,
  columns: board.columns,
  items: board.columns.flatMap((c) => c.items),
  loaded: board.loaded,
  error: board.error,
  builtIn: true,
});

module.exports = { BOARD_POLL_MS, COLUMNS, boardFrom, fetchBoard, boardView, board };
