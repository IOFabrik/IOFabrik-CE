---
name: user-facing-language
description: Use when writing or editing any user-facing string — button labels, toasts, modals, error messages. IOFabrik users are non-technical PLC/HMI engineers who don't know Git.
---

# User-facing language rules

Never expose Git jargon (commit, branch, staging, HEAD, SHA, rebase) to the user.

| Git term | User-facing term |
|---|---|
| commit | Save Changes |
| pull + push | Sync |
| push | Share / Push |
| checkout | Switch |
| reset --soft HEAD~1 | Rewind |
| restore | Discard |
| stash | (hidden, automatic) |
| staging/index | (hidden, always `git add .`) |
| rebase | forbidden — never surfaced or used |

Error format is always two lines:
1. What happened, plain English
2. What to do next, a concrete recovery action

Bad: `fatal: refusing to merge unrelated histories`
Good: `These projects don't share a common history. Try creating a new project and moving your files over.`

Toasts (`sonner`) under 80 characters. Destructive actions (discard, rewind, delete branch, abort merge) always confirm via `AlertDialog` with consequences stated.