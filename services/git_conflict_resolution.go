package services

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	conflictBlobSizeLimit   = 50 * 1024 * 1024
	conflictOutputSizeLimit = 100 * 1024 * 1024
	conflictMarkerSize      = 32
	// Only this many lines of surrounding context travel to the UI per region;
	// the resolver never renders more than a short scrollable excerpt.
	conflictContextLineLimit = 25
)

type ConflictFileStatus string

const (
	ConflictStatusBothModified  ConflictFileStatus = "both-modified"
	ConflictStatusBothAdded     ConflictFileStatus = "both-added"
	ConflictStatusBothDeleted   ConflictFileStatus = "both-deleted"
	ConflictStatusDeletedByUs   ConflictFileStatus = "deleted-by-us"
	ConflictStatusDeletedByThem ConflictFileStatus = "deleted-by-them"
)

type ConflictIneligibleReason string

const (
	ConflictReasonNone                ConflictIneligibleReason = ""
	ConflictReasonUnsafeFileType      ConflictIneligibleReason = "unsafe-file-type"
	ConflictReasonMissingSide         ConflictIneligibleReason = "missing-side"
	ConflictReasonFileTooLarge        ConflictIneligibleReason = "file-too-large"
	ConflictReasonBinaryContent       ConflictIneligibleReason = "binary-content"
	ConflictReasonUnsupportedEncoding ConflictIneligibleReason = "unsupported-encoding"
	ConflictReasonUnsupportedContent  ConflictIneligibleReason = "unsupported-content"
	ConflictReasonLineEndingMismatch  ConflictIneligibleReason = "line-ending-mismatch"
	ConflictReasonGenerationFailed    ConflictIneligibleReason = "conflict-generation-failed"
	ConflictReasonOutputTooLarge      ConflictIneligibleReason = "output-too-large"
)

type ConflictBlob struct {
	Present bool   `json:"present"`
	OID     string `json:"oid,omitempty"`
	Mode    string `json:"mode,omitempty"`
	Content string `json:"content,omitempty"`
}

type ConflictRegion struct {
	ID       string   `json:"id"`
	Current  []string `json:"current"`
	Base     []string `json:"base,omitempty"`
	Incoming []string `json:"incoming"`
}

type ConflictSegment struct {
	Kind     string          `json:"kind"`
	Text     string          `json:"text,omitempty"`
	Conflict *ConflictRegion `json:"conflict,omitempty"`
}

// ConflictRegionView is the wire shape of a conflict region. It carries only the
// region itself plus a trimmed context excerpt, so the payload never scales with
// file size the way the full segment list did.
type ConflictRegionView struct {
	ID            string   `json:"id"`
	Current       []string `json:"current"`
	Base          []string `json:"base,omitempty"`
	Incoming      []string `json:"incoming"`
	ContextBefore string   `json:"contextBefore,omitempty"`
	ContextAfter  string   `json:"contextAfter,omitempty"`
}

// ConflictDecision is one region choice made in the UI. The resolved file is
// composed here from these decisions, so full file contents never cross the bridge.
type ConflictDecision struct {
	RegionID      string `json:"regionId"`
	Mode          string `json:"mode"`
	Side          string `json:"side,omitempty"`
	CurrentLines  []bool `json:"currentLines,omitempty"`
	IncomingLines []bool `json:"incomingLines,omitempty"`
}

type ConflictResolutionData struct {
	Success          bool                     `json:"success"`
	Path             string                   `json:"path"`
	Status           ConflictFileStatus       `json:"status"`
	Eligible         bool                     `json:"eligible"`
	IneligibleReason ConflictIneligibleReason `json:"ineligibleReason,omitempty"`
	Base             ConflictBlob             `json:"base"`
	Current          ConflictBlob             `json:"current"`
	Incoming         ConflictBlob             `json:"incoming"`
	Regions          []ConflictRegionView     `json:"regions,omitempty"`
	ResolutionToken  string                   `json:"resolutionToken,omitempty"`
	Newline          string                   `json:"newline,omitempty"`
	HasFinalNewline  bool                     `json:"hasFinalNewline"`
	Error            string                   `json:"error,omitempty"`
}

