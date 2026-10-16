# LDSDK helper protocol

> The manual-conversion helper's versioned request, progress, result and artifact contract.

`internal/ldsdkprotocol` defines protocol version 1 for the Windows x64 conversion helper. The compatible helper version is `0.1.0`, vendor revision is `923a9675a53637515c8a5088ff7eed41a9b3eb82`, and exploded format version is `2`.

The helper implementation is maintained privately. The app's Generate preview action invokes it on Windows x64, validates its result, and publishes a sibling `<stem>.preview` folder. Installer redistribution remains a separate release prerequisite.

## Invocation and storage

The app resolves the pinned, checksum-verified managed helper (or the complete `helper` directory beside the executable) and launches it through `CommandRunner`:

```text
LDSDK.Helper.exe --request <absolute request.json path>
```

Each invocation has one request and one final result. Before invocation, create a fresh operation directory at `%LOCALAPPDATA%\IOFabrik\LDSDK\operations\<operationId>`. Use a UUID in canonical `D` format, and write UTF-8 JSON without a byte-order mark to `request.json` there. The helper rejects reused artifact directories, relative paths, symlinks and Windows junctions.

The helper writes only in private operation storage and its per-user coordination directory. The app must independently establish that the selected input and destination are physically inside the open repository before invocation. Neither this contract nor a successful helper result authorizes publishing files.

## Request

```json
{
  "protocolVersion": 1,
  "operationId": "561feb87-cc9f-4615-aa3d-6e0743521078",
  "operation": "exportExplode",
  "sourceAcdPath": "C:\\Projects\\Example\\Controller.ACD",
  "workDirectory": "C:\\Users\\engineer\\AppData\\Local\\IOFabrik\\LDSDK\\operations\\561feb87-cc9f-4615-aa3d-6e0743521078"
}
```

The helper makes one ordinary copy to `input.ACD`, exports that copy to `export.L5X`, and directly calls the pinned vendor exploder with its default configuration and persistence service. It never rereads the original source after copying, stages files, creates commits, or publishes a preview folder.

## Progress and final result

Stdout contains newline-delimited JSON progress records with `protocolVersion`, `operationId` and `stage`. Helper stages are `copy`, `export` and `explode`. They carry no percentage. Publication is owned by the app. SDK messages and exceptions go to `diagnostics.log` in private operation storage, separately from stdout.

On success, the helper flushes `result.json.tmp` and renames it to `result.json`:

```json
{
  "protocolVersion": 1,
  "operationId": "561feb87-cc9f-4615-aa3d-6e0743521078",
  "success": true,
  "outputRoot": "C:\\Users\\engineer\\AppData\\Local\\IOFabrik\\LDSDK\\operations\\561feb87-cc9f-4615-aa3d-6e0743521078\\output",
  "formatVersion": 2,
  "helperVersion": "0.1.0",
  "vendorRevision": "923a9675a53637515c8a5088ff7eed41a9b3eb82",
  "failureCode": null,
  "diagnosticReference": null,
  "sdkCleanupConfirmed": true
}
```

`outputRoot` must equal `<workDirectory>\output` and contain only the `RSLogix5000Content` vendor subtree, its root XML document, vendor options and generated components. The options must select schema 2, XML, no pretty attributes, omitted export date and no dependency-check bypass. Temporary ACD and complete L5X files are removed after settled SDK work; they are never output artifacts.

`ValidateResult` checks the bounded JSON result, process outcome, compatible identities, artifact location, physical file tree, root document and selected options. A zero process exit without a valid result and complete artifacts is insufficient. Successful validation must still be followed by app checks for repository identity, compatible destination ownership, effective Git attributes and complete-output publication.

## Failure and interruption

Exit code `0` means success, `1` means a structured operation failure, and `2` means invocation or envelope rejection before a trusted result location was available. A failure result has `success: false`, a nonempty `failureCode`, no output root or format version, and usually `diagnosticReference: "diagnostics.log"`. Paths and raw diagnostics must not be displayed as user-facing error copy.

