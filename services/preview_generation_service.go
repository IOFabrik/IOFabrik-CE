package services

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"iofabrik/internal/ldsdkprotocol"
)

const previewSDKCleanupMessage = "A previous SDK operation was interrupted. Restart Windows, then select Generate preview again."

var previewOperationPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validPreviewOperationID(id string) bool { return previewOperationPattern.MatchString(id) }

func newPreviewOperationID() string {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return ""
	}
	id[6] = (id[6] & 15) | 64
	id[8] = (id[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
}

type PreviewGenerationService struct {
	app              *application.App
	runner           *CommandRunner
	stateDir         string
	mu               sync.Mutex
	closing          bool
	active           sync.WaitGroup
	platformReady    func() error
	resolveHelper    func() (string, error)
	bootID           func() (string, error)
	runHelper        func(context.Context, string, io.Writer, io.Writer, string, ...string) CommandResult
	publicationFault func(string) error
	onProgress       func(ProgressUpdate)
}

func NewPreviewGenerationService() *PreviewGenerationService {
	runner := NewCommandRunner()
	runner.previewOwner = true
	return &PreviewGenerationService{runner: runner, stateDir: previewStateDirectory(),
		platformReady: previewPlatformReady, resolveHelper: resolvePreviewHelper, bootID: previewBootID,
		runHelper: runner.runWithWriters}
}

func (s *PreviewGenerationService) SetApp(app *application.App) {
	s.app = app
	if !filepath.IsAbs(s.stateDir) {
		return
	}
	// Reconcile interrupted directory swaps before the first project is opened.
	entries, _ := os.ReadDir(filepath.Join(s.stateDir, "transactions"))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.stateDir, "transactions", entry.Name()))
		if err != nil || len(data) > 16384 {
			continue
		}
		var record previewTransaction
		if json.Unmarshal(data, &record) != nil || !filepath.IsAbs(record.Root) {
			continue
		}
		common, err := gitCommonDirPath(s.runner, record.Root)
		if err != nil {
			continue
		}
		globalRelease, err := acquirePreviewLock(filepath.Join(s.stateDir, "app-operation.lock"), true)
		if err != nil {
			continue
		}
		release, err := acquirePreviewLock(filepath.Join(s.stateDir, "repo-locks", previewPathKey(common)+".lock"), true)
		if err == nil {
			if err := recoverPreviewPublication(s.stateDir, record.Root); err != nil {
				GetDebugLogger().Log(LogLevelError, LogCategoryError, "PreviewGenerationService.Recover", previewRecoveryMessage, LogDetails{Error: err.Error()}, 0)
			}
			release()
		}
		globalRelease()
	}
}

// Wails waits for this lifecycle method during normal exit. We deliberately do
// not cancel an SDK call merely because the user closed the window.
func (s *PreviewGenerationService) ServiceShutdown() error {
	s.mu.Lock()
	s.closing = true
	s.mu.Unlock()
	s.active.Wait()
	return nil
}

func (s *PreviewGenerationService) emit(id, stage string) {
	messages := map[string]string{"starting": "Checking the project and preview tools…", "copy": "Copying the selected ACD…",
		"export": "Exporting the copied project with Logix Designer…", "explode": "Generating project files…", "publish": "Publishing the complete preview…"}
	update := ProgressUpdate{OperationID: id, Phase: stage, Percent: -1, Message: messages[stage]}
	if s.onProgress != nil {
		s.onProgress(update)
	}
	if s.app != nil {
		s.app.Event.Emit("preview-progress", update)
	}
}

type previewSDKState struct {
	OperationID string `json:"operationId"`
	BootID      string `json:"bootId"`
	Observed    bool   `json:"observed"`
}

func (s *PreviewGenerationService) reconcileSDK(boot string) error {
	path := filepath.Join(s.stateDir, "app-inflight.json")
	marker := filepath.Join(s.stateDir, "sdk-interrupted.json")
	var vendor struct {
		OperationID string `json:"operationId"`
	}
	markerBytes, markerErr := os.ReadFile(marker)
	if markerErr != nil && !os.IsNotExist(markerErr) {
		return markerErr
	}
	if markerErr == nil {
		if err := json.Unmarshal(markerBytes, &vendor); err != nil || !validPreviewOperationID(vendor.OperationID) {
			return fmt.Errorf("invalid SDK cleanup record")
		}
	}
	data, err := os.ReadFile(path)
	if err == nil {
		var prior previewSDKState
		if err := json.Unmarshal(data, &prior); err != nil || prior.BootID == "" || !validPreviewOperationID(prior.OperationID) {
			return fmt.Errorf("invalid SDK operation record")
		}
		if prior.BootID == boot && !(prior.Observed && os.IsNotExist(markerErr)) {
			return fmt.Errorf("SDK cleanup remains uncertain")
		}
		if markerErr == nil {
			if prior.OperationID != vendor.OperationID {
				return fmt.Errorf("SDK operation ownership changed")
			}
			if err := os.Remove(marker); err != nil {
				return err
			}
		}
		return os.Remove(path)
	}
	if !os.IsNotExist(err) {
		return err
	}
	if markerErr == nil {
		if err := previewWriteJSON(path, previewSDKState{OperationID: vendor.OperationID, BootID: boot, Observed: true}); err != nil {
			return err
		}
		return fmt.Errorf("SDK cleanup remains uncertain")
	}
	return nil
}