// conflictBlobSet holds the three stage contents. It stays inside the service —
// only metadata (present/oid/mode) is ever serialized to the frontend.
type conflictBlobSet struct {
	base     ConflictBlob
	current  ConflictBlob
	incoming ConflictBlob
}

type conflictStageEntry struct {
	stage int
	mode  string
	oid   string
}

// conflictOperationActive reports whether repoPath is mid-operation in a way
// that can leave conflict stages in the index. It is the gate the exported
// entry points apply; callers that already know the answer pass it instead.
func (g *GitService) conflictOperationActive(repoPath string, includeRebase bool) bool {
	state := g.GetMergeState(repoPath)
	return state.InMerge || state.InSquashMerge || state.InCherryPick || state.InRevert ||
		(includeRebase && state.InRebase)
}

func (g *GitService) GetConflictResolutionData(repoPath string, filePath string) ConflictResolutionData {
	return g.conflictResolutionData(repoPath, filePath, g.conflictOperationActive(repoPath, false))
}

// conflictResolutionData is the gate-free core. inOperation is supplied by the
// caller so an isolated integration workspace, which is known to be mid-merge,
// does not have to be inspected again.
func (g *GitService) conflictResolutionData(repoPath string, filePath string, inOperation bool) ConflictResolutionData {
	data := ConflictResolutionData{Path: normalizeMergePath(filePath)}
	if !inOperation {
		data.Error = "No supported conflict operation is in progress"
		return data
	}

	if _, err := safeRepoRelativePath(repoPath, data.Path); err != nil {
		data.Error = "Invalid conflict path"
		return data
	}

	entries, err := g.loadConflictStageEntries(repoPath, data.Path)
	if err != nil {
		data.Error = err.Error()
		return data
	}
	if len(entries) == 0 {
		data.Error = "The file is no longer conflicted"
		return data
	}

	data.Status = conflictStatus(entries)
	data.ResolutionToken = conflictResolutionToken(data.Path, entries)
	data.Base = conflictBlobMetadata(entries[1])
	data.Current = conflictBlobMetadata(entries[2])
	data.Incoming = conflictBlobMetadata(entries[3])

	blobs, reason, err := g.loadEligibleConflictBlobs(repoPath, entries)
	if err != nil {
		data.Error = err.Error()
		return data
	}
	data.Success = true
	if reason != ConflictReasonNone {
		data.IneligibleReason = reason
		return data
	}

	segments, mergedOutput, err := g.generateConflictSegments(repoPath, data.ResolutionToken, blobs)
	if err != nil {
		data.IneligibleReason = ConflictReasonGenerationFailed
		return data
	}
	if len(mergedOutput) > conflictOutputSizeLimit {
		data.IneligibleReason = ConflictReasonOutputTooLarge
		return data
	}
	data.Newline = detectConflictNewline(mergedOutput, blobs.current.Content, blobs.incoming.Content, blobs.base.Content)
	data.HasFinalNewline = hasFinalNewline(blobs.current.Content)
	data.Regions = buildConflictRegionViews(segments)
	data.Eligible = true
	return data
}

