# Code Style

- When looping, prefer collection methods over for loops (e.g., `.forEach`, `.map`, `.filter` in JavaScript)
- When implementing logic that isn't unique to the project, prefer existing libraries (e.g., use papaparse for CSV parsing instead of writing a custom parser)
- In JSX, use dedicated components with descriptive names instead of comments to clarify sections
- Don't use optional properties in types unless actually necessary for the implementation
- Prefer type aliases over interfaces
- Prefer inlining over abstractions, but extract when the logic is complex enough
- Prefer `async/await` over `.then`
- In Node apps, always use `pnpm` or `npm` (whichever is configured for the current app) instead of `npx`

# Next.js

- Prefer server components over client components
- Don't implement API routes unless explicitly requested
- Put server actions in dedicated files in a `_actions` directory colocated with the relevant route
- Suggest adding Playwright and Jest if they aren't already in a project

# Testing

- When writing unit tests or end-to-end tests, always prefer writing to an actual database using the best practices for the current language
- Drop and recreate the database for each test in the most efficient way possible
- Always configure tests to use a dedicated TEST database to avoid destroying local data
- Ask before running end-to-end tests
- Prefer factories over direct insertion for test data setup

# Git

- Never include a Co-Authored-By line in commit messages

# General

- When reading files, always read from disk, not from IDE memory (e.g., in VS Code, use the Read tool to read the file on disk rather than relying on what the IDE provides)
- Challenge my requests if you think there's a better implementation — suggest the alternative and explain why
- When working within a project, update the local CLAUDE.md with project requirements as they evolve. If there isn't one, create it. Update the README in the same way and keep both files in sync.
