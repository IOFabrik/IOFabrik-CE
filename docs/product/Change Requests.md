# Change Requests

> A Change Request is how you ask your team to review the work on your task before it becomes part of the main project.

IOFabrik calls GitHub pull requests **Change Requests**. You do not need to know any Git or GitHub terminology to use them. This guide is written for the people doing the work — machine builders, controls engineers, and integrators — not for developers.

## What a Change Request does

When you finish a task on your own line of work, a Change Request lets a teammate look at exactly what changed and approve it before it is merged into the main project. Nothing is changed in the main project until the review is complete.

## Before you can create one

Change Requests only work when your project is **connected to GitHub**.

- Your project must be connected directly to its own GitHub project (the primary connection).
- You must be signed in with **Connect to GitHub**.
- Projects that are not on GitHub, or that were copied from someone else's GitHub project (a fork), cannot use Change Requests in this release.

If any of these is missing, the **Create Change Request** button is shown but disabled, and hovering over it explains what to fix.

## When you can create one

IOFabrik only offers **Create Change Request** when the work is genuinely ready:

- You are on your own task, not the main project line.
- Everything is saved — there are no unsaved changes.
- Your task is fully synced to GitHub — nothing is waiting to be shared.

If your work is not synced yet, IOFabrik shows **Sync** as the next step instead. It never shares your work silently when you create a Change Request.

## How to create one

You can start a Change Request from two places:

1. The **next-step panel** on the left of the Explorer, when your task is ready.
2. The **Reviews** view.

Either way, a short form opens with four fields:

| Field | What it means |
|-------|---------------|
| **Title** | A short name for the change, for example "Update mixer sequence". Required. |
| **Description** | Optional notes explaining what you changed and why. |
| **From branch** | The task you are submitting. This is fixed to your current task and cannot be changed. |
| **Into branch** | Where the change should go. Defaults to the project's main line, and you can pick another branch from the list. |

Choose **Create Request** to submit, or **Cancel** to close without submitting.

## After you submit

- IOFabrik confirms the request was created and takes you to the **Reviews** view with your new request selected.
- If an open Change Request already exists for your task, IOFabrik opens that existing request instead of creating a duplicate.
- You can inspect every changed file — including ladder logic, images, PDFs, and 3D models — using the same viewers you already use.

## What IOFabrik does not decide

Approvals, required reviewers, and protected-branch rules are controlled by **GitHub**, not by IOFabrik. IOFabrik shows you the current review status, but it cannot override your team's GitHub permissions or protection settings.

---

**Related:** [User-Facing Terminology](User-Facing%20Terminology.md) · [Product Overview](Product%20Overview.md)