// GeneratePreview is explicit and synchronous: a second request is refused,
// never queued. The UI supplies a UUID before subscribing to stage events.
func (s *PreviewGenerationService) GeneratePreview(repoPath, sourcePath, operationID string) OperationResult {
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		return failedOp("The app is closing. Reopen it to generate a preview.")
	}
	s.active.Add(1)
	s.mu.Unlock()
	defer s.active.Done()
	fail := func(message string, err error) OperationResult {
		if err != nil {
			GetDebugLogger().Log(LogLevelError, LogCategoryError, "PreviewGenerationService.GeneratePreview", message, LogDetails{Error: err.Error()}, 0)
		}
		return failedOp(message)
	}
	if !validPreviewOperationID(operationID) {
		return fail("This preview request is invalid. Select Generate preview again.", nil)
	}
	if !filepath.IsAbs(s.stateDir) {
		return fail("Cannot locate Windows app storage. Check your Windows profile and reopen the app.", nil)
	}
	if runtime.GOOS != "windows" && s.platformReady == nil {
		return fail("Preview generation requires Windows x64 with Logix Designer SDK installed.", nil)
	}
	if err := s.platformReady(); err != nil {
		return fail("Preview generation requires Windows x64 and the Logix Designer SDK service running. Check the installation and try again.", err)
	}
	root, err := previewRoot(s.runner, repoPath)
	if err != nil {
		return fail("Open a project with tracking enabled, then generate its preview.", err)
	}
	if !filepath.IsAbs(sourcePath) {
		sourcePath = filepath.Join(root, sourcePath)
	}
	sourcePath = filepath.Clean(sourcePath)
	if !previewWithin(root, sourcePath) || !eligiblePreviewName(filepath.Base(sourcePath)) {
		return fail("Select an ACD file with a simple name inside the open project.", nil)
	}
	if err := previewPhysicalPath(sourcePath); err != nil {
		return fail("This ACD cannot be read safely. Choose a regular file inside the project, without links or junctions.", err)
	}
	info, err := os.Stat(sourcePath)
	if err != nil || !info.Mode().IsRegular() {
		return fail("The selected ACD is unavailable. Check the file and try again.", err)
	}
	destination := strings.TrimSuffix(sourcePath, filepath.Ext(sourcePath)) + ".preview"
	common, err := gitCommonDirPath(s.runner, root)
	if err != nil {
		return fail("Cannot check the project location. Reopen the project and try again.", err)
	}
	if previewWithin(common, sourcePath) || previewWithin(root, s.stateDir) {
		return fail("Choose an ACD in the project working folder, separate from app storage.", nil)
	}
	globalRelease, err := acquirePreviewLock(filepath.Join(s.stateDir, "app-operation.lock"), true)
	if err != nil {
		return fail("Another preview is being generated. Wait for it to finish, then try again.", nil)
	}
	defer globalRelease()
	repoRelease, err := acquirePreviewLock(filepath.Join(s.stateDir, "repo-locks", previewPathKey(common)+".lock"), true)
	if err != nil {
		return fail("Another project operation is running. Wait for it to finish, then generate the preview.", nil)
	}
	defer repoRelease()
	coordinatorRelease := sharedRepositoryCoordinator.lockKey(repositoryLockKey(s.runner, root))
	defer coordinatorRelease()
	s.emit(operationID, "starting")
	if err := recoverPreviewPublication(s.stateDir, root); err != nil {
		return fail("The previous preview could not be restored safely. Check project folder permissions and restart the app before saving changes.", err)
	}
	if err := validatePreviewDestination(destination); err != nil {
		return fail("The preview folder contains unrelated or incompatible content. Move that folder aside, then select Generate preview again.", err)
	}
	before, err := capturePreviewContext(s.runner, root, destination)
	if err != nil {
		return fail("Cannot verify the project location. Reopen the project and try again.", err)
	}
	helper, err := s.resolveHelper()
	if err != nil {
		return fail("The preview tools are missing or changed. Reinstall the complete app build, including its helper folder, then try again.", err)
	}
	boot, err := s.bootID()
	if err != nil {
		return fail("Cannot establish Windows recovery state. Restart Windows and try again.", err)
	}
	if err := s.reconcileSDK(boot); err != nil {
		return fail(previewSDKCleanupMessage, err)
	}
	work := filepath.Join(s.stateDir, "operations", operationID)
	if err := os.MkdirAll(filepath.Dir(work), 0700); err != nil {
		return fail("Cannot prepare the preview. Check free disk space and app folder permissions.", err)
	}
	if err := os.Mkdir(work, 0700); err != nil {
		return fail("Cannot prepare this request. Select Generate preview again and check free disk space.", err)
	}
	if err := previewPhysicalPath(work); err != nil {
		return fail("App storage contains an unsupported link. Reinstall the app in a regular folder.", err)
	}
	request := ldsdkprotocol.Request{ProtocolVersion: ldsdkprotocol.Version, OperationID: operationID, Operation: "exportExplode", SourceACDPath: sourcePath, WorkDirectory: work}
	requestPath := filepath.Join(work, "request.json")
	if err := previewWriteJSON(requestPath, request); err != nil {
		return fail("Cannot write the preview request. Check free disk space and try again.", err)
	}
	appRecord := filepath.Join(s.stateDir, "app-inflight.json")
	if err := previewWriteJSON(appRecord, previewSDKState{OperationID: operationID, BootID: boot}); err != nil {
		return fail("Cannot prepare safe SDK recovery. Check app folder permissions and try again.", err)
	}
	stdout := &previewProgressWriter{id: operationID, emit: s.emit}
	stderr := &previewLimitedWriter{limit: 8192}
	// The verified samples took 26–57 seconds. Give this SDK operation five
	// minutes, without changing the ordinary CommandRunner timeout.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	process := s.runHelper(ctx, work, stdout, stderr, helper, "--request", requestPath)
	data, readErr := previewReadLimited(filepath.Join(work, "result.json"), 65536)
	if readErr != nil {
		return fail("The SDK did not finish the preview. Check that .NET 10 and Logix Designer SDK are installed, restart Windows, then try again.", fmt.Errorf("helper: %s; %s; result: %v", process.Error, stderr.String(), readErr))
	}
	result, resultErr := ldsdkprotocol.ValidateResult(data, request, process.Success)
	if resultErr != nil || stdout.invalid || stdout.buffer.Len() != 0 {
		return fail("The preview tools returned an incomplete result. Restart Windows and reinstall the complete app build before trying again.", resultErr)
	}
	if result.SDKCleanupConfirmed {
		if err := os.Remove(appRecord); err != nil {
			return fail("The preview finished but recovery state could not be updated. Check app permissions and restart Windows before trying again.", err)
		}
		defer os.RemoveAll(work)
	}
	if !result.Success {
		diagnostics, _ := previewReadLimited(filepath.Join(work, "diagnostics.log"), 16384)
		message := previewFailureMessage(result.FailureCode)
		if !result.SDKCleanupConfirmed {
			message = previewSDKCleanupMessage
		}
		return fail(message, fmt.Errorf("helper failure %s; diagnostics: %s; %s", result.FailureCode, diagnostics, stderr.String()))
	}
	s.emit(operationID, "publish")
	if err := s.publishPreview(before, result.OutputRoot, operationID); err != nil {
		message := "The complete preview could not be published. Check free disk space and folder permissions, then try again."
		if strings.Contains(err.Error(), "attribute") {
			message = "Project attributes would change the generated files. Remove overriding rules for this preview from local attributes, then try again."
		}
		return fail(message, err)
	}
	return successOp("Preview generated")
}