// loadEligibleConflictBlobs reads the three stages and applies every eligibility
// rule. A non-empty reason means section-by-section review is not possible; an
// error means the stages could not be read at all.
func (g *GitService) loadEligibleConflictBlobs(
	repoPath string,
	entries map[int]conflictStageEntry,
) (conflictBlobSet, ConflictIneligibleReason, error) {
	var blobs conflictBlobSet

	if unsafeMode := firstUnsafeConflictMode(entries); unsafeMode != "" {
		return blobs, ConflictReasonUnsafeFileType, nil
	}
	if g.conflictBlobExceedsLimit(repoPath, entries[1]) ||
		g.conflictBlobExceedsLimit(repoPath, entries[2]) ||
		g.conflictBlobExceedsLimit(repoPath, entries[3]) {
		return blobs, ConflictReasonFileTooLarge, nil
	}

	var err error
	if blobs.base, err = g.loadConflictBlob(repoPath, entries[1]); err != nil {
		return blobs, ConflictReasonNone, err
	}
	if blobs.current, err = g.loadConflictBlob(repoPath, entries[2]); err != nil {
		return blobs, ConflictReasonNone, err
	}
	if blobs.incoming, err = g.loadConflictBlob(repoPath, entries[3]); err != nil {
		return blobs, ConflictReasonNone, err
	}

	if !blobs.current.Present || !blobs.incoming.Present {
		return blobs, ConflictReasonMissingSide, nil
	}
	for _, blob := range []ConflictBlob{blobs.base, blobs.current, blobs.incoming} {
		if !blob.Present {
			continue
		}
		content := []byte(blob.Content)
		if len(content) > conflictBlobSizeLimit {
			return blobs, ConflictReasonFileTooLarge, nil
		}
		if bytes.IndexByte(content, 0) >= 0 {
			return blobs, ConflictReasonBinaryContent, nil
		}
		if !validUTF8WithOptionalBOM(content) {
			return blobs, ConflictReasonUnsupportedEncoding, nil
		}
		if !isConservativeText(content) {
			return blobs, ConflictReasonUnsupportedContent, nil
		}
	}
	if hasFinalNewline(blobs.current.Content) != hasFinalNewline(blobs.incoming.Content) {
		return blobs, ConflictReasonLineEndingMismatch, nil
	}

	return blobs, ConflictReasonNone, nil
}

func buildConflictRegionViews(segments []ConflictSegment) []ConflictRegionView {
	views := make([]ConflictRegionView, 0)
	for index, segment := range segments {
		if segment.Kind != "conflict" || segment.Conflict == nil {
			continue
		}

		view := ConflictRegionView{
			ID:       segment.Conflict.ID,
			Current:  segment.Conflict.Current,
			Base:     segment.Conflict.Base,
			Incoming: segment.Conflict.Incoming,
		}
		if index > 0 && segments[index-1].Kind == "context" {
			view.ContextBefore = trailingContextLines(segments[index-1].Text, conflictContextLineLimit)
		}
		if index+1 < len(segments) && segments[index+1].Kind == "context" {
			view.ContextAfter = leadingContextLines(segments[index+1].Text, conflictContextLineLimit)
		}
		views = append(views, view)
	}
	return views
}

func trailingContextLines(text string, limit int) string {
	lines := splitLinesRetainingEndings(text)
	if len(lines) <= limit {
		return text
	}
	return strings.Join(lines[len(lines)-limit:], "")
}

func leadingContextLines(text string, limit int) string {
	lines := splitLinesRetainingEndings(text)
	if len(lines) <= limit {
		return text
	}
	return strings.Join(lines[:limit], "")
}

func (g *GitService) ResolveConflictWithContent(repoPath string, filePath string, resolutionToken string, content string) OperationResult {
	return g.resolveConflictWithContent(repoPath, filePath, resolutionToken, content, g.conflictOperationActive(repoPath, false))
}

func (g *GitService) resolveConflictWithContent(repoPath string, filePath string, resolutionToken string, content string, inOperation bool) OperationResult {
	normalizedPath := normalizeMergePath(filePath)
	destination, err := safeConflictDestination(repoPath, normalizedPath)
	if err != nil {
		return failedOp("Invalid conflict path")
	}
	if !inOperation {
		return failedOp("No supported conflict operation is in progress")
	}
	entries, err := g.loadConflictStageEntries(repoPath, normalizedPath)
	if err != nil || len(entries) == 0 {
		return failedOp("The file is no longer conflicted")
	}
	if conflictResolutionToken(normalizedPath, entries) != resolutionToken {
		return failedOp("This conflict changed after it was opened. Reload it before resolving.")
	}
	if unsafeMode := firstUnsafeConflictMode(entries); unsafeMode != "" {
		return failedOp(unsupportedConflictModeMessage(unsafeMode))
	}

	return g.writeAndStageResolvedConflict(repoPath, normalizedPath, destination, []byte(content), entries)
}

