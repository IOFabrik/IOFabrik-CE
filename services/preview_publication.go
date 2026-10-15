package services

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"iofabrik/internal/ldsdkprotocol"
)

type previewTransaction struct {
	OperationID         string `json:"operationId"`
	Root                string `json:"root"`
	GitDir              string `json:"gitDir"`
	RootID              string `json:"rootId"`
	GitID               string `json:"gitId"`
	RelativeDestination string `json:"relativeDestination"`
	PreviousID          string `json:"previousId"`
	NewID               string `json:"newId"`
	Committed           bool   `json:"committed"`
}

func previewWriteJSON(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".preview-record-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), path)
}

func previewJournalPath(state, root string) string {
	return filepath.Join(state, "transactions", previewPathKey(root)+".json")
}

func previewStagePath(root, id string) string {
	return filepath.Join(filepath.Dir(root), ".iofabrik-preview-"+id)
}

// Recovery uses recorded filesystem identities, never a marker in tracked
// output. Until its journal is removed, ordinary app mutations remain blocked.
func recoverPreviewPublication(state, root string) error {
	journal := previewJournalPath(state, root)
	data, err := os.ReadFile(journal)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(data) > 16384 {
		return fmt.Errorf("invalid publication record")
	}
	var record previewTransaction
	if err := json.Unmarshal(data, &record); err != nil {
		return err
	}
	if record.Root != root || !validPreviewOperationID(record.OperationID) {
		return fmt.Errorf("invalid publication identity")
	}
	destination := filepath.Join(root, record.RelativeDestination)
	if !previewWithin(root, destination) || filepath.Ext(destination) != ".preview" {
		return fmt.Errorf("invalid publication destination")
	}
	if err := previewPhysicalPath(filepath.Dir(destination)); err != nil {
		return err
	}
	rootID, err := previewFileIdentity(root)
	if err != nil || rootID != record.RootID {
		return fmt.Errorf("project identity changed")
	}
	gitID, err := previewFileIdentity(record.GitDir)
	if err != nil || gitID != record.GitID {
		return fmt.Errorf("project storage changed")
	}
	runner := NewCommandRunner()
	runner.previewOwner = true
	currentGitDir, err := gitDirPath(runner, root)
	if err != nil || currentGitDir != record.GitDir {
		return fmt.Errorf("project storage location changed")
	}
	stage := previewStagePath(root, record.OperationID)
	if err := previewPhysicalPath(stage); err != nil {
		return err
	}
	liveID, liveErr := previewFileIdentity(destination)
	if liveErr != nil && !os.IsNotExist(liveErr) {
		return liveErr
	}
	previous := filepath.Join(stage, "previous")
	previousID, previousErr := previewFileIdentity(previous)
	if previousErr != nil && !os.IsNotExist(previousErr) {
		return previousErr
	}
	if record.Committed {
		if liveID != record.NewID {
			return fmt.Errorf("completed output was replaced externally")
		}
	} else {
		if liveID == record.NewID {
			// Keep the complete replacement available while restoring the prior
			// complete wrapper. Both renames stay on the destination filesystem.
			if err := os.Rename(destination, filepath.Join(stage, "new")); err != nil {
				return err
			}
			liveID = ""
		}
		if record.PreviousID != "" {
			if liveID == "" && previousID == record.PreviousID {
				if err := os.Rename(previous, destination); err != nil {
					return err
				}
			} else if liveID != record.PreviousID {
				return fmt.Errorf("previous output ownership changed")
			}
		} else if liveID != "" {
			return fmt.Errorf("destination was created externally")
		}
	}
	// Remove the journal before disposable staging; a crash during cleanup
	// leaves only an unreferenced private staging directory, never partial output.
	if err := os.Remove(journal); err != nil {
		return err
	}
	_ = os.RemoveAll(stage)
	return nil
}

func verifyPreviewAttributes(runner *CommandRunner, root, destination, staged, shadow string) error {
	workTree := root
	if shadow != "" {
		workTree = shadow
		if err := os.MkdirAll(shadow, 0700); err != nil {
			return err
		}
		parent := filepath.Dir(destination)
		for {
			rel, err := filepath.Rel(root, parent)
			if err != nil {
				return err
			}
			attrs := filepath.Join(parent, ".gitattributes")
			if _, err := os.Lstat(attrs); err == nil {
				if err := previewPhysicalPath(attrs); err != nil {
					return err
				}
				target := filepath.Join(shadow, rel, ".gitattributes")
				if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
					return err
				}
				if err := copyFile(attrs, target); err != nil {
					return err
				}
			} else if !os.IsNotExist(err) {
				return err
			}
			if parent == root {
				break
			}
			parent = filepath.Dir(parent)
		}
		rel, _ := filepath.Rel(root, destination)
		attrs := filepath.Join(shadow, rel, ".gitattributes")
		if err := os.MkdirAll(filepath.Dir(attrs), 0700); err != nil {
			return err
		}
		if err := copyFile(filepath.Join(staged, ".gitattributes"), attrs); err != nil {
			return err
		}
	}
	relative, _ := filepath.Rel(root, destination)
	paths := []string{filepath.ToSlash(filepath.Join(relative, ".gitattributes"))}
	if err := filepath.WalkDir(filepath.Join(staged, "RSLogix5000Content"), func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			rel, _ := filepath.Rel(staged, path)
			paths = append(paths, filepath.ToSlash(filepath.Join(relative, rel)))
		}
		return nil
	}); err != nil {
		return err
	}
	result := runner.RunGitWithStdin(root, strings.Join(paths, "\x00")+"\x00",
		"--work-tree="+workTree, "check-attr", "-z", "--stdin", "text", "eol", "filter", "working-tree-encoding", "ident", "diff")
	if !result.Success {
		return fmt.Errorf("cannot check generated attributes")
	}
	want := map[string]string{"text": "unset", "eol": "unset", "filter": "unset", "working-tree-encoding": "unset", "ident": "unset", "diff": "set"}
	fields := strings.Split(strings.TrimSuffix(result.Stdout, "\x00"), "\x00")
	if len(fields) != len(paths)*len(want)*3 {
		return fmt.Errorf("incomplete generated attribute policy")
	}
	seen := make(map[string]bool)
	allowedPaths := make(map[string]bool)
	for _, path := range paths {
		allowedPaths[path] = true
	}
	for i := 0; i < len(fields); i += 3 {
		path, attr, value := fields[i], fields[i+1], fields[i+2]
		key := path + "\x00" + attr
		if !allowedPaths[path] || seen[key] || want[attr] != value {
			return fmt.Errorf("generated attributes are overridden")
		}
		seen[key] = true
	}
	return nil
}