| Code | Meaning |
| --- | --- |
| `busy` | Another helper holds the per-user operation guard; this request takes no copy and is not queued. |
| `sdkCleanupRequired` | An earlier interrupted SDK operation has not been reconciled; no new SDK work starts. |
| `platformUnavailable` | Conversion requires Windows x64. |
| `invalidRequest`, `invalidWorkDirectory`, `invalidSource`, `unsafePath` | Validation refused the request. |
| `validateFailed`, `copyFailed`, `exportFailed`, `explodeFailed` | The named stage failed; consult private diagnostics. |
| `invalidExport`, `invalidOutput` | The completed artifacts did not satisfy the pinned contract. |

A per-user share-denying file handle permits only one helper at a time. Immediately before SDK entry, the helper flushes an interruption record outside repository content. It clears that record only after SDK project disposal returns. Open/disposal failures and forced termination retain the record and any potentially active private inputs. Process exit or a running SDK service does not establish cleanup.

The helper provides no reset command. The app records the native Windows kernel startup event before invocation; uncertain SDK state refuses further work until a different startup is established. The environment GUID alone can survive a restart and is insufficient. Legacy records acquire the new evidence conservatively and require a subsequent restart. The app never kills Rockwell processes or infers cleanup from process exit. Normal exit waits for generation. The SDK operation has a five-minute timeout, preserving uncertain state without changing the runner's ordinary timeout.

Coordination storage and the SDK child process use the Windows user's native app-data profile, matching the helper and its authentication adapter even when a launcher redirects UI settings through environment variables.

## App publication and coordination

Generation accepts physically repository-local regular ACD files with a single-dot basename, including untracked and ignored files. It does not stage, save, change ignore rules, or configure LFS. The app validates repository, index and destination identities again before publication, without rereading the source after the helper's copy.

A per-user operation lock refuses overlapping requests. A shared repository lease spans ordinary app mutations; preview generation holds the exclusive lease through conversion and publication. Read-only status queries remain available. Recovery journals outside the working tree block mutations until reconciliation succeeds.

Publication prepares a complete replacement beside the destination inside the writable project, preserves unrelated siblings in a compatible wrapper, and uses directory renames with journaled rollback. The journal is created before copying files into staging and retained until staging is removed, so interrupted staging cannot enter an ordinary save. Recovery also supports journals from builds that staged beside the project. An incompatible destination is refused. The wrapper receives the Windows Hidden attribute; it remains browsable with Show hidden files. Scoped `.gitattributes` preserve generated bytes and enable text comparisons; effective rules, including local overrides, are checked before and after publication.

A persistent, nonmodal notification at the bottom right displays copy, export, generation and publication stages without invented percentages. It identifies the selected file and project, stays visible through the final status refresh, and does not move focus or open a viewer. Success dismisses after five seconds; failures retain recovery guidance until dismissed. File browsing, history and existing previews remain available. Save, Sync, branch and project switching, snapshot restoration, file deletion, LFS lock changes, project settings and additional generation remain disabled until the operation and refresh settle. The current operation's temporary publication folder is omitted from the file browser and changes list; other files and failure-recovery remnants remain visible. The backend mutation guards remain authoritative. There is no cancellation control for SDK work.

## Runtime and packaging boundary

The development helper targets .NET 10 and pins `RockwellAutomation.LogixDesigner.CSClient` to `2.1.974`. Its published dependency directory includes the client package's `FtspAdapter.exe`, managed dependencies and the vendor MIT notice. A framework-dependent build requires a compatible installed .NET runtime.

These pins identify the tested development combination; they do not establish that all SDK or Studio versions are supported. SDK-client redistribution permissions and the complete installer payload remain release prerequisites. No helper payload is added to the app installer by this contract.

## Opt-in Windows integration check

`TestPreviewWindowsSDKIntegration` exercises the real SDK through the app service. Set `LDSDK_TEST_SOURCE` to an approved offline ACD fixture and `LDSDK_TEST_HELPER_DIR` to the complete pinned helper directory, then run `go test ./services -run '^TestPreviewWindowsSDKIntegration$' -v -timeout 10m` on Windows. The test copies the fixture into a disposable repository and verifies generation, regeneration, source/index byte preservation, unrelated preview content and the Hidden attribute. It uses native per-user SDK coordination, refuses existing recovery records and never clears them to force a test run. Without both environment variables, the test skips.

**Related:** [CommandRunner](CommandRunner.md), [CLI Resolver](CLI%20Resolver.md), [Testing Guide](../guides/Testing%20Guide.md)