// ResolveConflictWithDecisions composes the resolved file from per-region choices.
// Composition happens here rather than in the UI so the frontend never needs the
// full file text, and the resolved document is never rebuilt on every render.
func (g *GitService) ResolveConflictWithDecisions(repoPath string, filePath string, resolutionToken string, decisions []ConflictDecision) OperationResult {
	return g.resolveConflictWithDecisions(repoPath, filePath, resolutionToken, decisions, g.conflictOperationActive(repoPath, false))
}

func (g *GitService) resolveConflictWithDecisions(repoPath string, filePath string, resolutionToken string, decisions []ConflictDecision, inOperation bool) OperationResult {
	normalizedPath := normalizeMergePath(filePath)
	destination, err := safeConflictDestination(repoPath, normalizedPath)
	if err != nil {
		return failedOp("Invalid conflict path")
	}
	if !inOperation {
		return failedOp("No supported conflict operation is in progress")
	}
	entries, err := g.loadConflictStageEntries(repoPath, normalizedPath)
	if err != nil || len(entries) == 0 {
		return failedOp("The file is no longer conflicted")
	}
	if conflictResolutionToken(normalizedPath, entries) != resolutionToken {
		return failedOp("This conflict changed after it was opened. Reload it before resolving.")
	}

	blobs, reason, err := g.loadEligibleConflictBlobs(repoPath, entries)
	if err != nil {
		return failedOp("Failed to read the conflicting file versions")
	}
	if reason == ConflictReasonUnsafeFileType {
		return failedOp(unsupportedConflictModeMessage(firstUnsafeConflictMode(entries)))
	}
	if reason != ConflictReasonNone {
		return failedOp("This conflict can no longer be resolved section by section. Reload it and choose the complete file.")
	}

	segments, mergedOutput, err := g.generateConflictSegments(repoPath, resolutionToken, blobs)
	if err != nil {
		return failedOp("IOFabrik could not rebuild the conflict sections. Reload the conflict and try again.")
	}
	if len(mergedOutput) > conflictOutputSizeLimit {
		return failedOp("Resolved content is too large")
	}

	newline := detectConflictNewline(mergedOutput, blobs.current.Content, blobs.incoming.Content, blobs.base.Content)
	content, err := composeConflictResolution(segments, decisions, newline, hasFinalNewline(blobs.current.Content))
	if err != nil {
		return failedOp(err.Error())
	}

	return g.writeAndStageResolvedConflict(repoPath, normalizedPath, destination, []byte(content), entries)
}

func (g *GitService) writeAndStageResolvedConflict(
	repoPath string,
	normalizedPath string,
	destination string,
	content []byte,
	entries map[int]conflictStageEntry,
) OperationResult {
	if len(content) > conflictOutputSizeLimit {
		return failedOp("Resolved content is too large")
	}
	if bytes.IndexByte(content, 0) >= 0 || !utf8.Valid(content) {
		return failedOp("Resolved content must be valid UTF-8 text")
	}
	if isL5XPath(normalizedPath) && !isWellFormedXML(content) {
		return failedOp("The resolved file is not a well-formed L5X document.\nAdjust your choices or keep the complete file.")
	}

	mode := os.FileMode(0644)
	if current, ok := entries[2]; ok && current.mode == "100755" {
		mode = 0755
	}
	if err := writeResolvedConflictFile(destination, content, mode); err != nil {
		return failedOp("Failed to write resolved file: " + err.Error())
	}

	addResult := g.runner.RunGit(repoPath, "add", "--", normalizedPath)
	if !addResult.Success {
		return failedOp("The resolved file was written, but could not be staged. Retry Resolve File. " + getErrorMessage(addResult))
	}
	return successOp(fmt.Sprintf("Resolved '%s'", normalizedPath))
}

func isL5XPath(path string) bool {
	return strings.EqualFold(filepath.Ext(path), ".l5x")
}

