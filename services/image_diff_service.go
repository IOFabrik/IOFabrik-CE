// Package services provides backend functionality for the IOFabrik application.
// This file contains the ImageDiffService which provides visual image diff
// comparison between git revisions using pixel-level comparison via imgdiff.
package services

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
	"strings"

	// Register image decoders for common formats
	_ "image/gif"
	_ "image/jpeg"

	// External: pixel-level image diff
	"github.com/n7olkachev/imgdiff/pkg/imgdiff"

	// BMP and TIFF support from Go's extended image library
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

// ImageDiffResult contains the result of comparing two image versions.
type ImageDiffResult struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`

	// Base64-encoded images (data only, no data: URL prefix)
	OldImage  string `json:"oldImage,omitempty"`  // Image at old revision
	NewImage  string `json:"newImage,omitempty"`  // Image at new revision (or working tree)
	DiffImage string `json:"diffImage,omitempty"` // imgdiff output highlighting pixel changes

	// MIME type for the original images (based on file extension)
	MimeType string `json:"mimeType"`

	// Metadata
	OldWidth  int   `json:"oldWidth"`
	OldHeight int   `json:"oldHeight"`
	NewWidth  int   `json:"newWidth"`
	NewHeight int   `json:"newHeight"`
	OldSize   int64 `json:"oldSize"` // Bytes of raw image data
	NewSize   int64 `json:"newSize"` // Bytes of raw image data

	// Diff statistics from imgdiff
	DiffPixelCount uint64 `json:"diffPixelCount"`
	TotalPixels    uint64 `json:"totalPixels"`
	IsEqual        bool   `json:"isEqual"`

	// Status: "added", "modified", "deleted"
	Status string `json:"status"`
}

// imageDiffExtensions are the file extensions supported for image diffing.
// SVG is excluded — it's XML text, better served by the text DiffViewer.
var imageDiffExtensions = map[string]bool{
	".png":  true,
	".jpg":  true,
	".jpeg": true,
	".gif":  true,
	".webp": true,
	".bmp":  true,
	".tiff": true,
	".tif":  true,
}

// ImageDiffService provides visual image diff comparison between git revisions.
type ImageDiffService struct {
	runner *CommandRunner
}

// NewImageDiffService creates a new ImageDiffService instance.
func NewImageDiffService() *ImageDiffService {
	return &ImageDiffService{
		runner: NewCommandRunner(),
	}
}

// IsImageFile checks if a file path has a supported image extension for diffing.
// SVG is excluded since it's XML and better handled by text diff.
func (s *ImageDiffService) IsImageFile(filePath string) bool {
	ext := strings.ToLower(filepath.Ext(filePath))
	return imageDiffExtensions[ext]
}

// ImageDiff compares an image file between two revisions (or working tree).
//
// Parameters:
//   - repoPath: absolute path to the git repository root
//   - filePath: path to the image file (relative to repo root or absolute)
//   - oldRevision: commit hash, "HEAD", "HEAD~1", etc. Empty string = file didn't exist (added)
//   - newRevision: commit hash, or empty string = use working tree version
func (s *ImageDiffService) ImageDiff(repoPath, filePath, oldRevision, newRevision string) ImageDiffResult {
	if repoPath == "" {
		return imageDiffError("Repository path is required")
	}
	if filePath == "" {
		return imageDiffError("File path is required")
	}

	// Resolve to repo-relative path for git show
	relPath, err := toRepoRelativePath(repoPath, filePath)
	if err != nil {
		return imageDiffError(err.Error())
	}

	// Determine MIME type from extension
	ext := filepath.Ext(relPath)
	mimeType := mimeTypeFromExt(ext)

	result := ImageDiffResult{
		MimeType: mimeType,
	}

	// Determine status and load images
	hasOld := oldRevision != ""
	hasNew := true

	// Load old image (if revision is specified)
	var oldImgBytes []byte
	var oldImg image.Image
	if hasOld {
		oldImgBytes, err = s.readImageAtRevision(repoPath, relPath, oldRevision)
		if err != nil {
			// Old revision doesn't exist — might be a new file in this commit
			hasOld = false
		} else {
			oldImg, _, err = image.Decode(bytes.NewReader(oldImgBytes))
			if err != nil {
				return imageDiffError(fmt.Sprintf("Failed to decode old image: %s", err.Error()))
			}
		}
	}

	// Load new image
	var newImgBytes []byte
	var newImg image.Image
	if newRevision != "" {
		// Load from a specific revision
		newImgBytes, err = s.readImageAtRevision(repoPath, relPath, newRevision)
		if err != nil {
			hasNew = false
		}
	} else {
		// Load from working tree
		fullPath := filepath.Join(repoPath, relPath)
		newImgBytes, err = os.ReadFile(fullPath)
		if err != nil {
			hasNew = false
		}
	}

	if hasNew && newImgBytes != nil {
		newImg, _, err = image.Decode(bytes.NewReader(newImgBytes))
		if err != nil {
			return imageDiffError(fmt.Sprintf("Failed to decode new image: %s", err.Error()))
		}
	}

	// Determine status
	switch {
	case !hasOld && hasNew:
		result.Status = "added"
	case hasOld && !hasNew:
		result.Status = "deleted"
	case hasOld && hasNew:
		result.Status = "modified"
	default:
		return imageDiffError("Neither old nor new image could be loaded")
	}

	// Encode old image to base64 for transport
	if hasOld && oldImgBytes != nil {
		result.OldImage = base64.StdEncoding.EncodeToString(oldImgBytes)
		result.OldSize = int64(len(oldImgBytes))
		bounds := oldImg.Bounds()
		result.OldWidth = bounds.Dx()
		result.OldHeight = bounds.Dy()
	}

	// Encode new image to base64 for transport
	if hasNew && newImgBytes != nil {
		result.NewImage = base64.StdEncoding.EncodeToString(newImgBytes)
		result.NewSize = int64(len(newImgBytes))
		bounds := newImg.Bounds()
		result.NewWidth = bounds.Dx()
		result.NewHeight = bounds.Dy()
	}

	// Compute pixel diff if both images are available
	if hasOld && hasNew && oldImg != nil && newImg != nil {
		diffResult := s.computeDiff(oldImg, newImg)
		result.DiffImage = diffResult.diffBase64
		result.DiffPixelCount = diffResult.diffPixelCount
		result.IsEqual = diffResult.isEqual
		result.TotalPixels = diffResult.totalPixels
	} else {
		// For added/deleted files, no diff is computed
		result.IsEqual = false
		result.DiffPixelCount = 0
	}

	result.Success = true
	return result
}

// ImageDiffWorking compares the working tree version of an image against HEAD.
// Convenience method for the common case of viewing uncommitted changes.
func (s *ImageDiffService) ImageDiffWorking(repoPath, filePath string) ImageDiffResult {
	return s.ImageDiff(repoPath, filePath, "HEAD", "")
}

// ImageDiffCommit compares an image in a commit against its parent.
// Convenience method for viewing changes introduced by a specific commit.
func (s *ImageDiffService) ImageDiffCommit(repoPath, filePath, commitHash string) ImageDiffResult {
	if commitHash == "" {
		return imageDiffError("Commit hash is required")
	}

	// Check if the commit has a parent
	parentRef := commitHash + "^"
	parentResult := s.runner.RunGit(repoPath, "rev-parse", "--verify", parentRef)

	if !parentResult.Success {
		// No parent — this is likely the first commit; treat old as non-existent (added)
		return s.ImageDiff(repoPath, filePath, "", commitHash)
	}

	return s.ImageDiff(repoPath, filePath, parentRef, commitHash)
}

// diffComputeResult holds the internal diff computation output.
type diffComputeResult struct {
	diffBase64     string
	diffPixelCount uint64
	totalPixels    uint64
	isEqual        bool
}

// computeDiff runs imgdiff on two decoded images and returns the diff result.
func (s *ImageDiffService) computeDiff(oldImg, newImg image.Image) diffComputeResult {
	result := diffComputeResult{}

	// Normalize images to the same size for comparison.
	// imgdiff uses image1.Bounds() to iterate, so if images differ in size
	// we need to composite them onto a common canvas.
	oldBounds := oldImg.Bounds()
	newBounds := newImg.Bounds()

	maxWidth := oldBounds.Dx()
	if newBounds.Dx() > maxWidth {
		maxWidth = newBounds.Dx()
	}
	maxHeight := oldBounds.Dy()
	if newBounds.Dy() > maxHeight {
		maxHeight = newBounds.Dy()
	}

	result.totalPixels = uint64(maxWidth) * uint64(maxHeight)

	// If dimensions differ, composite both onto same-size canvases
	if oldBounds.Dx() != newBounds.Dx() || oldBounds.Dy() != newBounds.Dy() {
		canvas := image.Rect(0, 0, maxWidth, maxHeight)
		oldNormalized := image.NewNRGBA(canvas)
		draw.Draw(oldNormalized, oldBounds.Sub(oldBounds.Min), oldImg, oldBounds.Min, draw.Src)
		newNormalized := image.NewNRGBA(canvas)
		draw.Draw(newNormalized, newBounds.Sub(newBounds.Min), newImg, newBounds.Min, draw.Src)
		oldImg = oldNormalized
		newImg = newNormalized
	}

	// Run imgdiff with DiffImage=true to render the original beneath diff pixels
	diffOut := imgdiff.Diff(oldImg, newImg, &imgdiff.Options{
		Threshold: 0.1,
		DiffImage: true,
	})

	result.isEqual = diffOut.Equal
	result.diffPixelCount = diffOut.DiffPixelsCount

	// Encode diff image as PNG (lossless for accurate diff visualization)
	if diffOut.Image != nil {
		var buf bytes.Buffer
		enc := &png.Encoder{CompressionLevel: png.BestSpeed}
		if err := enc.Encode(&buf, diffOut.Image); err == nil {
			result.diffBase64 = base64.StdEncoding.EncodeToString(buf.Bytes())
		}
	}

	return result
}

// readImageAtRevision extracts raw image bytes from a git revision.
// Uses `git cat-file --filters` to apply smudge filters (including Git LFS),
// falling back to `git show` for older git versions.
func (s *ImageDiffService) readImageAtRevision(repoPath, relPath, revision string) ([]byte, error) {
	objectRef := revision + ":" + relPath

	// Prefer cat-file --filters to resolve LFS pointers
	data, err := s.runner.RunGitRaw(repoPath, "cat-file", "--filters", objectRef)
	if err != nil {
		// Fallback to git show for compatibility
		data, err = s.runner.RunGitRaw(repoPath, "show", objectRef)
		if err != nil {
			return nil, fmt.Errorf("failed to read image at %s: %w", revision, err)
		}
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("empty content at %s:%s", revision, relPath)
	}
	return data, nil
}

// imageDiffError creates an error ImageDiffResult.
func imageDiffError(msg string) ImageDiffResult {
	return ImageDiffResult{
		Success: false,
		Error:   msg,
	}
}
