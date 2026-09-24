# Phantom — coordination policy

This workspace is a neutral coordination surface. OpenCode, Claude Code and Hermes are equal participants.

The product-facing name is **Phantom**. `Codeg` remains an internal implementation/runtime name where compatibility requires it (API paths, storage keys, MCP identifiers, and service names).

- Any enabled agent may be the lead for a task.
- Use an explicit `@AgentName` mention when asking for delegation.
- A worker starts with a self-contained task; include paths, constraints and the exact deliverable.
- Never imply that a worker automatically knows the lead's full context.
- Use a handoff or a session reference when another agent needs prior history.
- Do not edit the same files concurrently. Use a separate worktree for parallel changes.
- The user remains the approval authority for file edits, shell commands and external actions.
- Report the agent, model, session and result for every delegated task.
- The active model's iconic color is presentation state; it must not imply different permissions, authority, or capability between agents.
- Keep source-code comments in concise technical English. Keep project documentation and operator-facing notes in Spanish. Translation catalogs under `codeg/src/i18n/messages/` are data, not comments; preserve every locale unless a translation task explicitly changes it.
