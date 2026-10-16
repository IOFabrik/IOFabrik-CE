package ldsdkprotocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func completeResult(t *testing.T) (Request, Result) {
	t.Helper()
	work := t.TempDir()
	root := filepath.Join(work, "output")
	content := filepath.Join(root, "RSLogix5000Content")
	if err := os.MkdirAll(content, 0700); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{
		"RSLogix5000Content.xml": `<?xml version="1.0"?><RSLogix5000Content><Controller Name="Example"/></RSLogix5000Content>`,
		"export-options.yaml":    "schema_version: 2\nserialization_format: Xml\nxml_attribute_per_line: false\nomit_export_date: true\nunsafe_skip_dependency_check: false\n",
	} {
		if err := os.WriteFile(filepath.Join(content, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return Request{Version, "561feb87-cc9f-4615-aa3d-6e0743521078", "exportExplode", filepath.Join(work, "Example.ACD"), work},
		Result{Version, "561feb87-cc9f-4615-aa3d-6e0743521078", true, root, FormatVersion, HelperVersion, VendorRevision, "", "", true}
}

func marshal(t *testing.T, result Result) []byte {
	t.Helper()
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestCompleteResult(t *testing.T) {
	request, result := completeResult(t)
	got, err := ValidateResult(marshal(t, result), request, true)
	if err != nil || got != result {
		t.Fatalf("got %+v, error %v", got, err)
	}
}

func TestAcceptsVendorUTF8BOM(t *testing.T) {
	request, result := completeResult(t)
	path := filepath.Join(result.OutputRoot, "RSLogix5000Content", "RSLogix5000Content.xml")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append([]byte{0xef, 0xbb, 0xbf}, data...), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateResult(marshal(t, result), request, true); err != nil {
		t.Fatal(err)
	}
}

func TestRejectsUntrustedSuccess(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*Result)
	}{
		{"protocol", func(r *Result) { r.ProtocolVersion++ }},
		{"operation", func(r *Result) { r.OperationID = "different" }},
		{"helper", func(r *Result) { r.HelperVersion = "newer" }},
		{"vendor", func(r *Result) { r.VendorRevision = "different" }},
		{"format", func(r *Result) { r.FormatVersion++ }},
		{"failure and success", func(r *Result) { r.FailureCode = "exportFailed" }},
		{"cleanup", func(r *Result) { r.SDKCleanupConfirmed = false }},
		{"outside operation", func(r *Result) { r.OutputRoot = filepath.Dir(r.OutputRoot) }},
		{"diagnostic traversal", func(r *Result) { r.DiagnosticReference = "../other.log" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request, result := completeResult(t)
			tc.change(&result)
			if _, err := ValidateResult(marshal(t, result), request, true); err == nil {
				t.Fatal("accepted untrusted success")
			}
		})
	}
}

func TestRejectsInvalidArtifacts(t *testing.T) {
	for _, tc := range []string{"missing root", "truncated root", "wrong root", "multiple roots", "custom options", "old format", "unsafe bypass", "extra file", "symlink"} {
		t.Run(tc, func(t *testing.T) {
			request, result := completeResult(t)
			root := filepath.Join(result.OutputRoot, "RSLogix5000Content", "RSLogix5000Content.xml")
			options := filepath.Join(filepath.Dir(root), "export-options.yaml")
			var err error
			switch tc {
			case "missing root":
				err = os.Remove(root)
			case "truncated root":
				err = os.WriteFile(root, []byte("<RSLogix5000Content>"), 0600)
			case "wrong root":
				err = os.WriteFile(root, []byte("<Different/>"), 0600)
			case "multiple roots":
				err = os.WriteFile(root, []byte("<RSLogix5000Content/><Other/>"), 0600)
			case "custom options", "old format", "unsafe bypass":
				data, readErr := os.ReadFile(options)
				if readErr != nil {
					t.Fatal(readErr)
				}
				text := string(data)
				if tc == "custom options" {
					text = strings.Replace(text, "omit_export_date: true", "omit_export_date: false", 1)
				}
				if tc == "old format" {
					text = strings.Replace(text, "schema_version: 2", "schema_version: 1", 1)
				}
				if tc == "unsafe bypass" {
					text = strings.Replace(text, "unsafe_skip_dependency_check: false", "unsafe_skip_dependency_check: true", 1)
				}
				err = os.WriteFile(options, []byte(text), 0600)
			case "extra file":
				err = os.WriteFile(filepath.Join(result.OutputRoot, "export.L5X"), []byte("private"), 0600)
			case "symlink":
				err = os.Symlink(root, filepath.Join(filepath.Dir(root), "linked.xml"))
				if err != nil {
					t.Skipf("symlink permission unavailable: %v", err)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := ValidateResult(marshal(t, result), request, true); err == nil {
				t.Fatal("accepted invalid artifacts")
			}
		})
	}
}

func TestRejectsMalformedOrIncompleteResults(t *testing.T) {
	request, result := completeResult(t)
	valid := string(marshal(t, result))
	for _, data := range []string{
		"", "{", valid[:len(valid)-1], valid + valid,
		strings.Replace(valid, `"success":true,`, "", 1),
		strings.Replace(valid, `"sdkCleanupConfirmed":true`, `"sdkCleanupConfirmed":null`, 1),
		strings.Replace(valid, `"success":true`, `"success":true,"unexpected":1`, 1),
		strings.Replace(valid, `"success":true`, `"success":true,"success":false`, 1),
		strings.Repeat(" ", maxResultBytes+1),
	} {
		if _, err := ValidateResult([]byte(data), request, true); err == nil {
			t.Fatal("accepted malformed result")
		}
	}
}

// Optional Windows interoperability check against an actual helper operation.
// Test artifacts and sample contents remain outside application source control.
func TestHelperArtifactIntegration(t *testing.T) {
	work := os.Getenv("LDSDK_TEST_OPERATION")
	if work == "" {
		t.Skip("set LDSDK_TEST_OPERATION to a completed Windows helper operation")
	}
	data, err := os.ReadFile(filepath.Join(work, "request.json"))
	if err != nil {
		t.Fatal(err)
	}
	var request Request
	if err := json.Unmarshal(data, &request); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(filepath.Join(work, "result.json"))
	if err != nil {
		t.Fatal(err)
	}
	result, err := ValidateResult(data, request, true)
	if err != nil || !result.Success {
		t.Fatalf("actual helper result was rejected: %v", err)
	}
}

func TestRequiresMatchingProcessExit(t *testing.T) {
	request, result := completeResult(t)
	if _, err := ValidateResult(marshal(t, result), request, false); err == nil {
		t.Fatal("accepted success after process failure")
	}
	result.Success = false
	result.OutputRoot = ""
	result.FormatVersion = 0
	result.FailureCode = "exportFailed"
	result.DiagnosticReference = "diagnostics.log"
	result.SDKCleanupConfirmed = false
	if _, err := ValidateResult(marshal(t, result), request, true); err == nil {
		t.Fatal("accepted failure with success exit")
	}
	if got, err := ValidateResult(marshal(t, result), request, false); err != nil || got.Success {
		t.Fatalf("rejected structured failure: %v", err)
	}
}