// isWellFormedXML streams the document through a token decoder. It allocates no
// tree, so it stays cheap even for very large L5X files, while still catching a
// composition that would write structurally broken XML into the working tree.
func isWellFormedXML(content []byte) bool {
	decoder := xml.NewDecoder(bytes.NewReader(stripUTF8BOM(content)))
	// Content already passed UTF-8 validation, so honour any declared encoding as-is
	// instead of rejecting documents for a charset name we do not need to convert.
	decoder.CharsetReader = func(_ string, input io.Reader) (io.Reader, error) {
		return input, nil
	}

	depth := 0
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return depth == 0
		}
		if err != nil {
			return false
		}
		switch token.(type) {
		case xml.StartElement:
			depth++
		case xml.EndElement:
			depth--
		}
	}
}

func composeConflictResolution(
	segments []ConflictSegment,
	decisions []ConflictDecision,
	newline string,
	terminateFinalLine bool,
) (string, error) {
	if newline == "" {
		newline = "\n"
	}

	decisionsByRegion := make(map[string]ConflictDecision, len(decisions))
	for _, decision := range decisions {
		decisionsByRegion[decision.RegionID] = decision
	}

	regionIDs := make(map[string]struct{})
	for _, segment := range segments {
		if segment.Kind == "conflict" && segment.Conflict != nil {
			regionIDs[segment.Conflict.ID] = struct{}{}
		}
	}
	for _, decision := range decisions {
		if _, known := regionIDs[decision.RegionID]; !known {
			return "", fmt.Errorf("This conflict changed after it was opened. Reload it before resolving.")
		}
	}

	var output strings.Builder
	for index, segment := range segments {
		if segment.Kind == "context" {
			output.WriteString(segment.Text)
			continue
		}
		if segment.Conflict == nil {
			continue
		}

		decision, decided := decisionsByRegion[segment.Conflict.ID]
		if !decided {
			return "", fmt.Errorf("Choose a version for every conflict before resolving the file.")
		}
		resolved, err := resolveConflictRegion(*segment.Conflict, decision, newline, index < len(segments)-1 || terminateFinalLine)
		if err != nil {
			return "", err
		}
		output.WriteString(resolved)
	}

	return output.String(), nil
}

func resolveConflictRegion(
	region ConflictRegion,
	decision ConflictDecision,
	newline string,
	terminateWithNewline bool,
) (string, error) {
	var selected []string

	switch decision.Mode {
	case "block":
		if decision.Side != "current" && decision.Side != "incoming" {
			return "", fmt.Errorf("Choose a version for every conflict before resolving the file.")
		}
		if decision.Side == "current" {
			selected = region.Current
		} else {
			selected = region.Incoming
		}
	case "lines":
		if len(decision.CurrentLines) != len(region.Current) || len(decision.IncomingLines) != len(region.Incoming) {
			return "", fmt.Errorf("This conflict changed after it was opened. Reload it before resolving.")
		}
		for index, keep := range decision.CurrentLines {
			if keep {
				selected = append(selected, region.Current[index])
			}
		}
		for index, keep := range decision.IncomingLines {
			if keep {
				selected = append(selected, region.Incoming[index])
			}
		}
		if len(selected) == 0 {
			return "", fmt.Errorf("Choose at least one line for every conflict before resolving the file.")
		}
	case "remove":
		return "", nil
	default:
		return "", fmt.Errorf("Choose a version for every conflict before resolving the file.")
	}

	content := strings.Join(selected, newline)
	if len(selected) > 0 && terminateWithNewline {
		content += newline
	}
	return content, nil
}

