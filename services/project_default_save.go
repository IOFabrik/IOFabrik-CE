package services

import "strings"

// Validate locally at each Save mutation boundary, including direct calls to
// Commit. Discovery belongs to project open/refresh, so offline Saves work.
func (g *GitService) requireSaveReady(repoPath string) OperationResult {
	settings := NewRepositorySettingsService()
	settings.runner = g.runner
	if settings.GetProjectDefaultBranch(repoPath).Availability != ProjectDefaultReady {
		return failedOp("Choose an available default branch in Repository Settings, then save again.")
	}
	head := g.runner.RunGit(repoPath, "symbolic-ref", "--quiet", "HEAD")
	if !head.Success || !strings.HasPrefix(strings.TrimSpace(head.Stdout), "refs/heads/") {
		return failedOp("Switch to a branch or create a branch from this snapshot, then save again.")
	}
	return successOp("")
}
