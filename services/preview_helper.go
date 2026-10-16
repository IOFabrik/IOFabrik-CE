package services

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"iofabrik/internal/ldsdkprotocol"
)

// The public artifact contract contains checksums, never private helper source.
//
//go:embed preview-helper-manifest.json
var previewHelperManifest []byte

type previewHelperPayload struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
	Files   []struct {
		Path   string `json:"path"`
		Bytes  int64  `json:"bytes"`
		SHA256 string `json:"sha256"`
	} `json:"files"`
}

func resolvePreviewHelper() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	locations := []string{
		filepath.Join(LocalBinRootPath(), "ldsdk", ldsdkprotocol.HelperVersion),
		filepath.Join(filepath.Dir(executable), "helper"),
	}
	for _, location := range locations {
		if _, err := os.Stat(location); os.IsNotExist(err) {
			continue
		}
		if err := verifyPreviewHelper(location); err != nil {
			return "", err
		}
		return filepath.Join(location, "LDSDK.Helper.exe"), nil
	}
	return "", fmt.Errorf("missing helper payload")
}

func verifyPreviewHelper(root string) error {
	var payload previewHelperPayload
	if err := json.Unmarshal(previewHelperManifest, &payload); err != nil {
		return err
	}
	if payload.Version != ldsdkprotocol.HelperVersion || len(payload.Files) == 0 {
		return fmt.Errorf("incompatible helper manifest")
	}
	if err := previewPhysicalPath(root); err != nil {
		return err
	}
	for _, file := range payload.Files {
		path := filepath.Join(root, filepath.FromSlash(file.Path))
		if !previewWithin(root, path) {
			return fmt.Errorf("unsafe helper manifest")
		}
		if err := previewPhysicalPath(path); err != nil {
			return err
		}
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() != file.Bytes {
			return fmt.Errorf("helper size mismatch")
		}
		hash, err := previewHashFile(path)
		if err != nil {
			return err
		}
		if hash != file.SHA256 {
			return fmt.Errorf("helper checksum mismatch")
		}
	}
	return nil
}