func (g *GitService) resolveConflictWithStage(repoPath string, filePath string, stage int, sideName string, inOperation bool) OperationResult {
	normalizedPath := normalizeMergePath(filePath)
	destination, err := safeConflictDestination(repoPath, normalizedPath)
	if err != nil {
		return failedOp("Invalid conflict path")
	}
	if !inOperation {
		return failedOp("No merge in progress - cannot resolve conflict")
	}
	entries, err := g.loadConflictStageEntries(repoPath, normalizedPath)
	if err != nil || len(entries) == 0 {
		return failedOp("The file is no longer conflicted")
	}
	if unsafeMode := firstUnsafeConflictMode(entries); unsafeMode != "" {
		return failedOp(unsupportedConflictModeMessage(unsafeMode))
	}
	entry, present := entries[stage]
	if !present {
		if removeErr := os.Remove(destination); removeErr != nil && !os.IsNotExist(removeErr) {
			return failedOp("Failed to apply the selected deletion: " + removeErr.Error())
		}
		result := g.runner.RunGit(repoPath, "rm", "--cached", "--ignore-unmatch", "--", normalizedPath)
		if !result.Success {
			return failedOp("Failed to stage the selected deletion: " + getErrorMessage(result))
		}
		return successOp(fmt.Sprintf("Resolved '%s' by keeping the %s file", normalizedPath, sideName))
	}

	content, err := g.runner.RunGitRaw(repoPath, "cat-file", "blob", entry.oid)
	if err != nil {
		return failedOp("Failed to read the selected file version")
	}
	mode := os.FileMode(0644)
	if entry.mode == "100755" {
		mode = 0755
	}
	if err := writeResolvedConflictFile(destination, content, mode); err != nil {
		return failedOp("Failed to write the selected file version: " + err.Error())
	}
	result := g.runner.RunGit(repoPath, "add", "--", normalizedPath)
	if !result.Success {
		return failedOp("Failed to stage resolved file: " + getErrorMessage(result))
	}
	return successOp(fmt.Sprintf("Resolved '%s' by keeping the %s file", normalizedPath, sideName))
}

func safeConflictDestination(repoPath string, relativePath string) (string, error) {
	destination, err := safeRepoRelativePath(repoPath, relativePath)
	if err != nil {
		return "", err
	}
	realRepo, err := filepath.EvalSymlinks(repoPath)
	if err != nil {
		return "", err
	}
	realParent, err := filepath.EvalSymlinks(filepath.Dir(destination))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(realRepo, realParent)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes repository through a symbolic link")
	}
	return destination, nil
}

func writeResolvedConflictFile(destination string, content []byte, mode os.FileMode) error {
	if info, statErr := os.Lstat(destination); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("cannot replace a symbolic link while resolving a conflict")
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".iofabrik-conflict-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err = temporary.Chmod(mode); err == nil {
		_, err = temporary.Write(content)
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = replaceFileAtomic(temporaryPath, destination)
	}
	return err
}

func (g *GitService) loadConflictStageEntries(repoPath string, filePath string) (map[int]conflictStageEntry, error) {
	result := g.runner.RunGit(repoPath, "ls-files", "-u", "-z", "--", filePath)
	if !result.Success {
		return nil, fmt.Errorf("failed to read conflict stages: %s", getErrorMessage(result))
	}
	entries := make(map[int]conflictStageEntry)
	for _, record := range strings.Split(result.Stdout, "\x00") {
		if record == "" {
			continue
		}
		header, _, found := strings.Cut(record, "\t")
		fields := strings.Fields(header)
		if !found || len(fields) != 3 {
			return nil, fmt.Errorf("Git returned an invalid conflict stage entry")
		}
		stage, parseErr := strconv.Atoi(fields[2])
		if parseErr != nil || stage < 1 || stage > 3 {
			return nil, fmt.Errorf("Git returned an invalid conflict stage number")
		}
		entries[stage] = conflictStageEntry{stage: stage, mode: fields[0], oid: fields[1]}
	}
	return entries, nil
}

func (g *GitService) loadConflictBlob(repoPath string, entry conflictStageEntry) (ConflictBlob, error) {
	if entry.oid == "" {
		return ConflictBlob{}, nil
	}
	content, err := g.runner.RunGitRaw(repoPath, "cat-file", "blob", entry.oid)
	if err != nil {
		return ConflictBlob{}, fmt.Errorf("failed to read conflict content")
	}
	return ConflictBlob{Present: true, OID: entry.oid, Mode: entry.mode, Content: string(content)}, nil
}

