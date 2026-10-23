# Code Style

- When looping, prefer collection methods over for loops (e.g., `.forEach`, `.map`, `.filter` in JavaScript)
- When implementing logic that isn't unique to the project, prefer existing libraries (e.g., use papaparse for CSV parsing instead of writing a custom parser)
- In JSX, use dedicated components with descriptive names instead of comments to clarify sections
- Don't use optional properties in types unless actually necessary for the implementation
- Prefer type aliases over interfaces
- Prefer inlining over abstractions, but extract when the logic is complex enough
- Prefer `async/await` over `.then`
- In Node apps, always use `pnpm` or `npm` (whichever is configured for the current app) instead of `npx`
- For one-off scripts, prefer Node over Python

# Next.js

- Prefer server components over client components
- Don't implement API routes unless explicitly requested
- Put server actions in dedicated files in a `_actions` directory colocated with the relevant route
- Suggest adding Playwright and Jest if they aren't already in a project
- Follow Next.js routing best practices: favor dynamic route segments (`/products/[slug]`) over query parameters (`/products?slug=...`) for resource identification. Reserve query params for optional filters, sorting, and pagination.

# Testing

- When writing unit tests or end-to-end tests, always prefer writing to an actual database using the best practices for the current language
- Drop and recreate the database for each test in the most efficient way possible
- Always configure tests to use a dedicated TEST database to avoid destroying local data
- Ask before running end-to-end tests
- Prefer factories over direct insertion for test data setup
- Don't extract helper functions in tests. Keep test logic inline so each test is self-contained and readable. Use factories for data setup.

# Git

## Commits
- Keep the description clear and simple. Focus on the intent of the commit. Always consider the diff between the current branch and main or master. Don't use emojis, don't use bullet points.

## Branch Awareness

Before responding to any request, always check the current branch's recent changes:

1. Run `git log --oneline -10` to see recent commits on the current branch
2. Run `git diff HEAD~3 --stat` to see a summary of recent file changes
3. Include relevant context from these changes in your understanding of the codebase state

## Pushing
- On a branch with an open PR, push new commits as soon as they're committed, without asking. CI is the check, so the PR must stay up to date.
- Ask before force-pushing, and before a branch's first push unless the request already asks for it.

## Pull Request Descriptions
- Write them as "PRs and Linear tickets" below says. Always consider the diff between the current branch and main or master. Don't use emojis, don't use bullet points.
- Never include a "Test plan" section. No checklists.

# PRs and Linear tickets

1. Lead with the business logic: what the unit of work does and why, for a teammate reading it months later. Answer the questions they would ask about how the feature works. The reasons for implementation choices go here.
2. A pipeline or multi-step flow gets a diagram in the platform's native format: Mermaid in GitHub PRs, SVG where the platform renders it.
3. Implementation details last, in as few words as possible. Link to the code on GitHub instead of describing it. In a Linear ticket, the implementation is always the final section, after acceptance criteria and what is out of scope, however the ticket is written (by `/shape`, a review loop's edits, or by hand) and whatever layout the team's other tickets use.
4. Link every other PR or Linear ticket you mention: a PR as a link to it on GitHub, a ticket as a link to it in Linear, never a bare `#123` or `ABC-123` that a reader has to look up.

Write a ticket so no sentence can be mistaken for how things work today:

- Describe current behavior only under a "Today" heading or with "Today," / "Currently,".
- Write every change the work makes as an instruction, starting with a verb: "Make Specific pass a concrete kind of facility without a named site", not "Specific passes…" or "Specific now passes…". Write what stays the same as an instruction too: "Keep the no-slur rule".
- Write acceptance criteria as checks on the finished work: "A run against a fresh seed leaves the three new fixtures eligible at Strict".

Write a PR description the same way: behavior from before the PR only under a "Before" heading or after "Before this PR,", and each change as an instruction, as a commit subject is ("Make Specific pass…", not "Specific passes…" or "Specific now passes…").

A review loop's reviewer (Codex) never sees these rules. When a review loop covers a ticket or a PR description, check it against them yourself before calling a round clean, and keep its fixes within them rather than adding words.

# Communication

- Use as few words as possible. Lead with the answer; no preamble or recap.
- Write American English everywhere, including code, comments, commits, PRs and tickets: "color", "recognizes", "behavior", "canceled".
- Don't describe edits to code, documents, PRs, tickets or artifacts ("I edited…", "I changed…"): the artifact shows them. Report only what it can't, such as test results, decisions you need from me, and links.


# General

- In mono repos, use `git -C <path>` instead of `cd`-ing into the project root
- When moving into a worktree, always install dependencies before doing anything else
- When creating a worktree in a git repo, add `.claude/worktrees/` to `.gitignore` if it isn't already there
- When reading files, always read from disk, not from IDE memory (e.g., in VS Code, use the Read tool to read the file on disk rather than relying on what the IDE provides)
- Challenge my requests if you think there's a better implementation — suggest the alternative and explain why
- When working within a project, update the local CLAUDE.md with project requirements as they evolve. If there isn't one, create it. Update the README in the same way and keep both files in sync.
- "Notes" or "my note" means my terminal notes app (the Notes window in tmux, nvim with `editor-configs/notes`), never macOS Notes. Notes are Markdown files in `~/Notes/`, named after their title (e.g. `~/Notes/Weekend Plans.md`); strike through with `~~text~~`. A note's first line is its title, `# Title`. Checklists are `- [ ]` and `- [x]`; ticking an item moves it under the unticked ones in its list, with what is indented under it, as the app does, so a list leads with what is left. Folders are subfolders of `~/Notes`; `.trash/` holds deleted notes, so leave it out of searches. Edit the file directly: the open app takes in changes without saving over them.

# Slack

- NEVER offer to reply to a Slack thread. Reading Slack is fine; drafting, sending, or proposing a reply is not, unless I explicitly ask for one.
