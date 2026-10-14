# Isolated Integration - User Test Script

Manual acceptance script for the completed portions of the
[IntegrationSessionService](../backend/services/IntegrationSessionService.md).

This script covers Phases 0, 1, 2, 3, and the completed portions of Phase 4.
It does not cover Phase 5 cleanup, the uncompleted Windows run log, or the
unexercised project-switching checkpoint.

## Test Goal

Confirm that IOFabrik can check saved work against the shared project,
show real files that need a decision, and finish the work without interrupting
the user's open project or overwriting local files.

## Tester Notes

  the expected message is missing, even if the final files look correct.
  system, and test repository used.
  saved work and may change the test project's shared project after Finish.
  file changes, and Developer Mode enabled.
   checked against. "Your work" means the saved work on the feature project.

## Prerequisites

1. Build and launch the current IOFabrik application.
2. Open a disposable project with a local shared project and a separate
   feature project. The projects should have at least one text file that can be
   edited and saved.
3. Confirm the feature project has a visible destination in the project
   header. If no destination is available, use another fixture; readiness is
   intentionally silent when there is no local destination.
4. Open **Settings**, enable **Developer Mode**, and restart the app once.
5. Confirm the feature project opens normally and the feature status panel is
   visible.

## Automated Preflight

Run these checks before the manual workflow. They verify the completed Git and
backend foundations without changing a user's project.

```bash
go test ./services/... -run Integration -v
go test ./services/... -run 'Test(GetMergeState|IntegrationSession|IntegrationWorkspace)' -v
cd frontend && npm test -- --run \
  src/features/integration/context/IntegrationSessionContext.test.tsx \
  src/features/conflict/context/ConflictQueueContext.test.tsx \
  src/features/merge/components/MergeFinishModal.test.tsx
```

**Pass:** all selected tests pass.

**Fail:** any selected test fails, is skipped unexpectedly, or cannot run.
Record the first failing test and stop the manual run until the failure is
understood.

## Manual Test Cases

### IT-01 - Developer Mode Controls Readiness Checks

**Purpose:** Confirm the new workflow is isolated behind the Phase 4 feature
gate while the old behavior remains available when the gate is off.

**Steps:**

1. Open the feature project with Developer Mode enabled.
2. Edit a file and choose **Save Changes**.
3. Wait for the status panel to finish checking.
4. Open **Settings**, turn Developer Mode off, return to the project, edit the
   same file, and choose **Save Changes** again.

**Pass:** with Developer Mode enabled, the status panel shows **Checking your
work**, **Ready to finish**, or **Some files need a decision**. With Developer
Mode disabled, no isolated review appears and the existing save workflow still
works.

**Fail:** the app creates an isolated review while Developer Mode is disabled,
or enabling Developer Mode does not start the readiness workflow after a new
save.

### IT-02 - Conflict-Free Check Does Not Interrupt Work

**Purpose:** Confirm a clean readiness result changes neither project while
the user continues working.

**Steps:**

1. Enable Developer Mode again.
2. Make a change in a file that the shared project has not changed.
3. Choose **Save Changes** and keep the project open while the check runs.
4. Continue editing another file before the check finishes.
5. Open the feature status panel when the check is complete.

**Pass:** the panel says **Ready to finish**. The feature project remains on
the user's working project, the shared project is unchanged, and the second
file remains editable. No merge or conflict state appears in the open project.

**Fail:** the app blocks editing, switches projects, changes the shared
project before Finish, or shows an unmerged/conflict state in the open project.

### IT-03 - Real Conflicts Appear as a Non-Blocking Review

**Purpose:** Confirm the queue contains only conflicts found by the isolated
check and does not block ordinary work.

**Steps:**

1. In the shared project, change the same text file that the feature project
   changed, then choose **Save Changes** there.
2. Return to the feature project and choose **Save Changes**.
3. Keep the feature project open while the check runs.
4. Open the conflict review from the feature status panel.