func (s *PreviewGenerationService) publishPreview(before previewContext, output, id string) (err error) {
	if filepath.Dir(before.Root) == before.Root {
		return fmt.Errorf("cannot stage a project at the filesystem root")
	}
	stage := previewStagePath(before.Root, id)
	if err := os.Mkdir(stage, 0700); err != nil {
		return err
	}
	journalWritten := false
	defer func() {
		if !journalWritten {
			_ = os.RemoveAll(stage)
		}
		if err != nil && journalWritten {
			if recoveryErr := recoverPreviewPublication(s.stateDir, before.Root); recoveryErr != nil {
				err = fmt.Errorf("publication recovery requires attention: %w", recoveryErr)
			}
		}
	}()
	newRoot := filepath.Join(stage, "new")
	if err := os.Mkdir(newRoot, 0700); err != nil {
		return err
	}
	if before.DestinationID != "" {
		entries, err := os.ReadDir(before.Destination)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if entry.Name() == "RSLogix5000Content" || entry.Name() == ".gitattributes" {
				continue
			}
			source := filepath.Join(before.Destination, entry.Name())
			target := filepath.Join(newRoot, entry.Name())
			if entry.IsDir() {
				err = copyPreviewTree(source, target)
			} else {
				err = copyFile(source, target)
			}
			if err != nil {
				return err
			}
		}
	}
	if err := copyPreviewTree(filepath.Join(output, "RSLogix5000Content"), filepath.Join(newRoot, "RSLogix5000Content")); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(newRoot, ".gitattributes"), []byte(previewAttributes), 0600); err != nil {
		return err
	}
	if err := ldsdkprotocol.ValidateContent(filepath.Join(newRoot, "RSLogix5000Content")); err != nil {
		return err
	}
	if err := verifyPreviewAttributes(s.runner, before.Root, before.Destination, newRoot, filepath.Join(stage, "attributes")); err != nil {
		return fmt.Errorf("attribute policy: %w", err)
	}
	if err := setPreviewHidden(newRoot); err != nil {
		return err
	}
	after, err := capturePreviewContext(s.runner, before.Root, before.Destination)
	if err != nil || after != before {
		return fmt.Errorf("project context changed during generation")
	}
	if err := validatePreviewDestination(before.Destination); err != nil {
		return err
	}
	newID, err := previewFileIdentity(newRoot)
	if err != nil {
		return err
	}
	rel, _ := filepath.Rel(before.Root, before.Destination)
	record := previewTransaction{OperationID: id, Root: before.Root, GitDir: before.GitDir, RootID: before.RootID, GitID: before.GitID,
		RelativeDestination: rel, PreviousID: before.DestinationID, NewID: newID}
	journal := previewJournalPath(s.stateDir, before.Root)
	if err := previewWriteJSON(journal, record); err != nil {
		return err
	}
	journalWritten = true
	if s.publicationFault != nil {
		if err := s.publicationFault("prepared"); err != nil {
			return err
		}
	}
	if before.DestinationID != "" {
		if err := os.Rename(before.Destination, filepath.Join(stage, "previous")); err != nil {
			return err
		}
	}
	if s.publicationFault != nil {
		if err := s.publicationFault("moved-previous"); err != nil {
			return err
		}
	}
	if err := os.Rename(newRoot, before.Destination); err != nil {
		return err
	}
	if s.publicationFault != nil {
		if err := s.publicationFault("installed"); err != nil {
			return err
		}
	}
	if err := setPreviewHidden(before.Destination); err != nil {
		return err
	}
	if err := verifyPreviewAttributes(s.runner, before.Root, before.Destination, before.Destination, ""); err != nil {
		return err
	}
	record.Committed = true
	if err := previewWriteJSON(journal, record); err != nil {
		return err
	}
	return recoverPreviewPublication(s.stateDir, before.Root)
}
