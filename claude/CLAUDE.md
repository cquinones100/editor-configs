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
- Follow Next.js routing best practices: favor dynamic route segments (`/campaigns/[slug]`) over query parameters (`/campaigns?slug=...`) for resource identification. Reserve query params for optional filters, sorting, and pagination.

# Testing

- When writing unit tests or end-to-end tests, always prefer writing to an actual database using the best practices for the current language
- Drop and recreate the database for each test in the most efficient way possible
- Always configure tests to use a dedicated TEST database to avoid destroying local data
- Ask before running end-to-end tests
- Prefer factories over direct insertion for test data setup

# Git

## Commits
- Never include a Co-Authored-By line in commit messages
- Keep the description clear and simple. Focus on the intent of the commit. Always consider the diff between the current branch and main or master. Don't use emojis, don't use bullet points.
- Never attribute any git artifact (commits, PRs, branches, etc.) to Claude or AI. No "Generated with Claude Code" or similar lines.

## Branch Awareness

Before responding to any request, always check the current branch's recent changes:

1. Run `git log --oneline -10` to see recent commits on the current branch
2. Run `git diff HEAD~3 --stat` to see a summary of recent file changes
3. Include relevant context from these changes in your understanding of the codebase state

## Pushing
- Always ask for confirmation before running `git push`. Never push without explicit approval.

## Pull Request Descriptions
- Keep the description clear and simple. Focus on the intent of the commit. Always consider the diff between the current branch and main or master. Don't use emojis, don't use bullet points. Only dig into technical implementation when there is some divergence from what is normal in the given repo.
- Never include a "Test plan" section. No checklists.


# General

- When moving into a worktree, always install dependencies before doing anything else
- When creating a worktree in a git repo, add `.claude/worktrees/` to `.gitignore` if it isn't already there
- When reading files, always read from disk, not from IDE memory (e.g., in VS Code, use the Read tool to read the file on disk rather than relying on what the IDE provides)
- Challenge my requests if you think there's a better implementation — suggest the alternative and explain why
- When working within a project, update the local CLAUDE.md with project requirements as they evolve. If there isn't one, create it. Update the README in the same way and keep both files in sync.