**Pass:** the status panel says **Some files need a decision** and the review
lists the changed file. The feature project remains usable and does not show a
live merge operation. Files that only overlap by name but have no real content
conflict are not presented as decisions.

**Fail:** the open project becomes unmerged, the review blocks all other work,
or the queue lists predicted/non-conflicting files as decisions.

### IT-04 - Resolve a Text File Without Touching the Open Project

**Purpose:** Confirm the existing text resolver operates in the isolated
workspace and preserves the open project's files.

**Steps:**

1. Start from the **Some files need a decision** state in IT-03.
2. Record the feature project's current contents of the conflicted file.
3. Open **Conflict Review** and choose a valid resolution for the text file.
4. Confirm the file leaves the decision queue.
5. Close and reopen the review, if needed, and inspect the review result.

**Pass:** the chosen resolution is reflected in the review, the file no longer
needs a decision, and the open feature project still contains the contents
recorded in step 2. The review does not expose a temporary workspace path.

**Fail:** the open feature file changes before Finish, the wrong file is
resolved, an already-resolved file can still be submitted as unresolved, or a
temporary filesystem path is shown to the user.

### IT-05 - Cancel Review Deletes the Isolated Work

**Purpose:** Confirm cancellation is explicit, idempotent, and does not change
either project.

**Steps:**

1. Create a review with at least one pending decision.
2. Record the current contents of the open feature file and the shared file.
3. Choose **Cancel review**.
4. In the confirmation dialog, verify that it says the file choices will be
   deleted and neither project will change.
5. Choose **Cancel review** in the confirmation dialog.
6. Refresh the project and open the feature status panel again.

**Pass:** the review disappears, both projects retain their recorded contents,
and no stale review or decision queue returns. Repeating the cancellation
operation has no effect and produces no error.

**Fail:** cancellation changes a file or project revision, leaves the review
visible, restores old decisions, or reports an error when cancellation is
repeated.

### IT-06 - Finish a Conflict-Free Review

**Purpose:** Confirm Finish applies the prepared result rather than running a
new check and leaves the destination project consistent.

**Steps:**

1. Prepare a conflict-free review as in IT-02.
2. Open **Finish this work** from the feature status panel.
3. Review the source and destination names and the read-only file review.
4. Choose **Finish**.
5. Reopen or refresh the destination project and inspect the affected files.
6. Confirm the feature project remains the project the user was working in.

**Pass:** the shared project contains the prepared result, its files are
consistent after refresh, the review closes, and the user remains in the
feature project. The result is applied only after the explicit Finish action.

**Fail:** Finish runs without confirmation, applies a newly recomputed result
instead of the prepared one, leaves files partially updated, switches the user
to the destination project, or changes the destination before Finish.

### IT-07 - Refresh After New Saved Work

**Purpose:** Confirm an older review cannot be finished after the saved source
work changes.

**Steps:**

1. Prepare a review and leave it at **Ready to finish** or
   **Some files need a decision**.
2. Make another change in the feature project and choose **Save Changes**.
3. Wait for the next readiness check.
4. Open the review again.

**Pass:** the review uses the newest saved work, earlier choices are cleared,
   and the message says: "Your saved work changed, so this check was redone and
   earlier choices were cleared. Review the latest files before finishing."

**Fail:** the old decision queue remains active, Finish can apply the older
result, or the app silently combines the old and new reviews.

### IT-08 - Unsaved Local Work Blocks Finish Safely

**Purpose:** Confirm Finish refuses to overwrite local files and leaves the
prepared result recoverable.

**Steps:**

1. Prepare a review that reaches **Ready to finish**.
2. Modify an affected file in the open destination project without choosing
   **Save Changes**.
3. Return to the review and choose **Finish**.
4. Record the message, then close the message without discarding the local
   file.
5. Save or discard the local file using the user's deliberate choice, then
   choose **Finish** again.

