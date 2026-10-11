# AGENTS.md — IOFabrik

Read `.github/copilot-instructions.md` first for architecture. This file is
the non-negotiable checklist for any autonomous/agentic change.

## Hard rules (never violate)
- Never use `go-git` or any Git library — all git/gh/lfs calls go through `CommandRunner` (`services/runner.go`), using paths from `cli_resolver.go` (`GitPath()`, `GhPath()`, `LfsPath()`).
- Never call `os/exec` directly outside `CommandRunner`.
- Never use `git rebase` anywhere in generated code or docs — merge-only workflow.
- Never surface raw Git/CLI output or error text to the user. Every error must be translated per `skills/user-facing-language/SKILL.md`.
- Never hand-edit files under `frontend/bindings/` — regenerate with `task common:generate:bindings` after any Go service signature change.
- Never add a new React Context — extend `RepoContext` or `LayoutContext`.
- Never reintroduce MUI or hardcoded pixel icon sizes — Radix + Tailwind + `ICON_SIZES` only.
- All backend mutation methods return `OperationResult{Success, Message, Error}`; queries return typed structs.

## Before finishing any task
1. Did I check `services/*.go` and `frontend/bindings/` for an existing method before writing a new one?
2. If I changed a Go service signature, did I run bindings regen?
3. If I added a user-facing string, is it free of Git jargon (see language table)?
4. If I touched CLI execution, does it go through `CommandRunner`?
5. Did I add/update tests (`services/*_test.go` table-driven, or Vitest for frontend)?