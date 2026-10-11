# Product Overview

> IOFabrik helps industrial automation teams manage project revisions and review changes.

IOFabrik is a desktop Git client for PLC engineers, HMI designers, and teams
working with configuration files. It presents common repository operations as
guided workflows with clear messages and recovery options.

## Capabilities

- Open, create, and clone project repositories.
- Save changes, synchronize work, inspect history, and manage branches.
- Review and resolve changes with text and specialized file viewers.
- View supported images, PDFs, 3D models, and L5X ladder logic.
- Use Git LFS for large files and connect repositories to GitHub.
- Configure application preferences and inspect diagnostic information.

## Design principles

- Explain actions in plain language, with concrete recovery steps when they fail.
- Confirm destructive actions and preserve recovery information.
- Keep local repository workflows available without requiring a cloud account.
- Reuse Git's existing storage and tooling for interoperability.

## Technical overview

The application uses a Go backend with Wails v3 and a React/TypeScript frontend.
Git operations run through CLI tools. Optional account integration uses Supabase;
session persistence uses the OS keychain. Analytics integration uses PostHog.

See [User-Facing Terminology](User-Facing%20Terminology.md) for interface wording and
[Architecture Overview](../technical/architecture/Architecture%20Overview.md) for the application architecture.
