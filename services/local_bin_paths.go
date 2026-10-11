package services

import (
	"path/filepath"
)

// LocalBinRootPath returns the managed user-level bin directory.
// On Windows this resolves to: %LOCALAPPDATA%\IOFabrik\tools\bin
func LocalBinRootPath() string {
	return GetDataLocationsSnapshot().ToolsBinDir
}

func localManagedGitPathCandidates() []string {
	root := LocalBinRootPath()
	return []string{
		filepath.Join(root, "git", "cmd", "git.exe"),
		filepath.Join(root, "git", "bin", "git.exe"),
	}
}

func localManagedGhPathCandidates() []string {
	root := LocalBinRootPath()
	return []string{
		filepath.Join(root, "gh.exe"),
		filepath.Join(root, "gh", "bin", "gh.exe"),
		filepath.Join(root, "gh", "gh.exe"),
	}
}

func localManagedLfsPathCandidates() []string {
	root := LocalBinRootPath()
	return []string{
		filepath.Join(root, "lfs", "git-lfs.exe"),
		filepath.Join(root, "git-lfs.exe"),
		filepath.Join(root, "git", "cmd", "git-lfs.exe"),
		filepath.Join(root, "git", "mingw64", "bin", "git-lfs.exe"),
		filepath.Join(root, "git", "bin", "git-lfs.exe"),
	}
}

// localManagedPathPrepends returns candidate directories that should be prepended
// to PATH for child processes so local portable binaries are always discoverable.
func localManagedPathPrepends() []string {
	root := LocalBinRootPath()
	return []string{
		root,
		filepath.Join(root, "lfs"),
		filepath.Join(root, "git", "cmd"),
		filepath.Join(root, "git", "bin"),
		filepath.Join(root, "git", "mingw64", "bin"),
		filepath.Join(root, "git", "clangarm64", "bin"),
		filepath.Join(root, "git", "usr", "bin"),
		filepath.Join(root, "gh", "bin"),
		filepath.Join(root, "gh"),
	}
}
