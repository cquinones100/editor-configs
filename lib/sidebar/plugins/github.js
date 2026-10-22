// A tmux-sidebar plugin (see ../plugins.js): your open pull requests and the
// ones waiting on your review, through the gh CLI and its login.
//
// Needs your attention: a review requested of you, or a PR of yours whose
// checks failed or that has changes requested. Active: yours, otherwise.
// Drafts are idle.
//
// Options: { "query": "<extra search terms>" }, added to both searches, such
// as "org:my-company".

const FIELDS = `
  ... on PullRequest {
    number title url isDraft updatedAt reviewDecision
    repository { nameWithOwner }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  }`;

const QUERY = `query($mine: String!, $review: String!) {
  mine: search(query: $mine, type: ISSUE, first: 30) { nodes { ${FIELDS} } }
  review: search(query: $review, type: ISSUE, first: 30) { nodes { ${FIELDS} } }
}`;

const item = (pr, reviewing) => {
  const checks = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  const failing = checks === "FAILURE" || checks === "ERROR";
  const changes = pr.reviewDecision === "CHANGES_REQUESTED";
  const why = reviewing ? "review requested" : failing ? "checks failing" : changes ? "changes requested" : pr.reviewDecision === "APPROVED" ? "approved" : checks === "PENDING" ? "checks running" : "open";
  return {
    id: pr.url,
    title: `#${pr.number} ${pr.title}`,
    detail: `${pr.repository.nameWithOwner} · ${why}`,
    state: reviewing || failing || changes ? "attention" : pr.isDraft ? "idle" : "active",
    url: pr.url,
    time: Date.parse(pr.updatedAt),
  };
};

const RANK = { attention: 0, active: 1, idle: 2 };

module.exports = {
  title: "Pull requests",
  intervalSeconds: 300,
  sidebar: 3,
  async fetch({ options, run }) {
    const extra = options.query ? ` ${options.query}` : "";
    const out = await run("gh", [
      "api", "graphql",
      "-f", `query=${QUERY}`,
      "-f", `mine=is:pr is:open archived:false author:@me${extra}`,
      "-f", `review=is:pr is:open archived:false review-requested:@me${extra}`,
    ]);
    const { data } = JSON.parse(out);
    const reviewing = data.review.nodes.filter((pr) => pr.url).map((pr) => item(pr, true));
    const mine = data.mine.nodes.filter((pr) => pr.url).map((pr) => item(pr, false));
    return [...reviewing, ...mine].sort((a, b) => RANK[a.state] - RANK[b.state] || b.time - a.time);
  },
};
