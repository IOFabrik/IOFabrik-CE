// Package ldsdkprotocol defines the public interface to the private Windows
// conversion helper. It performs no conversion, process execution or publication.
package ldsdkprotocol

import (
	"bufio"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	Version        = 1
	HelperVersion  = "0.1.0"
	FormatVersion  = 2
	VendorRevision = "923a9675a53637515c8a5088ff7eed41a9b3eb82"
	maxResultBytes = 64 * 1024
)

// Request is written to request.json in a fresh, private operation directory.
type Request struct {
	ProtocolVersion int    `json:"protocolVersion"`
	OperationID     string `json:"operationId"`
	Operation       string `json:"operation"`
	SourceACDPath   string `json:"sourceAcdPath"`
	WorkDirectory   string `json:"workDirectory"`
}

// Result is accepted only alongside the process result and validated artifacts.
// DiagnosticReference names a private log; it must never be rendered as UI copy.
type Result struct {
	ProtocolVersion     int    `json:"protocolVersion"`
	OperationID         string `json:"operationId"`
	Success             bool   `json:"success"`
	OutputRoot          string `json:"outputRoot"`
	FormatVersion       int    `json:"formatVersion"`
	HelperVersion       string `json:"helperVersion"`
	VendorRevision      string `json:"vendorRevision"`
	FailureCode         string `json:"failureCode"`
	DiagnosticReference string `json:"diagnosticReference"`
	SDKCleanupConfirmed bool   `json:"sdkCleanupConfirmed"`
}

// Progress identifies stages without claiming percentage accuracy. Publication
// is an app-owned stage and is never reported by the conversion helper.
type Progress struct {
	ProtocolVersion int    `json:"protocolVersion"`
	OperationID     string `json:"operationId"`
	Stage           string `json:"stage"`
}