func (g *GitService) conflictBlobExceedsLimit(repoPath string, entry conflictStageEntry) bool {
	if entry.oid == "" {
		return false
	}
	result := g.runner.RunGit(repoPath, "cat-file", "-s", entry.oid)
	if !result.Success {
		return true
	}
	size, err := strconv.ParseInt(strings.TrimSpace(result.Stdout), 10, 64)
	return err != nil || size > conflictBlobSizeLimit
}

func conflictBlobMetadata(entry conflictStageEntry) ConflictBlob {
	if entry.oid == "" {
		return ConflictBlob{}
	}
	return ConflictBlob{Present: true, OID: entry.oid, Mode: entry.mode}
}

func firstUnsafeConflictMode(entries map[int]conflictStageEntry) string {
	for stage := 1; stage <= 3; stage++ {
		entry, present := entries[stage]
		if present && entry.mode != "100644" && entry.mode != "100755" {
			return entry.mode
		}
	}
	return ""
}

func unsupportedConflictModeMessage(mode string) string {
	switch mode {
	case "120000":
		return "Symbolic link conflicts cannot be resolved as files. Use the repository recovery tools."
	case "160000":
		return "Submodule conflicts cannot be resolved as files. Use the repository recovery tools."
	default:
		return "This conflict uses an unsupported file type. Use the repository recovery tools."
	}
}

func conflictStatus(entries map[int]conflictStageEntry) ConflictFileStatus {
	_, base := entries[1]
	_, current := entries[2]
	_, incoming := entries[3]
	switch {
	case !base && current && incoming:
		return ConflictStatusBothAdded
	case base && !current && !incoming:
		return ConflictStatusBothDeleted
	case base && !current && incoming:
		return ConflictStatusDeletedByUs
	case base && current && !incoming:
		return ConflictStatusDeletedByThem
	default:
		return ConflictStatusBothModified
	}
}

