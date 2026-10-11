// prepare-windows-tools downloads verified release archives on the build machine.
// The resulting directory is required input to NSIS; the desktop app never downloads tools.
package main

import (
	"archive/zip"
	"crypto/sha256"
	"debug/pe"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed manifest.json
var manifestJSON []byte

type artifact struct {
	Tool       string `json:"tool"`
	URL        string `json:"url"`
	SHA256     string `json:"sha256"`
	Executable string `json:"executable"`
}

func main() {
	arch := flag.String("arch", "amd64", "Windows architecture: amd64 or arm64")
	output := flag.String("output", "", "output directory (defaults to build/deps/windows-ARCH)")
	offline := flag.Bool("offline", false, "use only cached, checksum-verified archives")
	flag.Parse()
	if *output == "" {
		*output = filepath.Join("build", "deps", "windows-"+*arch)
	}
	if err := prepare(*arch, *output, *offline); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func prepare(arch, output string, offline bool) error {
	var manifest map[string][]artifact
	if err := json.Unmarshal(manifestJSON, &manifest); err != nil {
		return err
	}
	artifacts, ok := manifest[arch]
	if !ok {
		return fmt.Errorf("unsupported Windows architecture %q", arch)
	}
	parent := filepath.Dir(output)
	if err := os.MkdirAll(parent, 0755); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(parent, ".windows-tools-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	cache := filepath.Join(parent, ".cache")
	if err := os.MkdirAll(cache, 0755); err != nil {
		return err
	}
	for _, a := range artifacts {
		archive := filepath.Join(cache, filepath.Base(a.URL))
		if err := fetchArchive(a, archive, offline); err != nil {
			return err
		}
		raw := filepath.Join(stage, ".extract")
		if err := extractArchive(archive, raw); err != nil {
			return err
		}
		var exe string
		err := filepath.WalkDir(raw, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !d.IsDir() && filepath.Base(path) == filepath.Base(a.Executable) {
				// Git may include several helpers named git.exe; only its cmd entry is portable.
				if a.Tool == "git" && filepath.Base(filepath.Dir(path)) != "cmd" {
					return nil
				}
				if exe != "" {
					return fmt.Errorf("multiple entry executables for %s", a.Tool)
				}
				exe = path
			}
			return nil
		})
		if err != nil {
			return err
		}
		if exe == "" {
			return fmt.Errorf("%s missing from %s", a.Executable, a.URL)
		}
		root := filepath.Dir(exe)
		if a.Tool == "git" || a.Tool == "gh" {
			root = filepath.Dir(root)
		}
		dest := filepath.Join(stage, a.Tool)
		if err := os.Rename(root, dest); err != nil {
			return err
		}
		if err := os.RemoveAll(raw); err != nil {
			return err
		}
		if err := validatePE(filepath.Join(dest, filepath.FromSlash(a.Executable)), arch); err != nil {
			return err
		}
	}
	if err := os.WriteFile(filepath.Join(stage, "bundle.nsh"), []byte(fmt.Sprintf("!define IOFABRIK_TOOLS_ARCH %q\n", arch)), 0644); err != nil {
		return err
	}
	// Keep the archive hashes and source URLs with the installed tools for diagnostics.
	if err := os.WriteFile(filepath.Join(stage, "manifest.json"), manifestJSON, 0644); err != nil {
		return err
	}
	if err := validateBundle(stage); err != nil {
		return err
	}
	// Publish only after every archive and executable passes validation.
	if err := os.RemoveAll(output); err != nil {
		return err
	}
	if err := os.Rename(stage, output); err != nil {
		return err
	}
	fmt.Printf("Verified offline Windows %s tools: %s\n", arch, output)
	return nil
}

func fetchArchive(a artifact, dest string, offline bool) error {
	if err := verifyHash(dest, a.SHA256); err == nil {
		return nil
	}
	if offline {
		return fmt.Errorf("verified cached archive unavailable: %s", dest)
	}
	fmt.Printf("Downloading %s\n", a.URL)
	client := &http.Client{Timeout: 15 * time.Minute}
	response, err := client.Get(a.URL)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", a.URL, response.StatusCode)
	}
	temp, err := os.CreateTemp(filepath.Dir(dest), ".download-")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	_, copyErr := io.Copy(temp, response.Body)
	closeErr := temp.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if err := verifyHash(temp.Name(), a.SHA256); err != nil {
		return err
	}
	// Windows rename does not replace existing files.
	if err := os.Remove(dest); err != nil && !os.IsNotExist(err) {
		return err
	}
	return os.Rename(temp.Name(), dest)
}

func verifyHash(path, expected string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != expected {
		return fmt.Errorf("SHA256 mismatch: %s", path)
	}
	return nil
}

func extractArchive(path, dest string) error {
	r, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, entry := range r.File {
		name := strings.ReplaceAll(entry.Name, "\\", "/")
		rel := filepath.FromSlash(name)
		if !filepath.IsLocal(rel) || strings.Contains(name, ":") || entry.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("unsafe archive entry %q", name)
		}
		target := filepath.Join(dest, rel)
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		src, err := entry.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
		if err != nil {
			src.Close()
			return err
		}
		_, copyErr := io.Copy(out, src)
		closeErr := out.Close()
		src.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

func validatePE(path, arch string) error {
	f, err := pe.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	want := uint16(pe.IMAGE_FILE_MACHINE_AMD64)
	if arch == "arm64" {
		want = pe.IMAGE_FILE_MACHINE_ARM64
	}
	if f.Machine != want {
		return fmt.Errorf("wrong executable architecture: %s", path)
	}
	return nil
}

func validateBundle(root string) error {
	for _, rel := range []string{"git/cmd/git.exe", "git/usr/bin/sh.exe", "gh/bin/gh.exe", "lfs/git-lfs.exe"} {
		info, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return err
		}
		if info.IsDir() || info.Size() == 0 {
			return fmt.Errorf("missing tool component: %s", rel)
		}
	}
	return nil
}