// ValidateResult rejects truncated, mismatched or contradictory results. It does
// not authorize publication: repository identity, destination compatibility and
// effective Git attributes must still be established by the app.
func ValidateResult(data []byte, request Request, processSucceeded bool) (Result, error) {
	var result Result
	if len(data) == 0 || len(data) > maxResultBytes {
		return result, errors.New("invalid helper result size")
	}
	if err := requireUniqueFields(data); err != nil {
		return result, err
	}
	// Pointers distinguish explicit false from a missing required boolean.
	var wire struct {
		ProtocolVersion     int    `json:"protocolVersion"`
		OperationID         string `json:"operationId"`
		Success             *bool  `json:"success"`
		OutputRoot          string `json:"outputRoot"`
		FormatVersion       int    `json:"formatVersion"`
		HelperVersion       string `json:"helperVersion"`
		VendorRevision      string `json:"vendorRevision"`
		FailureCode         string `json:"failureCode"`
		DiagnosticReference string `json:"diagnosticReference"`
		SDKCleanupConfirmed *bool  `json:"sdkCleanupConfirmed"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return result, fmt.Errorf("decode helper result: %w", err)
	}
	if decoder.Decode(new(any)) != io.EOF || wire.Success == nil || wire.SDKCleanupConfirmed == nil {
		return result, errors.New("incomplete or multiple helper results")
	}
	if request.ProtocolVersion != Version || request.Operation != "exportExplode" || request.OperationID == "" ||
		wire.ProtocolVersion != Version || wire.OperationID != request.OperationID ||
		wire.HelperVersion != HelperVersion || wire.VendorRevision != VendorRevision {
		return result, errors.New("incompatible helper result identity")
	}
	result = Result{wire.ProtocolVersion, wire.OperationID, *wire.Success, wire.OutputRoot,
		wire.FormatVersion, wire.HelperVersion, wire.VendorRevision, wire.FailureCode,
		wire.DiagnosticReference, *wire.SDKCleanupConfirmed}
	if result.Success != processSucceeded {
		return Result{}, errors.New("helper result contradicts process exit")
	}
	if !result.Success {
		if result.FailureCode == "" || result.OutputRoot != "" || result.FormatVersion != 0 ||
			(result.DiagnosticReference != "" && result.DiagnosticReference != "diagnostics.log") {
			return Result{}, errors.New("invalid helper failure result")
		}
		return result, nil
	}
	if !result.SDKCleanupConfirmed || result.FailureCode != "" || result.DiagnosticReference != "" ||
		result.FormatVersion != FormatVersion || !filepath.IsAbs(request.WorkDirectory) ||
		!samePath(result.OutputRoot, filepath.Join(request.WorkDirectory, "output")) {
		return Result{}, errors.New("invalid helper success result")
	}
	if err := validateOutput(result.OutputRoot); err != nil {
		return Result{}, err
	}
	return result, nil
}

func requireUniqueFields(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return errors.New("helper result must be an object")
	}
	seen := make(map[string]bool)
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] {
			return errors.New("invalid or duplicate helper result field")
		}
		seen[key] = true
		if err := decoder.Decode(new(json.RawMessage)); err != nil {
			return err
		}
	}
	_, err = decoder.Token()
	return err
}

func samePath(left, right string) bool {
	if !filepath.IsAbs(left) || filepath.Clean(left) != left {
		return false
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func requirePhysicalPath(path string) error {
	for part := path; ; part = filepath.Dir(part) {
		info, err := os.Lstat(part)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("helper artifact path contains a link")
		}
		parent := filepath.Dir(part)
		if parent == part {
			return nil
		}
	}
}

func validateOutput(root string) error {
	if err := requirePhysicalPath(root); err != nil {
		return err
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 1 || entries[0].Name() != "RSLogix5000Content" || !entries[0].IsDir() {
		return errors.New("unexpected helper output layout")
	}
	return ValidateContent(filepath.Join(root, "RSLogix5000Content"))
}

// ValidateContent recognizes compatible vendor content without imposing any
// ownership on unrelated siblings in the preview wrapper.
func ValidateContent(content string) error {
	if err := requirePhysicalPath(content); err != nil {
		return err
	}
	err := filepath.WalkDir(content, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 || (!entry.IsDir() && !entry.Type().IsRegular()) {
			return errors.New("helper output contains a link or special file")
		}
		return nil
	})
	if err != nil {
		return err
	}
	document, err := os.Open(filepath.Join(content, "RSLogix5000Content.xml"))
	if err != nil {
		return err
	}
	defer document.Close()
	info, err := document.Stat()
	if err != nil || info.Size() > 16*1024*1024 {
		return errors.New("helper root document exceeds validation limit")
	}
	reader := bufio.NewReader(io.LimitReader(document, 16*1024*1024))
	// XmlWriter's pinned vendor defaults emit a UTF-8 BOM. Accept it without
	// rewriting the generated document or treating it as document content.
	if prefix, _ := reader.Peek(3); bytes.Equal(prefix, []byte{0xef, 0xbb, 0xbf}) {
		_, _ = reader.Discard(3)
	}
	decoder := xml.NewDecoder(reader)
	var startSeen bool
	depth := 0
	for {
		token, err := decoder.Token()
		if err == io.EOF && startSeen {
			break
		}
		if err != nil {
			return errors.New("incomplete helper root document")
		}
		switch element := token.(type) {
		case xml.StartElement:
			if depth == 0 && (startSeen || element.Name.Local != "RSLogix5000Content") {
				return errors.New("invalid helper root document")
			}
			startSeen = true
			depth++
		case xml.EndElement:
			depth--
		case xml.CharData:
			if depth == 0 && strings.TrimSpace(string(element)) != "" {
				return errors.New("unexpected text outside helper root document")
			}
		}
	}
	options, err := os.ReadFile(filepath.Join(content, "export-options.yaml"))
	if err != nil || len(options) > 4096 {
		return errors.New("missing or invalid vendor options")
	}
	// The pinned vendor emits a flat mapping. Accept exactly its selected
	// defaults, without YAML coercion, migration or rewriting generated bytes.
	want := map[string]string{"schema_version": "2", "serialization_format": "Xml",
		"xml_attribute_per_line": "false", "omit_export_date": "true", "unsafe_skip_dependency_check": "false"}
	for _, line := range strings.Split(strings.TrimSpace(string(options)), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
		expected, exists := want[key]
		if !ok || !exists || strings.TrimSpace(value) != expected {
			return errors.New("incompatible vendor options")
		}
		delete(want, key)
	}
	if len(want) != 0 {
		return errors.New("incomplete vendor options")
	}
	return nil
}