func conflictResolutionToken(path string, entries map[int]conflictStageEntry) string {
	hash := sha256.New()
	_, _ = fmt.Fprintf(hash, "%s\x00", path)
	for stage := 1; stage <= 3; stage++ {
		entry := entries[stage]
		_, _ = fmt.Fprintf(hash, "%d\x00%s\x00%s\x00", stage, entry.mode, entry.oid)
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func (g *GitService) generateConflictSegments(repoPath string, resolutionToken string, blobs conflictBlobSet) ([]ConflictSegment, string, error) {
	temporaryDir, err := os.MkdirTemp("", "iofabrik-merge-file-*")
	if err != nil {
		return nil, "", err
	}
	defer os.RemoveAll(temporaryDir)

	currentPath := filepath.Join(temporaryDir, "current")
	basePath := filepath.Join(temporaryDir, "base")
	incomingPath := filepath.Join(temporaryDir, "incoming")
	if err := os.WriteFile(currentPath, stripUTF8BOM([]byte(blobs.current.Content)), 0600); err != nil {
		return nil, "", err
	}
	if err := os.WriteFile(basePath, stripUTF8BOM([]byte(blobs.base.Content)), 0600); err != nil {
		return nil, "", err
	}
	if err := os.WriteFile(incomingPath, stripUTF8BOM([]byte(blobs.incoming.Content)), 0600); err != nil {
		return nil, "", err
	}

	labelToken := resolutionToken[:16]
	currentLabel := "IOFABRIK_CURRENT_" + labelToken
	baseLabel := "IOFABRIK_BASE_" + labelToken
	incomingLabel := "IOFABRIK_INCOMING_" + labelToken
	for _, content := range []string{blobs.base.Content, blobs.current.Content, blobs.incoming.Content} {
		if strings.Contains(content, currentLabel) || strings.Contains(content, baseLabel) || strings.Contains(content, incomingLabel) {
			return nil, "", fmt.Errorf("conflict marker collision")
		}
	}

	result := g.runner.RunGit(repoPath, "merge-file", "-p", "--diff3", fmt.Sprintf("--marker-size=%d", conflictMarkerSize),
		"-L", currentLabel, "-L", baseLabel, "-L", incomingLabel, currentPath, basePath, incomingPath)
	if !result.Success && (result.ExitCode < 0 || result.ExitCode > 127) {
		return nil, "", fmt.Errorf("Git could not generate conflict regions: %s", getErrorMessage(result))
	}
	mergedOutput := result.Stdout
	if hasUTF8BOM([]byte(blobs.current.Content)) {
		mergedOutput = "\ufeff" + mergedOutput
	}
	segments, err := parseConflictSegments(mergedOutput, currentLabel, baseLabel, incomingLabel)
	return segments, mergedOutput, err
}

func parseConflictSegments(output string, currentLabel string, baseLabel string, incomingLabel string) ([]ConflictSegment, error) {
	currentMarker := strings.Repeat("<", conflictMarkerSize) + " " + currentLabel
	baseMarker := strings.Repeat("|", conflictMarkerSize) + " " + baseLabel
	separator := strings.Repeat("=", conflictMarkerSize)
	incomingMarker := strings.Repeat(">", conflictMarkerSize) + " " + incomingLabel
	leadingBOM := ""
	if strings.HasPrefix(output, "\ufeff") {
		leadingBOM = "\ufeff"
		output = strings.TrimPrefix(output, leadingBOM)
	}
	lines := splitLinesRetainingEndings(output)
	segments := make([]ConflictSegment, 0)
	regionCount := 0
	var context strings.Builder
	context.WriteString(leadingBOM)
	flushContext := func() {
		if context.Len() > 0 {
			segments = append(segments, ConflictSegment{Kind: "context", Text: context.String()})
			context.Reset()
		}
	}

	for index := 0; index < len(lines); {
		if trimLineEnding(lines[index]) != currentMarker {
			context.WriteString(lines[index])
			index++
			continue
		}
		flushContext()
		index++
		region := ConflictRegion{ID: fmt.Sprintf("conflict-%d", regionCount+1)}
		var destination *[]string = &region.Current
		for index < len(lines) {
			marker := trimLineEnding(lines[index])
			switch marker {
			case baseMarker:
				destination = &region.Base
				index++
			case separator:
				destination = &region.Incoming
				index++
			case incomingMarker:
				index++
				segments = append(segments, ConflictSegment{Kind: "conflict", Conflict: &region})
				regionCount++
				destination = nil
			default:
				*destination = append(*destination, trimLineEnding(lines[index]))
				index++
			}
			if destination == nil {
				break
			}
		}
		if destination != nil {
			return nil, fmt.Errorf("unterminated conflict region")
		}
	}
	flushContext()
	if regionCount == 0 {
		return nil, fmt.Errorf("Git produced no conflict regions")
	}
	return segments, nil
}

func splitLinesRetainingEndings(content string) []string {
	if content == "" {
		return nil
	}
	lines := make([]string, 0, strings.Count(content, "\n")+1)
	for len(content) > 0 {
		index := strings.IndexByte(content, '\n')
		if index < 0 {
			lines = append(lines, content)
			break
		}
		lines = append(lines, content[:index+1])
		content = content[index+1:]
	}
	return lines
}

func trimLineEnding(line string) string {
	return strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
}

func validUTF8WithOptionalBOM(content []byte) bool {
	content = stripUTF8BOM(content)
	return utf8.Valid(content)
}

func hasUTF8BOM(content []byte) bool {
	return bytes.HasPrefix(content, []byte{0xef, 0xbb, 0xbf})
}

func stripUTF8BOM(content []byte) []byte {
	return bytes.TrimPrefix(content, []byte{0xef, 0xbb, 0xbf})
}

func isConservativeText(content []byte) bool {
	content = stripUTF8BOM(content)
	for _, value := range content {
		if value < 0x20 && value != '\t' && value != '\n' && value != '\r' && value != '\f' {
			return false
		}
	}
	return true
}

func detectConflictNewline(contents ...string) string {
	for _, content := range contents {
		if strings.Contains(content, "\r\n") {
			return "\r\n"
		}
		if strings.Contains(content, "\n") {
			return "\n"
		}
	}
	return "\n"
}

func hasFinalNewline(content string) bool {
	return strings.HasSuffix(content, "\n")
}
