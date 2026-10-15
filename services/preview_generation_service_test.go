package services

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"iofabrik/internal/ldsdkprotocol"
)

func previewTestService(t *testing.T) (*PreviewGenerationService, string, string) {
	t.Helper()
	data := t.TempDir()
	previousStateDirectory := previewStateDirectory
	previewStateDirectory = func() string { return filepath.Join(data, "IOFabrik", "LDSDK") }
	t.Cleanup(func() { previewStateDirectory = previousStateDirectory })
	t.Setenv("XDG_CACHE_HOME", data)
	if os.PathSeparator == '\\' {
		t.Setenv("LOCALAPPDATA", data)
	}
	root := createTestRepo(t)
	t.Cleanup(func() { cleanupTestRepo(t, root) })
	source := filepath.Join(root, "Controller.ACD")
	if err := os.WriteFile(source, []byte("original ACD bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	s := NewPreviewGenerationService()
	s.platformReady = func() error { return nil }
	s.resolveHelper = func() (string, error) { return "test-helper", nil }
	s.bootID = func() (string, error) { return "boot-one", nil }
	s.runHelper = previewFakeHelper(t, nil)
	return s, root, source
}

func writePreviewFixture(t *testing.T, output, content string) {
	t.Helper()
	dir := filepath.Join(output, "RSLogix5000Content")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{
		"RSLogix5000Content.xml": "\xef\xbb\xbf<?xml version=\"1.0\" encoding=\"utf-8\"?><RSLogix5000Content><Controller Name=\"Test\"/></RSLogix5000Content>",
		"export-options.yaml":    "schema_version: 2\nserialization_format: Xml\nxml_attribute_per_line: false\nomit_export_date: true\nunsafe_skip_dependency_check: false\n",
		"Routine.xml":            content,
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func previewFakeHelper(t *testing.T, before func(ldsdkprotocol.Request)) func(context.Context, string, io.Writer, io.Writer, string, ...string) CommandResult {
	t.Helper()
	return func(_ context.Context, work string, stdout, _ io.Writer, _ string, args ...string) CommandResult {
		data, err := os.ReadFile(args[1])
		if err != nil {
			t.Error(err)
			return CommandResult{}
		}
		var request ldsdkprotocol.Request
		if err := json.Unmarshal(data, &request); err != nil {
			t.Error(err)
			return CommandResult{}
		}
		if before != nil {
			before(request)
		}
		for _, stage := range []string{"copy", "export", "explode"} {
			line, _ := json.Marshal(ldsdkprotocol.Progress{ProtocolVersion: 1, OperationID: request.OperationID, Stage: stage})
			_, _ = stdout.Write(append(line, '\n'))
		}
		output := filepath.Join(work, "output")
		writePreviewFixture(t, output, "vendor\r\nbytes\n$Id$\r\n")
		result := ldsdkprotocol.Result{ProtocolVersion: 1, OperationID: request.OperationID, Success: true, OutputRoot: output,
			FormatVersion: 2, HelperVersion: ldsdkprotocol.HelperVersion, VendorRevision: ldsdkprotocol.VendorRevision, SDKCleanupConfirmed: true}
		if err := previewWriteJSON(filepath.Join(work, "result.json"), result); err != nil {
			t.Error(err)
			return CommandResult{}
		}
		return CommandResult{Success: true}
	}
}

func generateTestPreview(t *testing.T, s *PreviewGenerationService, root, source string) OperationResult {
	t.Helper()
	return s.GeneratePreview(root, source, newPreviewOperationID())
}

func requirePreviewSuccess(t *testing.T, result OperationResult) {
	t.Helper()
	if !result.Success {
		t.Fatalf("generation failed: %+v", result)
	}
}

func TestPreviewGenerationPreservesSourceAndUnrelatedStaging(t *testing.T) {
	s, root, source := previewTestService(t)
	if err := os.WriteFile(filepath.Join(root, "unrelated.txt"), []byte("staged"), 0600); err != nil {
		t.Fatal(err)
	}
	runGitCmd(t, root, "add", "unrelated.txt")
	index, _ := gitAdminPath(s.runner, root, "index")
	before, _ := previewHashFile(index)
	stages := []string{}
	s.onProgress = func(p ProgressUpdate) {
		stages = append(stages, p.Phase)
		if p.Percent != -1 {
			t.Error("invented a percentage")
		}
	}
	requirePreviewSuccess(t, generateTestPreview(t, s, root, source))
	after, _ := previewHashFile(index)
	if before != after {
		t.Fatal("generation changed unrelated staging")
	}
	data, _ := os.ReadFile(source)
	if string(data) != "original ACD bytes" {
		t.Fatal("source was changed")
	}
	if strings.Join(stages, ",") != "starting,copy,export,explode,publish" {
		t.Fatalf("unexpected stages %v", stages)
	}
	if _, err := os.Stat(filepath.Join(root, "Controller.preview", "RSLogix5000Content", "Routine.xml")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(s.stateDir, "app-inflight.json")); !os.IsNotExist(err) {
		t.Fatal("settled SDK state was retained")
	}
	entries, _ := os.ReadDir(filepath.Join(s.stateDir, "operations"))
	if len(entries) != 0 {
		t.Fatal("successful private work was retained")
	}
}

func TestPreviewEligibilityAndContainment(t *testing.T) {
	s, root, _ := previewTestService(t)
	for _, name := range []string{"Controller.ACD", "Controller.acd", "Controller.AcD", "Controller.BAK042.ACD", "Controller.something.acd", "Controller.acd.something", "Controller.txt", "Controller", ".ACD"} {
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(root, "Line.1")
			_ = os.MkdirAll(dir, 0700)
			path := filepath.Join(dir, name)
			_ = os.WriteFile(path, []byte("source"), 0600)
			result := generateTestPreview(t, s, root, path)
			if result.Success != eligiblePreviewName(name) {
				t.Fatalf("wrong eligibility %+v", result)
			}
		})
	}
	outside := filepath.Join(t.TempDir(), "Outside.ACD")
	_ = os.WriteFile(outside, []byte("private"), 0600)
	if generateTestPreview(t, s, root, outside).Success {
		t.Fatal("accepted external source")
	}
	if generateTestPreview(t, s, root, filepath.Join(root, ".git", "Data.ACD")).Success {
		t.Fatal("accepted administrative source")
	}
	dir := filepath.Join(root, "Directory.ACD")
	_ = os.Mkdir(dir, 0700)
	if generateTestPreview(t, s, root, dir).Success {
		t.Fatal("accepted directory")
	}
	link := filepath.Join(root, "Link.ACD")
	if os.Symlink(outside, link) == nil && generateTestPreview(t, s, root, link).Success {
		t.Fatal("accepted linked source")
	}
}

func TestPreviewRegenerationPreservesSiblingsAndDeletesOldGeneratedFiles(t *testing.T) {
	s, root, source := previewTestService(t)
	requirePreviewSuccess(t, generateTestPreview(t, s, root, source))
	dest := filepath.Join(root, "Controller.preview")
	_ = os.WriteFile(filepath.Join(dest, "notes.txt"), []byte("unrelated sibling"), 0600)
	_ = os.WriteFile(filepath.Join(dest, "RSLogix5000Content", "deleted.xml"), []byte("old generated"), 0600)
	requirePreviewSuccess(t, generateTestPreview(t, s, root, source))
	if _, err := os.Stat(filepath.Join(dest, "RSLogix5000Content", "deleted.xml")); !os.IsNotExist(err) {
		t.Fatal("obsolete generated file survived")
	}
	notes, _ := os.ReadFile(filepath.Join(dest, "notes.txt"))
	if string(notes) != "unrelated sibling" {
		t.Fatal("unrelated sibling changed")
	}
}

func TestPreviewRefusesUnrelatedOrCustomDestinations(t *testing.T) {
	for _, kind := range []string{"unrelated", "custom-options", "custom-attributes", "junction"} {
		t.Run(kind, func(t *testing.T) {
			s, root, source := previewTestService(t)
			dest := filepath.Join(root, "Controller.preview")
			if kind == "unrelated" {
				_ = os.Mkdir(dest, 0700)
				_ = os.WriteFile(filepath.Join(dest, "keep.txt"), []byte("keep"), 0600)
			} else if kind == "junction" {
				if err := os.Symlink(t.TempDir(), dest); err != nil {
					t.Skip("symlink privilege unavailable")
				}
			} else {
				writePreviewFixture(t, dest, "old")
				if kind == "custom-options" {
					_ = os.WriteFile(filepath.Join(dest, "RSLogix5000Content", "export-options.yaml"), []byte("schema_version: 3\n"), 0600)
				} else {
					_ = os.WriteFile(filepath.Join(dest, ".gitattributes"), []byte("* text\n"), 0600)
				}
			}
			s.runHelper = func(context.Context, string, io.Writer, io.Writer, string, ...string) CommandResult {
				t.Fatal("helper ran for incompatible destination")
				return CommandResult{}
			}
			if generateTestPreview(t, s, root, source).Success {
				t.Fatal("replaced unrelated or incompatible output")
			}
		})
	}
}

func TestPreviewAttributesPreserveVendorBytesAndIgnoredSource(t *testing.T) {
	s, root, source := previewTestService(t)
	_ = os.WriteFile(filepath.Join(root, ".gitignore"), []byte("*.ACD\n"), 0600)
	_ = os.WriteFile(filepath.Join(root, ".gitattributes"), []byte("*.xml text eol=crlf filter=external working-tree-encoding=UTF-16 ident\n"), 0600)
	runGitCmd(t, root, "config", "core.autocrlf", "true")
	requirePreviewSuccess(t, generateTestPreview(t, s, root, source))
	rel := "Controller.preview/RSLogix5000Content/Routine.xml"
	before, _ := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	result := NewGitService().CommitAll(root, "Save generated project files")
	if !result.Success {
		t.Fatalf("ordinary save failed: %+v", result)
	}
	stored, err := s.runner.RunGitRaw(root, "show", "HEAD:"+rel)
	if err != nil || string(stored) != string(before) {
		t.Fatalf("stored bytes changed: %q, %v", stored, err)
	}
	files := runGitOutput(t, root, "ls-files")
	if strings.Contains(files, "Controller.ACD") {
		t.Fatal("ignored ACD was tracked")
	}
	_ = os.WriteFile(filepath.Join(root, filepath.FromSlash(rel)), []byte("temporary edit"), 0600)
	runGitCmd(t, root, "checkout", "--", rel)
	restored, _ := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if string(restored) != string(before) {
		t.Fatal("restored bytes changed")
	}
	attrs := runGitOutput(t, root, "check-attr", "diff", "--", rel)
	if !strings.Contains(attrs, "set") {
		t.Fatal("text comparison disabled")
	}
}

func TestPreviewAttributeOverridePreservesPreviousOutput(t *testing.T) {
	s, root, source := previewTestService(t)
	requirePreviewSuccess(t, generateTestPreview(t, s, root, source))
	routine := filepath.Join(root, "Controller.preview", "RSLogix5000Content", "Routine.xml")
	_ = os.WriteFile(routine, []byte("old complete"), 0600)
	_ = os.WriteFile(filepath.Join(root, ".git", "info", "attributes"), []byte("*.xml text\n"), 0600)
	result := generateTestPreview(t, s, root, source)
	if result.Success || !strings.Contains(result.Error, "attributes") {
		t.Fatalf("attribute conflict not reported %+v", result)
	}
	data, _ := os.ReadFile(routine)
	if string(data) != "old complete" {
		t.Fatal("prior output changed")
	}
}

func TestPreviewPublicationFaultsRollback(t *testing.T) {
	for _, stage := range []string{"prepared", "moved-previous", "installed"} {
		t.Run(stage, func(t *testing.T) {
			s, root, source := previewTestService(t)
			requirePreviewSuccess(t, generateTestPreview(t, s, root, source))
			routine := filepath.Join(root, "Controller.preview", "RSLogix5000Content", "Routine.xml")
			_ = os.WriteFile(routine, []byte("previous complete"), 0600)
			s.publicationFault = func(current string) error {
				if current == stage {
					return fmt.Errorf("injected rename failure")
				}
				return nil
			}
			if generateTestPreview(t, s, root, source).Success {
				t.Fatal("fault reported success")
			}
			data, _ := os.ReadFile(routine)
			if string(data) != "previous complete" {
				t.Fatal("previous complete output was lost")
			}
			if _, err := os.Stat(previewJournalPath(s.stateDir, root)); !os.IsNotExist(err) {
				t.Fatal("rollback journal not reconciled")
			}
		})
	}
}

func TestPreviewInterruptedPublicationRecoversBeforeAppWrites(t *testing.T) {
	s, root, source := previewTestService(t)
	requirePreviewSuccess(t, generateTestPreview(t, s, root, source))
	destination := filepath.Join(root, "Controller.preview")
	routine := filepath.Join(destination, "RSLogix5000Content", "Routine.xml")
	_ = os.WriteFile(routine, []byte("previous complete"), 0600)
	before, err := capturePreviewContext(s.runner, root, destination)
	if err != nil {
		t.Fatal(err)
	}
	output := t.TempDir()
	writePreviewFixture(t, output, "new complete")
	s.publicationFault = func(stage string) error {
		if stage == "installed" {
			panic("simulated process loss")
		}
		return nil
	}
	func() {
		defer func() {
			if recover() == nil {
				t.Error("crash not injected")
			}
		}()
		_ = s.publishPreview(before, output, newPreviewOperationID())
	}()
	if result := NewGitService().CommitAll(root, "must not save interrupted output"); result.Success || !strings.Contains(result.Error, "interrupted") {
		t.Fatalf("save was not guarded %+v", result)
	}
	restarted := NewPreviewGenerationService()
	restarted.SetApp(nil)
	data, _ := os.ReadFile(routine)
	if string(data) != "previous complete" {
		t.Fatal("startup did not restore prior complete output")
	}
	if _, err := os.Stat(previewJournalPath(s.stateDir, root)); !os.IsNotExist(err) {
		t.Fatal("startup did not clear journal")
	}
}

func TestPreviewBusyBlocksMutationsAndNormalExitWaits(t *testing.T) {
	s, root, source := previewTestService(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan OperationResult, 1)
	var calls atomic.Int32
	s.runHelper = previewFakeHelper(t, func(ldsdkprotocol.Request) { calls.Add(1); close(entered); <-release })
	go func() { finished <- generateTestPreview(t, s, root, source) }()
	<-entered
	second := NewPreviewGenerationService()
	second.platformReady = func() error { return nil }
	result := generateTestPreview(t, second, root, source)
	if result.Success || !strings.Contains(result.Error, "Another preview") {
		t.Fatalf("second conversion was not refused %+v", result)
	}
	if result := NewGitService().CommitAll(root, "must not save"); result.Success || !strings.Contains(result.Error, "preview") {
		t.Fatalf("save not refused %+v", result)
	}
	if result := NewCommandRunner().RunGit(root, "add", "."); result.Success {
		t.Fatal("direct/background mutation bypassed guard")
	}
	if result := NewCommandRunner().RunGit(root, "symbolic-ref", "HEAD", "refs/heads/other"); result.Success {
		t.Fatal("direct reference mutation bypassed guard")
	}
	if result := NewCommandRunner().RunGit(root, "status", "--porcelain"); !result.Success {
		t.Fatal("read-only status was blocked")
	}
	if result := NewCommandRunner().RunGit(root, "branch", "--show-current"); !result.Success {
		t.Fatal("read-only branch query was blocked")
	}
	if result := NewGitService().CheckoutNewBranch(root, "must-not-switch"); result.Success {
		t.Fatal("branch changed during conversion")
	}
	closed := make(chan struct{})
	go func() { _ = s.ServiceShutdown(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("normal exit did not wait")
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	requirePreviewSuccess(t, <-finished)
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown stayed blocked")
	}
	if calls.Load() != 1 {
		t.Fatal("second request invoked helper")
	}
}

func TestPreviewSDKUncertaintyRequiresVerifiedReboot(t *testing.T) {
	s, root, source := previewTestService(t)
	s.runHelper = func(context.Context, string, io.Writer, io.Writer, string, ...string) CommandResult {
		return CommandResult{Error: "forced exit"}
	}
	if generateTestPreview(t, s, root, source).Success {
		t.Fatal("missing result accepted")
	}
	s.runHelper = previewFakeHelper(t, nil)
	if result := generateTestPreview(t, s, root, source); result.Error != previewSDKCleanupMessage {
		t.Fatalf("uncertain operation reran %+v", result)
	}
	s.bootID = func() (string, error) { return "boot-two", nil }
	requirePreviewSuccess(t, generateTestPreview(t, s, root, source))
}

func TestPreviewExternalIndexChangeRefusesPublication(t *testing.T) {
	s, root, source := previewTestService(t)
	s.runHelper = previewFakeHelper(t, func(ldsdkprotocol.Request) {
		_ = os.WriteFile(filepath.Join(root, "external.txt"), []byte("external staging"), 0600)
		runGitCmd(t, root, "add", "external.txt")
	})
	if generateTestPreview(t, s, root, source).Success {
		t.Fatal("published into changed repository context")
	}
	if _, err := os.Stat(filepath.Join(root, "Controller.preview")); !os.IsNotExist(err) {
		t.Fatal("published despite external staging change")
	}
}

func TestPreviewStructuredSDKFailureRequiresRestart(t *testing.T) {
	s, root, source := previewTestService(t)
	s.runHelper = func(_ context.Context, work string, _, _ io.Writer, _ string, _ ...string) CommandResult {
		requestData, _ := os.ReadFile(filepath.Join(work, "request.json"))
		var request ldsdkprotocol.Request
		_ = json.Unmarshal(requestData, &request)
		result := ldsdkprotocol.Result{ProtocolVersion: 1, OperationID: request.OperationID,
			HelperVersion: ldsdkprotocol.HelperVersion, VendorRevision: ldsdkprotocol.VendorRevision,
			FailureCode: "exportFailed", SDKCleanupConfirmed: false}
		if err := previewWriteJSON(filepath.Join(work, "result.json"), result); err != nil {
			t.Fatal(err)
		}
		return CommandResult{ExitCode: 1}
	}
	if result := generateTestPreview(t, s, root, source); result.Error != previewSDKCleanupMessage {
		t.Fatalf("SDK uncertainty did not explain required restart: %+v", result)
	}
	if _, err := os.Stat(filepath.Join(s.stateDir, "app-inflight.json")); err != nil {
		t.Fatal("SDK recovery state was discarded")
	}
}

func TestPreviewLegacyBootEvidenceRequiresAnotherRestart(t *testing.T) {
	s, root, source := previewTestService(t)
	s.runHelper = func(context.Context, string, io.Writer, io.Writer, string, ...string) CommandResult {
		return CommandResult{Error: "interrupted"}
	}
	_ = generateTestPreview(t, s, root, source)
	s.bootID = func() (string, error) { return "kernel-event-v1:machine:100", nil }
	s.runHelper = previewFakeHelper(t, nil)
	if result := generateTestPreview(t, s, root, source); result.Error != previewSDKCleanupMessage {
		t.Fatalf("format migration bypassed recovery: %+v", result)
	}
	if result := generateTestPreview(t, s, root, source); result.Error != previewSDKCleanupMessage {
		t.Fatalf("same startup bypassed recovery: %+v", result)
	}
	s.bootID = func() (string, error) { return "kernel-event-v1:machine:200", nil }
	requirePreviewSuccess(t, generateTestPreview(t, s, root, source))
}