func previewFailureMessage(code string) string {
	switch code {
	case "busy":
		return "Another SDK preview is running. Wait for it to finish, then try again."
	case "sdkCleanupRequired":
		return previewSDKCleanupMessage
	case "copyFailed":
		return "The ACD could not be copied. Close programs locking the file, check free disk space, and try again."
	case "exportFailed", "invalidExport":
		return "Logix Designer SDK could not export this ACD. Check its version and SDK activation, then try again."
	case "explodeFailed", "invalidOutput":
		return "The export could not be turned into a preview. Check SDK support for this project's protected content and try again."
	default:
		return "The preview could not be generated. Check the selected ACD and the complete app installation, then try again."
	}
}

type previewProgressWriter struct {
	id      string
	buffer  bytes.Buffer
	invalid bool
	emit    func(string, string)
}

func (w *previewProgressWriter) Write(p []byte) (int, error) {
	if w.buffer.Len()+len(p) > 65536 {
		w.invalid = true
		return len(p), nil
	}
	w.buffer.Write(p)
	for {
		line, err := w.buffer.ReadString('\n')
		if err != nil {
			w.buffer.WriteString(line)
			break
		}
		var update ldsdkprotocol.Progress
		if json.Unmarshal([]byte(line), &update) != nil || update.ProtocolVersion != ldsdkprotocol.Version || update.OperationID != w.id {
			w.invalid = true
			continue
		}
		switch update.Stage {
		case "copy", "export", "explode":
			w.emit(w.id, update.Stage)
		default:
			w.invalid = true
		}
	}
	return len(p), nil
}

type previewLimitedWriter struct {
	buffer bytes.Buffer
	limit  int
}

func (w *previewLimitedWriter) Write(p []byte) (int, error) {
	size := len(p)
	remaining := w.limit - w.buffer.Len()
	if remaining > 0 {
		if len(p) > remaining {
			p = p[:remaining]
		}
		w.buffer.Write(p)
	}
	return size, nil
}
func (w *previewLimitedWriter) String() string { return w.buffer.String() }

func previewReadLimited(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err == nil && int64(len(data)) > limit {
		return data[:limit], fmt.Errorf("preview record exceeds size limit")
	}
	return data, err
}