**Pass:** the first Finish attempt says the project has unsaved files that
would be replaced and tells the user to save or discard them. The local file
and both project revisions remain unchanged. After the user clears the block,
the same prepared review can be finished successfully.

**Fail:** the local file is silently overwritten, the prepared result is
deleted, the destination changes despite the warning, or the user is forced to
discard work.

### IT-09 - Another Working Copy Blocks Finish

**Purpose:** Confirm the app refuses to update a destination that is open in a
different working copy.

**Steps:**

1. Prepare a conflict-free review while the destination is not open in the
   current project.
2. Open the destination in another linked working copy.
3. Choose **Finish** from the original feature project.
4. Close the other working copy and choose **Finish** again.

**Pass:** the first attempt reports **Almost ready** or an equivalent blocked
state and changes no project. After the other working copy is closed, the
prepared result can finish without re-running the review.

**Fail:** the app updates files belonging to the other working copy, silently
changes only the destination pointer, loses the prepared result, or finishes
while the destination is still owned elsewhere.

### IT-10 - Restart Recovers an Active Review

**Purpose:** Confirm a pending review survives an application restart.

**Steps:**

1. Prepare a review with at least one pending decision, or leave a review at
   **Ready to finish**.
2. Quit IOFabrik normally before finishing.
3. Relaunch IOFabrik and reopen the same feature project.
4. Open the review and inspect its state.

**Pass:** the review returns with the correct source and destination, pending
   decisions remain available when applicable, and the app reports that it
   found an unfinished check if recovery was required. No project revision or
   local file changes occur during restart.

**Fail:** the review disappears without explanation, old decisions are applied
to a different saved revision, the open project changes during startup, or a
temporary workspace is exposed to the user.

### IT-11 - Repeated Saves Produce One Current Review

**Purpose:** Confirm readiness checks are debounced and an older review is
replaced cleanly by the newest saved work.

**Steps:**

1. Make and save a feature change.
2. Before the check finishes, make and save two more small changes.
3. Wait until the status panel settles.
4. Open the review and compare it with the latest saved file contents.

**Pass:** only the newest review is actionable, its contents match the latest
saved work, and no duplicate review or stale decision queue is shown.

**Fail:** several reviews compete for Finish, the review reflects an older
save, or an earlier background result replaces the newest one.

### IT-12 - Finish With No Pending Decisions

**Purpose:** Confirm the app refuses to finish while real conflicts remain.

**Steps:**

1. Prepare a conflicting review and leave at least one file in
   **Files Needing a Decision**.
2. Open **Finish this work**.
3. Inspect the Finish button and attempt to choose it.

**Pass:** Finish is unavailable or rejected with a clear request to resolve
the listed files first. Neither project changes.

**Fail:** Finish applies a result containing unresolved files or changes either
project while decisions remain.

## Run Record

| Test ID | Result | Date | App version | OS | Notes / failure evidence |
| --- | --- | --- | --- | --- | --- |
| IT-01 | _Pass / Fail_ | | | | |
| IT-02 | _Pass / Fail_ | | | | |
| IT-03 | _Pass / Fail_ | | | | |
| IT-04 | _Pass / Fail_ | | | | |
| IT-05 | _Pass / Fail_ | | | | |
| IT-06 | _Pass / Fail_ | | | | |
| IT-07 | _Pass / Fail_ | | | | |
| IT-08 | _Pass / Fail_ | | | | |
| IT-09 | _Pass / Fail_ | | | | |
| IT-10 | _Pass / Fail_ | | | | |
| IT-11 | _Pass / Fail_ | | | | |
| IT-12 | _Pass / Fail_ | | | | |

## Completion Rule

The completed-phase acceptance run passes only when the automated preflight and
all applicable manual tests pass. Mark IT-09 as **Not run** only when a linked
working-copy fixture is unavailable, and explain why in the run record. A
failure in IT-02, IT-03, IT-05, IT-06, IT-07, IT-08, or IT-10 is release-blocking
because it violates the core promise that the open project remains safe and
usable until the user chooses Finish.
