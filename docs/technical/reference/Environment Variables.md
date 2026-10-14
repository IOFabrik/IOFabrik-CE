# Environment Variables

> All configurable environment variables.

## Build-Time Variables (Vite)

Set in `.env` or CI environment:

| Variable | Purpose | Required |
|----------|---------|----------|
| `VITE_PUBLIC_POSTHOG_KEY` | PostHog analytics API key | Optional |
| `VITE_PUBLIC_POSTHOG_HOST` | PostHog API host URL | Optional |
| `VITE_SUPABASE_URL` | Supabase project URL | For account sign-in |
| `VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Supabase publishable key | For account sign-in |

## Runtime Variables (Go Backend)

| Variable | Purpose | Default |
|----------|---------|---------|
| `IOFABRIK_PORTABLE_GIT_URL` | Override MinGit download URL | GitHub releases URL |
| `IOFABRIK_PORTABLE_GH_URL` | Override gh CLI download URL | GitHub releases URL |
| `IOFABRIK_PORTABLE_LFS_URL` | Override git-lfs download URL | GitHub releases URL |

## Git Environment (Set by CommandRunner)

These are set by [CommandRunner](../infrastructure/CommandRunner.md) for every git command execution. They are **not user-configurable** — they enforce non-interactive mode:

| Variable | Value | Purpose |
|----------|-------|---------|
| `GIT_TERMINAL_PROMPT` | `0` | Prevent git from prompting for input |
| `GCM_INTERACTIVE` | `never` | Prevent Git Credential Manager prompts |
| `GIT_SSH_COMMAND` | `ssh -o BatchMode=yes` | Prevent SSH passphrase prompts |

## Windows-Only: Removed Variables

[CommandRunner](../infrastructure/CommandRunner.md) removes these to prevent conflicts with IDE credential helpers:

- `GIT_ASKPASS`
- `SSH_ASKPASS`
- `VSCODE_GIT_ASKPASS_MAIN`
- `VSCODE_GIT_ASKPASS_NODE`
- `VSCODE_GIT_ASKPASS_EXTRA_ARGS`
- `ELECTRON_RUN_AS_NODE`

---

**Related:** [CommandRunner](../infrastructure/CommandRunner.md) | [Build and Release](../guides/Build%20and%20Release.md)
