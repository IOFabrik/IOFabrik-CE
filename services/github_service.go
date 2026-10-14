// Package services provides backend functionality for the IOFabrik application.
// This file contains the GitHubService which wraps GitHub CLI (gh) operations.
package services

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// GitHubService provides GitHub CLI (gh) operations
type GitHubService struct {
	runner *CommandRunner

	// Auth process tracking
	authMu      sync.Mutex
	authAttempt *githubAuthAttempt
}

// NewGitHubService creates a new GitHubService instance
func NewGitHubService() *GitHubService {
	return &GitHubService{
		runner: NewCommandRunner(),
	}
}

// ServiceShutdown stops and reaps an outstanding sign-in when the app closes.
func (g *GitHubService) ServiceShutdown() error {
	g.AuthLoginCancel()
	return nil
}

// ============================================================================
// Types
// ============================================================================

// GitHubAuthStatus represents the authentication status for GitHub
type GitHubAuthStatus struct {
	LoggedIn    bool                         `json:"loggedIn"`
	Username    string                       `json:"username,omitempty"`
	AccountType string                       `json:"accountType,omitempty"` // "user" or "org"
	Protocol    string                       `json:"protocol,omitempty"`    // "https" or "ssh"
	Host        string                       `json:"host,omitempty"`        // e.g., "github.com"
	Token       string                       `json:"token,omitempty"`       // Masked or partial token
	Scopes      string                       `json:"scopes,omitempty"`      // Token scopes
	Error       string                       `json:"error,omitempty"`
	ErrorCode   GitHubChangeRequestErrorCode `json:"errorCode,omitempty"`
}

// GitHubChangeRequestErrorCode is the stable error contract for Change Requests.
type GitHubChangeRequestErrorCode string

const (
	GitHubChangeRequestErrorGHUnavailable         GitHubChangeRequestErrorCode = "gh_unavailable"
	GitHubChangeRequestErrorAuthRequired          GitHubChangeRequestErrorCode = "auth_required"
	GitHubChangeRequestErrorHostUnsupported       GitHubChangeRequestErrorCode = "host_unsupported"
	GitHubChangeRequestErrorOriginMissing         GitHubChangeRequestErrorCode = "origin_missing"
	GitHubChangeRequestErrorOriginNotGitHub       GitHubChangeRequestErrorCode = "origin_not_github"
	GitHubChangeRequestErrorRepositoryUnresolved  GitHubChangeRequestErrorCode = "repository_unresolved"
	GitHubChangeRequestErrorPermissionDenied      GitHubChangeRequestErrorCode = "permission_denied"
	GitHubChangeRequestErrorNetworkUnavailable    GitHubChangeRequestErrorCode = "network_unavailable"
	GitHubChangeRequestErrorRateLimited           GitHubChangeRequestErrorCode = "rate_limited"
	GitHubChangeRequestErrorBranchNotSynced       GitHubChangeRequestErrorCode = "branch_not_synced"
	GitHubChangeRequestErrorDuplicateRequest      GitHubChangeRequestErrorCode = "duplicate_request"
	GitHubChangeRequestErrorSnapshotUnavailable   GitHubChangeRequestErrorCode = "snapshot_unavailable"
	GitHubChangeRequestErrorSnapshotStale         GitHubChangeRequestErrorCode = "snapshot_stale"
	GitHubChangeRequestErrorSnapshotUnsupported   GitHubChangeRequestErrorCode = "snapshot_unsupported"
	GitHubChangeRequestErrorContentTooLarge       GitHubChangeRequestErrorCode = "content_too_large"
	GitHubChangeRequestErrorContentLFSUnavailable GitHubChangeRequestErrorCode = "content_lfs_unavailable"
	GitHubChangeRequestErrorFilesTruncated        GitHubChangeRequestErrorCode = "files_truncated"
	GitHubChangeRequestErrorInternal              GitHubChangeRequestErrorCode = "internal_error"
)

type GitHubChangeAuthor struct {
	Login string `json:"login"`
	Name  string `json:"name,omitempty"`
}

type GitHubChangeReviewer struct {
	Login string `json:"login"`
	Name  string `json:"name,omitempty"`
}

type GitHubChangeRequest struct {
	Number            int                    `json:"number"`
	Title             string                 `json:"title"`
	Body              string                 `json:"body,omitempty"`
	URL               string                 `json:"url"`
	State             string                 `json:"state"`
	IsDraft           bool                   `json:"isDraft"`
	Author            GitHubChangeAuthor     `json:"author"`
	HeadRefName       string                 `json:"headRefName"`
	HeadRefOID        string                 `json:"headRefOid"`
	BaseRefName       string                 `json:"baseRefName"`
	BaseRefOID        string                 `json:"baseRefOid"`
	ReviewDecision    string                 `json:"reviewDecision"`
	MergeStateStatus  string                 `json:"mergeStateStatus"`
	IsCrossRepository bool                   `json:"isCrossRepository"`
	CreatedAt         string                 `json:"createdAt"`
	UpdatedAt         string                 `json:"updatedAt"`
	Reviewers         []GitHubChangeReviewer `json:"reviewers"`
}

type GitHubChangeRequestFile struct {
	Path         string `json:"path"`
	PreviousPath string `json:"previousPath,omitempty"`
	Status       string `json:"status"`
	Additions    int    `json:"additions"`
	Deletions    int    `json:"deletions"`
}

type GitHubChangeRequestRepository struct {
	NameWithOwner string `json:"nameWithOwner"`
	DefaultBranch string `json:"defaultBranch"`
	URL           string `json:"url"`
}

type GitHubChangeRequestRepositoryResult struct {
	Success    bool                          `json:"success"`
	Repository GitHubChangeRequestRepository `json:"repository,omitempty"`
	Message    string                        `json:"message,omitempty"`
	Error      string                        `json:"error,omitempty"`
	ErrorCode  GitHubChangeRequestErrorCode  `json:"errorCode"`
}

type GitHubChangeRequestListResult struct {
	Success              bool                          `json:"success"`
	Repository           GitHubChangeRequestRepository `json:"repository,omitempty"`
	ChangeRequests       []GitHubChangeRequest         `json:"changeRequests"`
	OmittedExternalCount int                           `json:"omittedExternalCount"`
	MayHaveMore          bool                          `json:"mayHaveMore"`
	Message              string                        `json:"message,omitempty"`
	Error                string                        `json:"error,omitempty"`
	ErrorCode            GitHubChangeRequestErrorCode  `json:"errorCode"`
}

type GitHubAuthenticatedUser struct {
	Login string `json:"login"`
	ID    string `json:"id"`
	Type  string `json:"type"`
	Name  string `json:"name,omitempty"`
}

type GitHubAuthenticatedUserResult struct {
	Success   bool                         `json:"success"`
	User      GitHubAuthenticatedUser      `json:"user,omitempty"`
	Message   string                       `json:"message,omitempty"`
	Error     string                       `json:"error,omitempty"`
	ErrorCode GitHubChangeRequestErrorCode `json:"errorCode"`
}

type GitHubChangeRequestFilesResult struct {
	Success     bool                         `json:"success"`
	Files       []GitHubChangeRequestFile    `json:"files"`
	TotalFiles  int                          `json:"totalFiles"`
	IsTruncated bool                         `json:"isTruncated"`
	Message     string                       `json:"message,omitempty"`
	Error       string                       `json:"error,omitempty"`
	ErrorCode   GitHubChangeRequestErrorCode `json:"errorCode"`
}

type GitHubChangeRequestDetailResult struct {
	Success       bool                         `json:"success"`
	ChangeRequest GitHubChangeRequest          `json:"changeRequest,omitempty"`
	TotalFiles    int                          `json:"totalFiles"`
	Message       string                       `json:"message,omitempty"`
	Error         string                       `json:"error,omitempty"`
	ErrorCode     GitHubChangeRequestErrorCode `json:"errorCode"`
}

// GitHubChangeRequestBranch is a target-branch option for the create dialog.
type GitHubChangeRequestBranch struct {
	Name      string `json:"name"`
	IsDefault bool   `json:"isDefault"`
}

// GitHubChangeRequestTargetsResult reports the selectable target branches and
// the repository default that the create dialog should preselect.
type GitHubChangeRequestTargetsResult struct {
	Success       bool                         `json:"success"`
	Branches      []GitHubChangeRequestBranch  `json:"branches"`
	DefaultBranch string                       `json:"defaultBranch"`
	Message       string                       `json:"message,omitempty"`
	Error         string                       `json:"error,omitempty"`
	ErrorCode     GitHubChangeRequestErrorCode `json:"errorCode"`
}

// GitHubFindChangeRequestResult reports whether an open Change Request already
// exists for a source branch. Found is false when the branch has none.
type GitHubFindChangeRequestResult struct {
	Success       bool                         `json:"success"`
	Found         bool                         `json:"found"`
	ChangeRequest GitHubChangeRequest          `json:"changeRequest,omitempty"`
	Message       string                       `json:"message,omitempty"`
	Error         string                       `json:"error,omitempty"`
	ErrorCode     GitHubChangeRequestErrorCode `json:"errorCode"`
}

// GitHubCreateChangeRequestOptions carries the create dialog's inputs.
type GitHubCreateChangeRequestOptions struct {
	SourceBranch string `json:"sourceBranch"`
	TargetBranch string `json:"targetBranch"`
	Title        string `json:"title"`
	Body         string `json:"body"`
}

// GitHubCreateChangeRequestResult reports the outcome of creating a request.
// When IsDuplicate is true, ChangeRequest is the existing open request the user
// should be routed to instead of a newly created one.
type GitHubCreateChangeRequestResult struct {
	Success       bool                         `json:"success"`
	ChangeRequest GitHubChangeRequest          `json:"changeRequest,omitempty"`
	URL           string                       `json:"url,omitempty"`
	IsDuplicate   bool                         `json:"isDuplicate"`
	Message       string                       `json:"message,omitempty"`
	Error         string                       `json:"error,omitempty"`
	ErrorCode     GitHubChangeRequestErrorCode `json:"errorCode"`
}

// GitHubRepo represents a GitHub repository
type GitHubRepo struct {
	Name            string `json:"name"`
	FullName        string `json:"fullName"` // owner/repo format
	Description     string `json:"description"`
	URL             string `json:"url"`
	SSHURL          string `json:"sshUrl"`
	CloneURL        string `json:"cloneUrl"`
	Private         bool   `json:"private"`
	Fork            bool   `json:"fork"`
	Archived        bool   `json:"archived"`
	DefaultBranch   string `json:"defaultBranch"`
	Language        string `json:"language"`
	StargazersCount int    `json:"stargazersCount"`
	ForksCount      int    `json:"forksCount"`
	UpdatedAt       string `json:"updatedAt"`
	CreatedAt       string `json:"createdAt"`
}

// GitHubRepoListResult represents the result of listing repositories
type GitHubRepoListResult struct {
	Success bool         `json:"success"`
	Repos   []GitHubRepo `json:"repos"`
	Error   string       `json:"error,omitempty"`
}

// GitHubAuthResult represents the result of an auth operation
type GitHubAuthResult struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
	Error   string `json:"error,omitempty"`
}

// GitHubDeviceFlowResult represents the device flow authentication state
type GitHubDeviceFlowResult struct {
	Cancelled       bool   `json:"cancelled,omitempty"`
	Success         bool   `json:"success"`
	UserCode        string `json:"userCode,omitempty"`        // The one-time code user needs to enter
	VerificationURL string `json:"verificationUrl,omitempty"` // URL to visit for authentication
	Error           string `json:"error,omitempty"`
}

// GitHubRepoCreateOptions contains options for creating a new repository
type GitHubRepoCreateOptions struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Private     bool   `json:"private"`
	Clone       bool   `json:"clone"`     // Clone the repo after creation
	ClonePath   string `json:"clonePath"` // Path to clone to (if Clone is true)
	AddReadme   bool   `json:"addReadme"` // Initialize with README
	GitIgnore   string `json:"gitIgnore"` // .gitignore template name
	License     string `json:"license"`   // License template name
}

// GitHubRepoCreateResult represents the result of creating a repository
type GitHubRepoCreateResult struct {
	Success  bool       `json:"success"`
	Repo     GitHubRepo `json:"repo,omitempty"`
	CloneDir string     `json:"cloneDir,omitempty"` // Local path if cloned
	Error    string     `json:"error,omitempty"`
}

// GitHubCloneResult represents the result of cloning a repository
type GitHubCloneResult struct {
	Success  bool   `json:"success"`
	CloneDir string `json:"cloneDir,omitempty"` // Local path where repo was cloned
	Error    string `json:"error,omitempty"`
}

// GitHubOrganization represents a GitHub organization
type GitHubOrganization struct {
	Login       string `json:"login"`       // Organization slug/name
	Name        string `json:"name"`        // Display name
	Description string `json:"description"` // Organization description
}

// GitHubOrganizationsResult represents the result of listing organizations
type GitHubOrganizationsResult struct {
	Success       bool                 `json:"success"`
	Username      string               `json:"username"`      // The authenticated user's username
	Organizations []GitHubOrganization `json:"organizations"` // Organizations the user belongs to
	Error         string               `json:"error,omitempty"`
}

// ============================================================================
// CLI Detection
// ============================================================================

// IsGHInstalled checks if the GitHub CLI (gh) is installed and available
func (g *GitHubService) IsGHInstalled() bool {
	result := g.runner.Run("", GhPath(), "--version")
	return result.Success
}

// GetGHVersion returns the installed GitHub CLI version
func (g *GitHubService) GetGHVersion() string {
	result := g.runner.Run("", GhPath(), "--version")
	if !result.Success {
		return ""
	}
	// Output format: "gh version 2.40.1 (2024-01-01)"
	lines := strings.Split(result.Stdout, "\n")
	if len(lines) > 0 {
		return strings.TrimSpace(lines[0])
	}
	return ""
}

// GetAuthenticatedUser returns the authoritative GitHub viewer identity for
// Change Request grouping. It intentionally does not parse `gh auth status`.
func (g *GitHubService) GetAuthenticatedUser() GitHubAuthenticatedUserResult {
	result := g.runner.Run("", GhPath(), "api", "--hostname", "github.com", "user", "--jq", "{login,id,type,name}")
	if !result.Success {
		return GitHubAuthenticatedUserResult{
			Success:   false,
			Error:     getGHErrorMessage(result),
			ErrorCode: mapGitHubChangeRequestError(result),
		}
	}
	return mapGitHubAuthenticatedUserJSON([]byte(result.Stdout))
}

const changeRequestListLimit = 100

// changeRequestListJSONFields is the `gh pr` field set shared by list and detail
// queries. Declaring it once keeps the CLI field contract in a single place.
const changeRequestListJSONFields = "number,title,body,url,state,isDraft,author,headRefName,headRefOid,baseRefName,baseRefOid,reviewDecision,mergeStateStatus,isCrossRepository,createdAt,updatedAt"

// changeRequestDetailJSONFields adds the fields only the detail view needs.
const changeRequestDetailJSONFields = changeRequestListJSONFields + ",reviewRequests,changedFiles"

// GetChangeRequestRepository verifies that origin points directly at a
// github.com repository and returns its authoritative GitHub metadata.
func (g *GitHubService) GetChangeRequestRepository(repoPath string) GitHubChangeRequestRepositoryResult {
	remoteURL, err := NewGitService().OriginRemoteURL(repoPath)
	if err != nil {
		return GitHubChangeRequestRepositoryResult{
			Error:     "This project needs an origin GitHub connection before Change Requests are available.",
			ErrorCode: GitHubChangeRequestErrorOriginMissing,
		}
	}

	host, isGitHubRemote := changeRequestRemoteHost(remoteURL)
	if !isGitHubRemote {
		return GitHubChangeRequestRepositoryResult{
			Error:     "Change Requests are currently available only for GitHub-connected projects.",
			ErrorCode: GitHubChangeRequestErrorOriginNotGitHub,
		}
	}
	if host != "github.com" {
		return GitHubChangeRequestRepositoryResult{
			Error:     "Change Requests currently support github.com projects only.",
			ErrorCode: GitHubChangeRequestErrorHostUnsupported,
		}
	}

	result := g.runner.Run(repoPath, GhPath(), "repo", "view", "--json", "nameWithOwner,defaultBranchRef,url,owner")
	if !result.Success {
		message := strings.ToLower(strings.Join([]string{result.Stderr, result.Stdout, result.Error}, "\n"))
		if strings.Contains(message, "could not resolve to a repository") || strings.Contains(message, "repository not found") {
			return GitHubChangeRequestRepositoryResult{
				Error:     "GitHub could not identify this project's primary repository.",
				ErrorCode: GitHubChangeRequestErrorRepositoryUnresolved,
			}
		}
		return GitHubChangeRequestRepositoryResult{
			Error:     getGHErrorMessage(result),
			ErrorCode: mapGitHubChangeRequestError(result),
		}
	}
	return mapGitHubChangeRequestRepositoryJSON([]byte(result.Stdout))
}

// ListChangeRequests loads the first release's supported open requests for the
// primary GitHub repository. External requests are deliberately omitted.
func (g *GitHubService) ListChangeRequests(repoPath string) GitHubChangeRequestListResult {
	repositoryResult := g.GetChangeRequestRepository(repoPath)
	if !repositoryResult.Success {
		return GitHubChangeRequestListResult{
			ChangeRequests: []GitHubChangeRequest{},
			Error:          repositoryResult.Error,
			ErrorCode:      repositoryResult.ErrorCode,
		}
	}

	result := g.runner.Run(
		repoPath,
		GhPath(),
		"pr", "list",
		"--repo", repositoryResult.Repository.NameWithOwner,
		"--state", "open",
		"--limit", strconv.Itoa(changeRequestListLimit),
		"--json", changeRequestListJSONFields,
	)
	if !result.Success {
		return GitHubChangeRequestListResult{
			ChangeRequests: []GitHubChangeRequest{},
			Error:          getGHErrorMessage(result),
			ErrorCode:      mapGitHubChangeRequestError(result),
		}
	}
	return mapGitHubChangeRequestListJSON([]byte(result.Stdout), repositoryResult.Repository)
}

// GetChangeRequest loads the full review metadata required by the detail view.
func (g *GitHubService) GetChangeRequest(repoPath string, number int) GitHubChangeRequestDetailResult {
	repositoryResult := g.GetChangeRequestRepository(repoPath)
	if !repositoryResult.Success {
		return GitHubChangeRequestDetailResult{
			Error:     repositoryResult.Error,
			ErrorCode: repositoryResult.ErrorCode,
		}
	}

	result := g.runner.Run(
		repoPath,
		GhPath(),
		"pr", "view", strconv.Itoa(number),
		"--repo", repositoryResult.Repository.NameWithOwner,
		"--json", changeRequestDetailJSONFields,
	)
	if !result.Success {
		return GitHubChangeRequestDetailResult{
			Error:     getGHErrorMessage(result),
			ErrorCode: mapGitHubChangeRequestError(result),
		}
	}
	return mapGitHubChangeRequestDetailJSON([]byte(result.Stdout))
}

// ListChangeRequestFiles loads the GitHub file metadata for a Change Request.
// GitHub's reported changedFiles count is fetched separately so truncation is
// detected without re-downloading the whole request payload.
func (g *GitHubService) ListChangeRequestFiles(repoPath string, number int) GitHubChangeRequestFilesResult {
	repositoryResult := g.GetChangeRequestRepository(repoPath)
	if !repositoryResult.Success {
		return GitHubChangeRequestFilesResult{
			Files:     []GitHubChangeRequestFile{},
			Error:     repositoryResult.Error,
			ErrorCode: repositoryResult.ErrorCode,
		}
	}

	countResult := g.runner.Run(
		repoPath,
		GhPath(),
		"pr", "view", strconv.Itoa(number),
		"--repo", repositoryResult.Repository.NameWithOwner,
		"--json", "changedFiles",
	)
	if !countResult.Success {
		return GitHubChangeRequestFilesResult{
			Files:     []GitHubChangeRequestFile{},
			Error:     getGHErrorMessage(countResult),
			ErrorCode: mapGitHubChangeRequestError(countResult),
		}
	}
	var reported struct {
		ChangedFiles int `json:"changedFiles"`
	}
	if err := json.Unmarshal([]byte(countResult.Stdout), &reported); err != nil {
		return GitHubChangeRequestFilesResult{
			Files:     []GitHubChangeRequestFile{},
			Error:     "Failed to read the Change Request file count from GitHub.",
			ErrorCode: GitHubChangeRequestErrorInternal,
		}
	}

	endpoint := "repos/" + repositoryResult.Repository.NameWithOwner + "/pulls/" + strconv.Itoa(number) + "/files"
	result := g.runner.Run(repoPath, GhPath(), "api", "--paginate", "--slurp", endpoint)
	if !result.Success {
		return GitHubChangeRequestFilesResult{
			Files:     []GitHubChangeRequestFile{},
			Error:     getGHErrorMessage(result),
			ErrorCode: mapGitHubChangeRequestError(result),
		}
	}
	return mapGitHubChangeRequestFilesJSON([]byte(result.Stdout), reported.ChangedFiles)
}

// ListChangeRequestTargets returns the origin branches a Change Request may
// target and the repository default the create dialog should preselect. It
// reads directly from origin so stale local remote-tracking refs cannot appear.
func (g *GitHubService) ListChangeRequestTargets(repoPath string) GitHubChangeRequestTargetsResult {
	repositoryResult := g.GetChangeRequestRepository(repoPath)
	if !repositoryResult.Success {
		return GitHubChangeRequestTargetsResult{
			Branches:  []GitHubChangeRequestBranch{},
			Error:     repositoryResult.Error,
			ErrorCode: repositoryResult.ErrorCode,
		}
	}

	remoteBranches, err := NewGitService().OriginRemoteBranches(repoPath)
	if err != nil {
		return GitHubChangeRequestTargetsResult{
			Branches:  []GitHubChangeRequestBranch{},
			Error:     "IOFabrik could not read the project's GitHub branches.",
			ErrorCode: GitHubChangeRequestErrorInternal,
		}
	}

	defaultBranch := strings.TrimSpace(repositoryResult.Repository.DefaultBranch)
	branches := make([]GitHubChangeRequestBranch, 0, len(remoteBranches))
	for _, branch := range remoteBranches {
		branches = append(branches, GitHubChangeRequestBranch{
			Name:      branch.Name,
			IsDefault: branch.Name == defaultBranch,
		})
	}

	return GitHubChangeRequestTargetsResult{
		Success:       true,
		Branches:      branches,
		DefaultBranch: defaultBranch,
	}
}

// FindOpenChangeRequestForBranch performs a deterministic duplicate lookup for a
// single source branch. It is called both at create preflight and again if
// `gh pr create` reports a duplicate.
func (g *GitHubService) FindOpenChangeRequestForBranch(repoPath string, sourceBranch string) GitHubFindChangeRequestResult {
	sourceBranch = strings.TrimSpace(sourceBranch)
	if sourceBranch == "" {
		return GitHubFindChangeRequestResult{
			Error:     "A source branch is required to look up existing Change Requests.",
			ErrorCode: GitHubChangeRequestErrorInternal,
		}
	}

	repositoryResult := g.GetChangeRequestRepository(repoPath)
	if !repositoryResult.Success {
		return GitHubFindChangeRequestResult{
			Error:     repositoryResult.Error,
			ErrorCode: repositoryResult.ErrorCode,
		}
	}

	result := g.runner.Run(
		repoPath,
		GhPath(),
		"pr", "list",
		"--repo", repositoryResult.Repository.NameWithOwner,
		"--state", "open",
		"--head", sourceBranch,
		"--json", changeRequestListJSONFields,
		"--limit", "1",
	)
	if !result.Success {
		return GitHubFindChangeRequestResult{
			Error:     getGHErrorMessage(result),
			ErrorCode: mapGitHubChangeRequestError(result),
		}
	}

	var rawRequests []changeRequestJSON
	if err := json.Unmarshal([]byte(result.Stdout), &rawRequests); err != nil {
		return GitHubFindChangeRequestResult{
			Error:     "Failed to read existing Change Requests from GitHub.",
			ErrorCode: GitHubChangeRequestErrorInternal,
		}
	}
	for _, raw := range rawRequests {
		if raw.IsCrossRepository {
			continue
		}
		return GitHubFindChangeRequestResult{
			Success:       true,
			Found:         true,
			ChangeRequest: raw.toChangeRequest(),
		}
	}
	return GitHubFindChangeRequestResult{Success: true, Found: false}
}

// CreateChangeRequest opens a Change Request for a pushed, fully synced source
// branch after every preflight check passes. It never pushes implicitly and
// never retries: a duplicate routes the caller to the existing request instead.
func (g *GitHubService) CreateChangeRequest(repoPath string, options GitHubCreateChangeRequestOptions) (createResult GitHubCreateChangeRequestResult) {
	done := LogMethod("GitHubService.CreateChangeRequest", map[string]interface{}{
		"repoPath":     repoPath,
		"sourceBranch": options.SourceBranch,
		"targetBranch": options.TargetBranch,
	})
	defer func() { done(createResult, nil) }()

	title := strings.TrimSpace(options.Title)
	body := strings.TrimSpace(options.Body)
	sourceBranch := strings.TrimSpace(options.SourceBranch)
	targetBranch := strings.TrimSpace(options.TargetBranch)

	if title == "" {
		return GitHubCreateChangeRequestResult{
			Error:     "A title is required to create a Change Request.",
			ErrorCode: GitHubChangeRequestErrorInternal,
		}
	}
	if sourceBranch == "" {
		return GitHubCreateChangeRequestResult{
			Error:     "A source branch is required to create a Change Request.",
			ErrorCode: GitHubChangeRequestErrorInternal,
		}
	}
	if targetBranch == "" {
		return GitHubCreateChangeRequestResult{
			Error:     "A target branch is required to create a Change Request.",
			ErrorCode: GitHubChangeRequestErrorInternal,
		}
	}
	if strings.EqualFold(sourceBranch, targetBranch) {
		return GitHubCreateChangeRequestResult{
			Error:     "The source and target branch must be different.",
			ErrorCode: GitHubChangeRequestErrorInternal,
		}
	}

	repositoryResult := g.GetChangeRequestRepository(repoPath)
	if !repositoryResult.Success {
		return GitHubCreateChangeRequestResult{
			Error:     repositoryResult.Error,
			ErrorCode: repositoryResult.ErrorCode,
		}
	}
	if strings.EqualFold(sourceBranch, strings.TrimSpace(repositoryResult.Repository.DefaultBranch)) {
		return GitHubCreateChangeRequestResult{
			Error:     "Change Requests are created from a separate work branch, not the main project branch.",
			ErrorCode: GitHubChangeRequestErrorInternal,
		}
	}

	// Acquire the backend per-repository lock so RepositorySettingsService
	// timers cannot advance the branch between the sync check and creation.
	unlock := lockChangeRequestRepo(repoPath)
	defer unlock()

	// Re-verify the branch is fully synced immediately before creation rather
	// than trusting the state that existed when the dialog opened.
	if code, message, ok := g.verifyBranchSyncedForChangeRequest(repoPath, sourceBranch); !ok {
		return GitHubCreateChangeRequestResult{Error: message, ErrorCode: code}
	}

	// Deterministic duplicate lookup before attempting creation.
	existing := g.FindOpenChangeRequestForBranch(repoPath, sourceBranch)
	if !existing.Success {
		return GitHubCreateChangeRequestResult{Error: existing.Error, ErrorCode: existing.ErrorCode}
	}
	if existing.Found {
		return GitHubCreateChangeRequestResult{
			Success:       true,
			IsDuplicate:   true,
			ChangeRequest: existing.ChangeRequest,
			URL:           existing.ChangeRequest.URL,
			Message:       "An open Change Request already exists for this branch.",
			ErrorCode:     GitHubChangeRequestErrorDuplicateRequest,
		}
	}

	result := g.runner.Run(
		repoPath,
		GhPath(),
		"pr", "create",
		"--repo", repositoryResult.Repository.NameWithOwner,
		"--base", targetBranch,
		"--head", sourceBranch,
		"--title", title,
		"--body", body,
	)
	if !result.Success {
		combined := strings.ToLower(strings.Join([]string{result.Stderr, result.Stdout, result.Error}, "\n"))
		if strings.Contains(combined, "already exists") || strings.Contains(combined, "http 422") {
			// A duplicate raced us between preflight and creation. Never retry;
			// route the caller to the discovered request instead.
			discovered := g.FindOpenChangeRequestForBranch(repoPath, sourceBranch)
			if discovered.Success && discovered.Found {
				return GitHubCreateChangeRequestResult{
					Success:       true,
					IsDuplicate:   true,
					ChangeRequest: discovered.ChangeRequest,
					URL:           discovered.ChangeRequest.URL,
					Message:       "An open Change Request already exists for this branch.",
					ErrorCode:     GitHubChangeRequestErrorDuplicateRequest,
				}
			}
			return GitHubCreateChangeRequestResult{
				Error:     "An open Change Request already exists for this branch.",
				ErrorCode: GitHubChangeRequestErrorDuplicateRequest,
			}
		}
		return GitHubCreateChangeRequestResult{
			Error:     getGHErrorMessage(result),
			ErrorCode: mapGitHubChangeRequestError(result),
		}
	}

	createdURL := extractChangeRequestURL(result.Stdout)
	number := changeRequestNumberFromURL(createdURL)
	if number > 0 {
		detail := g.GetChangeRequest(repoPath, number)
		if detail.Success {
			return GitHubCreateChangeRequestResult{
				Success:       true,
				ChangeRequest: detail.ChangeRequest,
				URL:           detail.ChangeRequest.URL,
				Message:       "Change Request created.",
			}
		}
	}

	return GitHubCreateChangeRequestResult{
		Success: true,
		URL:     createdURL,
		Message: "Change Request created.",
	}
}

// verifyBranchSyncedForChangeRequest enforces the release's synced-branch rule:
// a clean working tree and index, a branch that tracks its same-named origin
// branch, and a local head that equals the origin head with no ahead or behind
// commits. The origin head is read with ls-remote so no local ref is mutated.
func (g *GitHubService) verifyBranchSyncedForChangeRequest(repoPath string, branch string) (GitHubChangeRequestErrorCode, string, bool) {
	gitSvc := NewGitService()

	hasChanges, err := gitSvc.HasChanges(repoPath)
	if err != nil {
		return GitHubChangeRequestErrorInternal, "IOFabrik could not read this project's status.", false
	}
	if hasChanges {
		return GitHubChangeRequestErrorBranchNotSynced,
			"Save and sync your changes before creating a Change Request.", false
	}

	if _, ok := gitSvc.OriginTrackingUpstream(repoPath, branch); !ok {
		return GitHubChangeRequestErrorBranchNotSynced,
			"Publish this branch to GitHub before creating a Change Request.", false
	}

	remoteResult := g.runner.forGitOperation().RunGit(repoPath, "ls-remote", "origin", "refs/heads/"+branch)
	if !remoteResult.Success {
		return GitHubChangeRequestErrorBranchNotSynced,
			"IOFabrik could not confirm this branch on GitHub. Sync and retry.", false
	}
	remoteFields := strings.Fields(trimOutput(remoteResult.Stdout))
	if len(remoteFields) < 1 || remoteFields[0] == "" {
		return GitHubChangeRequestErrorBranchNotSynced,
			"Publish this branch to GitHub before creating a Change Request.", false
	}
	remoteOID := remoteFields[0]

	localResult := g.runner.RunGit(repoPath, "rev-parse", "--verify", "refs/heads/"+branch)
	if !localResult.Success {
		return GitHubChangeRequestErrorBranchNotSynced,
			"IOFabrik could not read this branch locally.", false
	}
	localOID := trimOutput(localResult.Stdout)

	if !strings.EqualFold(localOID, remoteOID) {
		return GitHubChangeRequestErrorBranchNotSynced,
			"Sync this branch with GitHub before creating a Change Request.", false
	}
	return "", "", true
}

// extractChangeRequestURL returns the first GitHub pull-request URL in gh's
// create output. gh prints the URL on success, sometimes among other lines.
func extractChangeRequestURL(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "https://") && strings.Contains(line, "/pull/") {
			return line
		}
	}
	return strings.TrimSpace(output)
}

// changeRequestNumberFromURL parses the trailing pull-request number from a
// GitHub URL such as https://github.com/owner/name/pull/42.
func changeRequestNumberFromURL(prURL string) int {
	prURL = strings.TrimSpace(prURL)
	index := strings.LastIndex(prURL, "/pull/")
	if index == -1 {
		return 0
	}
	tail := prURL[index+len("/pull/"):]
	tail = strings.TrimRight(tail, "/")
	if slash := strings.IndexAny(tail, "/?#"); slash != -1 {
		tail = tail[:slash]
	}
	number, err := strconv.Atoi(tail)
	if err != nil {
		return 0
	}
	return number
}

func changeRequestRemoteHost(remoteURL string) (host string, isGitHubRemote bool) {
	remoteURL = strings.TrimSpace(remoteURL)
	if strings.HasPrefix(remoteURL, "git@") {
		remoteURL = "ssh://" + strings.Replace(remoteURL, ":", "/", 1)
	}
	parsed, err := url.Parse(remoteURL)
	if err != nil || parsed.Hostname() == "" {
		return "", false
	}
	host = strings.ToLower(parsed.Hostname())
	return host, host == "github.com" || strings.HasPrefix(host, "github.")
}

func mapGitHubChangeRequestError(result CommandResult) GitHubChangeRequestErrorCode {
	message := strings.ToLower(strings.Join([]string{result.Stderr, result.Stdout, result.Error}, "\n"))
	switch {
	case result.ExitCode == -1 && (strings.Contains(message, "executable file not found") || strings.Contains(message, "no such file")):
		return GitHubChangeRequestErrorGHUnavailable
	case strings.Contains(message, "not logged in"), strings.Contains(message, "no oauth token"), strings.Contains(message, "authentication required"), strings.Contains(message, "token has expired"), strings.Contains(message, "http 401"), strings.Contains(message, "bad credentials"):
		return GitHubChangeRequestErrorAuthRequired
	case strings.Contains(message, "rate limit"), strings.Contains(message, "api rate limit exceeded"):
		return GitHubChangeRequestErrorRateLimited
	case strings.Contains(message, "resource not accessible by integration"), strings.Contains(message, "http 403"), strings.Contains(message, "forbidden"):
		return GitHubChangeRequestErrorPermissionDenied
	case strings.Contains(message, "network is unreachable"), strings.Contains(message, "no such host"), strings.Contains(message, "connection refused"), strings.Contains(message, "tls handshake timeout"), strings.Contains(message, "i/o timeout"):
		return GitHubChangeRequestErrorNetworkUnavailable
	default:
		return GitHubChangeRequestErrorInternal
	}
}

func mapGitHubAuthenticatedUserJSON(data []byte) GitHubAuthenticatedUserResult {
	var raw struct {
		Login string          `json:"login"`
		ID    json.RawMessage `json:"id"`
		Type  string          `json:"type"`
		Name  string          `json:"name"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return GitHubAuthenticatedUserResult{Error: "Failed to parse authenticated GitHub user", ErrorCode: GitHubChangeRequestErrorInternal}
	}

	user := GitHubAuthenticatedUser{Login: raw.Login, Type: raw.Type, Name: raw.Name}
	if len(raw.ID) > 0 && string(raw.ID) != "null" {
		if err := json.Unmarshal(raw.ID, &user.ID); err != nil {
			var numericID json.Number
			if numberErr := json.Unmarshal(raw.ID, &numericID); numberErr != nil {
				return GitHubAuthenticatedUserResult{Error: "Failed to parse authenticated GitHub user", ErrorCode: GitHubChangeRequestErrorInternal}
			}
			user.ID = numericID.String()
		}
	}
	if strings.TrimSpace(user.Login) == "" {
		return GitHubAuthenticatedUserResult{Error: "GitHub did not return an account login", ErrorCode: GitHubChangeRequestErrorInternal}
	}
	return GitHubAuthenticatedUserResult{Success: true, User: user}
}

func mapGitHubChangeRequestRepositoryJSON(data []byte) GitHubChangeRequestRepositoryResult {
	var raw struct {
		NameWithOwner    string `json:"nameWithOwner"`
		URL              string `json:"url"`
		DefaultBranchRef *struct {
			Name string `json:"name"`
		} `json:"defaultBranchRef"`
	}
	if err := json.Unmarshal(data, &raw); err != nil || strings.TrimSpace(raw.NameWithOwner) == "" {
		return GitHubChangeRequestRepositoryResult{
			Error:     "GitHub could not identify this project's primary repository.",
			ErrorCode: GitHubChangeRequestErrorRepositoryUnresolved,
		}
	}

	defaultBranch := ""
	if raw.DefaultBranchRef != nil {
		defaultBranch = raw.DefaultBranchRef.Name
	}
	return GitHubChangeRequestRepositoryResult{
		Success: true,
		Repository: GitHubChangeRequestRepository{
			NameWithOwner: raw.NameWithOwner,
			DefaultBranch: defaultBranch,
			URL:           raw.URL,
		},
	}
}

// changeRequestJSON is the private decoding shape shared by `gh pr list` and
// `gh pr view`. Keeping one definition means GitHub CLI field spelling is
// declared exactly once.
type changeRequestJSON struct {
	Number            int    `json:"number"`
	Title             string `json:"title"`
	Body              string `json:"body"`
	URL               string `json:"url"`
	State             string `json:"state"`
	IsDraft           bool   `json:"isDraft"`
	HeadRefName       string `json:"headRefName"`
	HeadRefOID        string `json:"headRefOid"`
	BaseRefName       string `json:"baseRefName"`
	BaseRefOID        string `json:"baseRefOid"`
	ReviewDecision    string `json:"reviewDecision"`
	MergeStateStatus  string `json:"mergeStateStatus"`
	IsCrossRepository bool   `json:"isCrossRepository"`
	CreatedAt         string `json:"createdAt"`
	UpdatedAt         string `json:"updatedAt"`
	ChangedFiles      int    `json:"changedFiles"`
	Author            *struct {
		Login string `json:"login"`
		Name  string `json:"name"`
	} `json:"author"`
	ReviewRequests []struct {
		RequestedReviewer *struct {
			Login string `json:"login"`
			Name  string `json:"name"`
		} `json:"requestedReviewer"`
	} `json:"reviewRequests"`
}

func (raw changeRequestJSON) toChangeRequest() GitHubChangeRequest {
	author := GitHubChangeAuthor{}
	if raw.Author != nil {
		author = GitHubChangeAuthor{Login: raw.Author.Login, Name: raw.Author.Name}
	}

	reviewers := make([]GitHubChangeReviewer, 0, len(raw.ReviewRequests))
	for _, reviewRequest := range raw.ReviewRequests {
		if reviewRequest.RequestedReviewer != nil {
			reviewers = append(reviewers, GitHubChangeReviewer{
				Login: reviewRequest.RequestedReviewer.Login,
				Name:  reviewRequest.RequestedReviewer.Name,
			})
		}
	}

	return GitHubChangeRequest{
		Number:            raw.Number,
		Title:             raw.Title,
		Body:              raw.Body,
		URL:               raw.URL,
		State:             raw.State,
		IsDraft:           raw.IsDraft,
		Author:            author,
		HeadRefName:       raw.HeadRefName,
		HeadRefOID:        raw.HeadRefOID,
		BaseRefName:       raw.BaseRefName,
		BaseRefOID:        raw.BaseRefOID,
		ReviewDecision:    raw.ReviewDecision,
		MergeStateStatus:  raw.MergeStateStatus,
		IsCrossRepository: raw.IsCrossRepository,
		CreatedAt:         raw.CreatedAt,
		UpdatedAt:         raw.UpdatedAt,
		Reviewers:         reviewers,
	}
}

func mapGitHubChangeRequestListJSON(data []byte, repository GitHubChangeRequestRepository) GitHubChangeRequestListResult {
	var rawRequests []changeRequestJSON
	if err := json.Unmarshal(data, &rawRequests); err != nil {
		return GitHubChangeRequestListResult{
			ChangeRequests: []GitHubChangeRequest{},
			Error:          "Failed to parse Change Requests from GitHub.",
			ErrorCode:      GitHubChangeRequestErrorInternal,
		}
	}

	requests := make([]GitHubChangeRequest, 0, len(rawRequests))
	omittedExternalCount := 0
	for _, raw := range rawRequests {
		if raw.IsCrossRepository {
			omittedExternalCount++
			continue
		}
		requests = append(requests, raw.toChangeRequest())
	}

	return GitHubChangeRequestListResult{
		Success:              true,
		Repository:           repository,
		ChangeRequests:       requests,
		OmittedExternalCount: omittedExternalCount,
		MayHaveMore:          len(rawRequests) == changeRequestListLimit,
	}
}

func mapGitHubChangeRequestDetailJSON(data []byte) GitHubChangeRequestDetailResult {
	var raw changeRequestJSON
	if err := json.Unmarshal(data, &raw); err != nil || raw.Number == 0 {
		return GitHubChangeRequestDetailResult{
			Error:     "Failed to parse Change Request details from GitHub.",
			ErrorCode: GitHubChangeRequestErrorInternal,
		}
	}

	return GitHubChangeRequestDetailResult{
		Success:       true,
		ChangeRequest: raw.toChangeRequest(),
		TotalFiles:    raw.ChangedFiles,
	}
}

// mapGitHubChangeRequestFilesJSON decodes gh api --paginate --slurp output.
// The REST spelling and pagination shape remain private to this service.
func mapGitHubChangeRequestFilesJSON(data []byte, totalFiles int) GitHubChangeRequestFilesResult {
	var pages [][]struct {
		Filename         string `json:"filename"`
		PreviousFilename string `json:"previous_filename"`
		Status           string `json:"status"`
		Additions        int    `json:"additions"`
		Deletions        int    `json:"deletions"`
	}
	if err := json.Unmarshal(data, &pages); err != nil {
		return GitHubChangeRequestFilesResult{
			Files:     []GitHubChangeRequestFile{},
			Error:     "Failed to parse Change Request files",
			ErrorCode: GitHubChangeRequestErrorInternal,
		}
	}

	files := make([]GitHubChangeRequestFile, 0)
	for _, page := range pages {
		for _, file := range page {
			files = append(files, GitHubChangeRequestFile{
				Path:         file.Filename,
				PreviousPath: file.PreviousFilename,
				Status:       file.Status,
				Additions:    file.Additions,
				Deletions:    file.Deletions,
			})
		}
	}

	isTruncated := totalFiles > len(files)
	result := GitHubChangeRequestFilesResult{
		Success:     true,
		Files:       files,
		TotalFiles:  totalFiles,
		IsTruncated: isTruncated,
	}
	if isTruncated {
		result.Message = "GitHub returned a partial Change Request file list"
		result.ErrorCode = GitHubChangeRequestErrorFilesTruncated
	}
	return result
}

// ============================================================================
// Authentication
// ============================================================================

// AuthLogin initiates the GitHub authentication flow using device code.
// This runs the gh auth login command and waits for completion.
// The flow shows a code that the user must enter in their browser.
func (g *GitHubService) AuthLogin() GitHubAuthResult {
	done := LogMethod("GitHubService.AuthLogin", nil)
	defer func() { done(nil, nil) }()

	// Browser sign-in needs time for the user to enter the verification code.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	output := &githubDeviceFlowOutput{codes: make(chan string, 1)}
	result := g.runner.runWithStderr(ctx, output, GhPath(), "auth", "login", "--hostname", githubHost, "--git-protocol", "https", "--web", "--clipboard=false")
	if !result.Success {
		return GitHubAuthResult{
			Error: "GitHub sign-in could not finish. Check your internet connection and try again.",
		}
	}

	return GitHubAuthResult{
		Success: true,
		Message: "Authentication successful",
	}
}

// AuthLoginStart starts or joins the current device-code attempt. Repeated
// starts share its result rather than cancelling a sign-in already in progress.
func (g *GitHubService) AuthLoginStart() GitHubDeviceFlowResult {
	return g.authLoginStart(30 * time.Second)
}

// AuthLoginComplete polls the desktop process's authentication status. It can
// only cancel the attempt that was current when this call began.
func (g *GitHubService) AuthLoginComplete() GitHubAuthResult {
	g.authMu.Lock()
	attempt := g.authAttempt
	g.authMu.Unlock()
	for i := 0; i < 5; i++ {
		time.Sleep(500 * time.Millisecond)
		if g.AuthStatus().LoggedIn {
			g.cancelAuthAttempt(attempt)
			return GitHubAuthResult{Success: true, Message: "Authentication successful"}
		}
	}
	return GitHubAuthResult{
		Error: "Authentication not completed. Please enter the code in your browser and try again.",
	}
}

// AuthLoginCancel cancels and reaps the current device-code process.
func (g *GitHubService) AuthLoginCancel() GitHubAuthResult {
	g.authMu.Lock()
	attempt := g.authAttempt
	g.authMu.Unlock()
	g.cancelAuthAttempt(attempt)
	return GitHubAuthResult{Success: true, Message: "Authentication cancelled"}
}

// getErrorFromOutput extracts a user-friendly error message from command output
func getErrorFromOutput(output string, err error) string {
	output = strings.TrimSpace(output)
	if output != "" {
		// Look for error messages in the output
		lines := strings.Split(output, "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(strings.ToLower(line), "error:") {
				// Remove "error:" or "Error:" prefix and trim spaces
				errMsg := line[6:] // len("error:") == 6
				return strings.TrimSpace(errMsg)
			}
		}
		// Return last non-empty line as error
		for i := len(lines) - 1; i >= 0; i-- {
			if strings.TrimSpace(lines[i]) != "" {
				return strings.TrimSpace(lines[i])
			}
		}
	}
	if err != nil {
		return err.Error()
	}
	return "Authentication failed"
}

// AuthLogout logs out of GitHub CLI
func (g *GitHubService) AuthLogout() GitHubAuthResult {
	done := LogMethod("GitHubService.AuthLogout", nil)
	defer func() { done(nil, nil) }()

	// The gh CLI requires confirmation when logging out
	// We pipe "y\n" to stdin to confirm the logout
	result := g.runner.RunWithStdin("", "y\n", GhPath(), "auth", "logout", "--hostname", "github.com")
	if !result.Success {
		// Check if the error is because no account is logged in
		if strings.Contains(result.Stderr, "not logged in") || strings.Contains(result.Stderr, "no accounts") {
			return GitHubAuthResult{
				Success: true,
				Message: "Already logged out",
			}
		}
		return GitHubAuthResult{
			Success: false,
			Error:   getGHErrorMessage(result),
		}
	}

	return GitHubAuthResult{
		Success: true,
		Message: "Logged out successfully",
	}
}

// AuthStatus checks the active github.com account. JSON preserves network errors
// that gh's display output otherwise presents as an invalid token.
func (g *GitHubService) AuthStatus() GitHubAuthStatus {
	done := LogMethod("GitHubService.AuthStatus", nil)
	defer func() { done(nil, nil) }()

	result := g.runner.Run("", GhPath(), "auth", "status", "--active", "--hostname", "github.com", "--json", "hosts")
	status := GitHubAuthStatus{Host: "github.com"}
	if !result.Success {
		status.ErrorCode = githubAuthStatusErrorCode(result)
	} else {
		var raw struct {
			Hosts map[string][]struct {
				State       string `json:"state"`
				Error       string `json:"error"`
				Active      bool   `json:"active"`
				Login       string `json:"login"`
				GitProtocol string `json:"gitProtocol"`
				Scopes      string `json:"scopes"`
			} `json:"hosts"`
		}
		if err := json.Unmarshal([]byte(result.Stdout), &raw); err != nil || raw.Hosts == nil {
			status.ErrorCode = GitHubChangeRequestErrorInternal
		} else if len(raw.Hosts["github.com"]) == 0 {
			status.ErrorCode = GitHubChangeRequestErrorAuthRequired
		} else {
			status.ErrorCode = GitHubChangeRequestErrorInternal
			for _, entry := range raw.Hosts["github.com"] {
				if !entry.Active {
					continue
				}
				switch entry.State {
				case "success":
					status.LoggedIn = true
					status.Username = entry.Login
					status.Protocol = entry.GitProtocol
					status.Scopes = entry.Scopes
					status.ErrorCode = ""
				case "timeout":
					status.ErrorCode = GitHubChangeRequestErrorNetworkUnavailable
				case "error":
					status.ErrorCode = githubAuthStatusErrorCode(CommandResult{Stderr: entry.Error})
				}
				break
			}
		}
	}

	switch status.ErrorCode {
	case "":
	case GitHubChangeRequestErrorAuthRequired:
		status.Error = "GitHub authentication required. Authenticate with GitHub to connect."
	case GitHubChangeRequestErrorNetworkUnavailable:
		status.Error = "GitHub could not be reached. Check your connection and try again."
	default:
		status.Error = "GitHub status could not be checked. Try again shortly."
	}
	return status
}

// githubAuthStatusErrorCode keeps connectivity failures separate from credentials.
// gh can report a failed login for either reason, so check network errors first.
func githubAuthStatusErrorCode(result CommandResult) GitHubChangeRequestErrorCode {
	message := strings.ToLower(strings.Join([]string{result.Stderr, result.Stdout, result.Error}, "\n"))
	code := mapGitHubChangeRequestError(result)
	switch {
	case code == GitHubChangeRequestErrorNetworkUnavailable,
		strings.Contains(message, "error connecting to"),
		strings.Contains(message, "connection reset"),
		strings.Contains(message, "context deadline exceeded"),
		strings.Contains(message, "temporary failure in name resolution"):
		return GitHubChangeRequestErrorNetworkUnavailable
	case strings.Contains(message, "not logged into"),
		strings.Contains(message, "token is invalid"),
		strings.Contains(message, "token in ") && strings.Contains(message, " is invalid"):
		return GitHubChangeRequestErrorAuthRequired
	default:
		return code
	}
}

// ListUserOrganizations returns the authenticated user's username and their organizations
// This is used for the "publish to GitHub" form to allow users to choose the repo owner
func (g *GitHubService) ListUserOrganizations() GitHubOrganizationsResult {
	done := LogMethod("GitHubService.ListUserOrganizations", nil)
	defer func() { done(nil, nil) }()

	// First get the authenticated username
	authStatus := g.AuthStatus()
	if !authStatus.LoggedIn {
		return GitHubOrganizationsResult{
			Success: false,
			Error:   "Not logged in to GitHub",
		}
	}

	// Get user's organizations using gh api
	result := g.runner.Run("", GhPath(), "api", "user/orgs", "--jq", ".[].login")

	orgs := []GitHubOrganization{}
	if result.Success && result.Stdout != "" {
		// Parse organization logins (one per line)
		lines := strings.Split(strings.TrimSpace(result.Stdout), "\n")
		for _, line := range lines {
			login := strings.TrimSpace(line)
			if login != "" {
				orgs = append(orgs, GitHubOrganization{
					Login: login,
					Name:  login, // Use login as name for simplicity
				})
			}
		}
	}
	// Note: If result is not successful, we still return success with empty orgs list
	// since the user might not have any organizations

	return GitHubOrganizationsResult{
		Success:       true,
		Username:      authStatus.Username,
		Organizations: orgs,
	}
}

// ============================================================================
// Repository Name Checking
// ============================================================================

// RepoNameCheckResult represents the result of checking if a repo name exists
type RepoNameCheckResult struct {
	Exists bool   `json:"exists"`
	Error  string `json:"error,omitempty"`
}

// CheckRepoNameExists checks whether a repository with the given name already
// exists under the specified owner (user or org). Uses `gh repo view` which
// returns exit code 0 when the repo exists and a non-zero code when it does not.
// owner: GitHub username or organization login
// name: repository name to check
func (g *GitHubService) CheckRepoNameExists(owner string, name string) RepoNameCheckResult {
	done := LogMethod("GitHubService.CheckRepoNameExists", map[string]interface{}{"owner": owner, "name": name})
	defer func() { done(nil, nil) }()

	if name == "" {
		return RepoNameCheckResult{
			Exists: false,
			Error:  "Repository name is required",
		}
	}

	// Validate inputs
	if owner != "" && !isValidGitHubOwner(owner) {
		return RepoNameCheckResult{
			Exists: false,
			Error:  "Invalid owner name: must contain only alphanumeric characters and hyphens",
		}
	}
	if !isValidGitHubRepoName(name) {
		return RepoNameCheckResult{
			Exists: false,
			Error:  "Invalid repository name: must contain only alphanumeric characters, hyphens, underscores, and periods",
		}
	}

	// Build the repo identifier: owner/name or just name (defaults to authenticated user)
	repoIdentifier := name
	if owner != "" {
		repoIdentifier = owner + "/" + name
	}

	result := g.runner.Run("", GhPath(), "repo", "view", repoIdentifier, "--json", "name")

	if result.Success {
		// Exit code 0 means the repo exists
		return RepoNameCheckResult{Exists: true}
	}

	// Check if the error indicates "not found" vs an actual failure
	errLower := strings.ToLower(result.Stderr + result.Error)
	if strings.Contains(errLower, "could not resolve") ||
		strings.Contains(errLower, "not found") ||
		strings.Contains(errLower, "graphql: could not resolve") {
		return RepoNameCheckResult{Exists: false}
	}

	// Some other error (network, auth, etc.)
	return RepoNameCheckResult{
		Exists: false,
		Error:  getGHErrorMessage(result),
	}
}

// ============================================================================
// Repository Listing
// ============================================================================

// RepoList lists repositories for the authenticated user
// limit: maximum number of repos to return (default 30, max 100)
// visibility: "public", "private", or empty for all
func (g *GitHubService) RepoList(limit int, visibility string) GitHubRepoListResult {
	done := LogMethod("GitHubService.RepoList", map[string]interface{}{"limit": limit, "visibility": visibility})
	defer func() { done(nil, nil) }()

	if limit <= 0 {
		limit = 30
	}
	if limit > 100 {
		limit = 100
	}

	args := []string{
		"repo", "list",
		"--json", "name,nameWithOwner,description,url,sshUrl,isPrivate,isFork,isArchived,defaultBranchRef,primaryLanguage,stargazerCount,forkCount,updatedAt,createdAt",
		"--limit", strings.TrimSpace(string(rune(limit))),
	}

	// Fix: properly convert limit to string
	args = []string{
		"repo", "list",
		"--json", "name,nameWithOwner,description,url,sshUrl,isPrivate,isFork,isArchived,defaultBranchRef,primaryLanguage,stargazerCount,forkCount,updatedAt,createdAt",
		"--limit", formatInt(limit),
	}

	if visibility == "public" || visibility == "private" {
		args = append(args, "--visibility", visibility)
	}

	result := g.runner.Run("", GhPath(), args...)
	if !result.Success {
		return GitHubRepoListResult{
			Success: false,
			Error:   getGHErrorMessage(result),
		}
	}

	// Parse JSON output
	var rawRepos []map[string]interface{}
	if err := json.Unmarshal([]byte(result.Stdout), &rawRepos); err != nil {
		return GitHubRepoListResult{
			Success: false,
			Error:   "Failed to parse repository list: " + err.Error(),
		}
	}

	repos := make([]GitHubRepo, 0, len(rawRepos))
	for _, raw := range rawRepos {
		repo := GitHubRepo{
			Name:        getString(raw, "name"),
			FullName:    getString(raw, "nameWithOwner"),
			Description: getString(raw, "description"),
			URL:         getString(raw, "url"),
			SSHURL:      getString(raw, "sshUrl"),
			Private:     getBool(raw, "isPrivate"),
			Fork:        getBool(raw, "isFork"),
			Archived:    getBool(raw, "isArchived"),
			UpdatedAt:   getString(raw, "updatedAt"),
			CreatedAt:   getString(raw, "createdAt"),
		}

		// Handle nested objects
		if defaultBranch, ok := raw["defaultBranchRef"].(map[string]interface{}); ok {
			repo.DefaultBranch = getString(defaultBranch, "name")
		}
		if lang, ok := raw["primaryLanguage"].(map[string]interface{}); ok {
			repo.Language = getString(lang, "name")
		}
		if stars, ok := raw["stargazerCount"].(float64); ok {
			repo.StargazersCount = int(stars)
		}
		if forks, ok := raw["forkCount"].(float64); ok {
			repo.ForksCount = int(forks)
		}

		repos = append(repos, repo)
	}

	return GitHubRepoListResult{
		Success: true,
		Repos:   repos,
	}
}

// RepoListForOrg lists repositories for a specific organization
func (g *GitHubService) RepoListForOrg(org string, limit int) GitHubRepoListResult {
	done := LogMethod("GitHubService.RepoListForOrg", map[string]interface{}{"org": org, "limit": limit})
	defer func() { done(nil, nil) }()

	if org == "" {
		return GitHubRepoListResult{
			Success: false,
			Error:   "Organization name is required",
		}
	}

	if limit <= 0 {
		limit = 30
	}
	if limit > 100 {
		limit = 100
	}

	args := []string{
		"repo", "list", org,
		"--json", "name,nameWithOwner,description,url,sshUrl,isPrivate,isFork,isArchived,defaultBranchRef,primaryLanguage,stargazerCount,forkCount,updatedAt,createdAt",
		"--limit", formatInt(limit),
	}

	result := g.runner.Run("", GhPath(), args...)
	if !result.Success {
		return GitHubRepoListResult{
			Success: false,
			Error:   getGHErrorMessage(result),
		}
	}

	// Parse JSON output (same as RepoList)
	var rawRepos []map[string]interface{}
	if err := json.Unmarshal([]byte(result.Stdout), &rawRepos); err != nil {
		return GitHubRepoListResult{
			Success: false,
			Error:   "Failed to parse repository list: " + err.Error(),
		}
	}

	repos := make([]GitHubRepo, 0, len(rawRepos))
	for _, raw := range rawRepos {
		repo := GitHubRepo{
			Name:        getString(raw, "name"),
			FullName:    getString(raw, "nameWithOwner"),
			Description: getString(raw, "description"),
			URL:         getString(raw, "url"),
			SSHURL:      getString(raw, "sshUrl"),
			Private:     getBool(raw, "isPrivate"),
			Fork:        getBool(raw, "isFork"),
			Archived:    getBool(raw, "isArchived"),
			UpdatedAt:   getString(raw, "updatedAt"),
			CreatedAt:   getString(raw, "createdAt"),
		}

		if defaultBranch, ok := raw["defaultBranchRef"].(map[string]interface{}); ok {
			repo.DefaultBranch = getString(defaultBranch, "name")
		}
		if lang, ok := raw["primaryLanguage"].(map[string]interface{}); ok {
			repo.Language = getString(lang, "name")
		}
		if stars, ok := raw["stargazerCount"].(float64); ok {
			repo.StargazersCount = int(stars)
		}
		if forks, ok := raw["forkCount"].(float64); ok {
			repo.ForksCount = int(forks)
		}

		repos = append(repos, repo)
	}

	return GitHubRepoListResult{
		Success: true,
		Repos:   repos,
	}
}

// ============================================================================
// Repository Clone
// ============================================================================

func inferRepoNameFromIdentifier(repo string) string {
	cleaned := strings.TrimSpace(repo)
	if cleaned == "" {
		return ""
	}

	cleaned = strings.TrimSuffix(cleaned, "/")
	cleaned = strings.TrimSuffix(cleaned, ".git")

	if strings.Contains(cleaned, "://") {
		if parsed, err := url.Parse(cleaned); err == nil {
			path := strings.Trim(parsed.Path, "/")
			if path != "" {
				parts := strings.Split(path, "/")
				return strings.TrimSuffix(parts[len(parts)-1], ".git")
			}
		}
	}

	// Handle SCP-like SSH URLs: git@github.com:owner/repo(.git)
	if strings.Contains(cleaned, "@") {
		if idx := strings.LastIndex(cleaned, ":"); idx >= 0 && idx < len(cleaned)-1 {
			cleaned = cleaned[idx+1:]
		}
	}

	cleaned = strings.Trim(cleaned, "/")
	if cleaned == "" {
		return ""
	}

	parts := strings.Split(cleaned, "/")
	return strings.TrimSuffix(parts[len(parts)-1], ".git")
}

// RepoClone clones a GitHub repository to the specified directory
// repo: repository in "owner/repo" format or full URL
// destPath: local directory to clone into (will be created)
// shallow: when true, clone only the latest commit history (depth=1)
func (g *GitHubService) RepoClone(repo string, destPath string, shallow bool) GitHubCloneResult {
	done := LogMethod("GitHubService.RepoClone", map[string]interface{}{"repo": repo, "destPath": destPath, "shallow": shallow})
	defer func() { done(nil, nil) }()

	if repo == "" {
		return GitHubCloneResult{
			Success: false,
			Error:   "Repository name or URL is required",
		}
	}

	cloneTarget := strings.TrimSpace(repo)
	if cloneTarget == "" {
		return GitHubCloneResult{
			Success: false,
			Error:   "Repository name or URL is required",
		}
	}
	if !strings.Contains(cloneTarget, "://") && !strings.Contains(cloneTarget, "@") {
		if strings.Count(cloneTarget, "/") != 1 {
			return GitHubCloneResult{
				Success: false,
				Error:   "Repository must be in owner/repo format or a valid URL",
			}
		}
		cloneTarget = "https://github.com/" + strings.TrimSuffix(cloneTarget, ".git") + ".git"
	}

	runner := g.runner.forGitOperation()

	args := []string{"clone"}
	if shallow {
		args = append(args, "--depth=1")
	}
	args = append(args, cloneTarget)

	repoName := inferRepoNameFromIdentifier(repo)
	cloneDir := repoName
	workDir := ""

	if destPath != "" {
		if err := os.MkdirAll(destPath, 0755); err != nil {
			return GitHubCloneResult{
				Success: false,
				Error:   "Failed to create destination folder: " + err.Error(),
			}
		}

		workDir = destPath
		if repoName != "" {
			cloneDir = filepath.Join(destPath, repoName)
		} else {
			cloneDir = destPath
		}
	}

	result := runner.Run(workDir, GitPath(), args...)
	if !result.Success {
		return GitHubCloneResult{
			Success: false,
			Error:   getErrorMessage(result),
		}
	}

	return GitHubCloneResult{
		Success:  true,
		CloneDir: cloneDir,
	}
}

// ============================================================================
// Repository Create
// ============================================================================

// RepoCreate creates a new repository on GitHub
func (g *GitHubService) RepoCreate(options GitHubRepoCreateOptions) GitHubRepoCreateResult {
	done := LogMethod("GitHubService.RepoCreate", map[string]interface{}{"name": options.Name, "private": options.Private})
	defer func() { done(nil, nil) }()

	if options.Name == "" {
		return GitHubRepoCreateResult{
			Success: false,
			Error:   "Repository name is required",
		}
	}

	args := []string{"repo", "create", options.Name}

	// Visibility
	if options.Private {
		args = append(args, "--private")
	} else {
		args = append(args, "--public")
	}

	// Description
	if options.Description != "" {
		args = append(args, "--description", options.Description)
	}

	// Add README
	if options.AddReadme {
		args = append(args, "--add-readme")
	}

	// .gitignore template
	if options.GitIgnore != "" {
		args = append(args, "--gitignore", options.GitIgnore)
	}

	// License template
	if options.License != "" {
		args = append(args, "--license", options.License)
	}

	// Run in clone path if specified
	workDir := ""
	if options.Clone && options.ClonePath != "" {
		workDir = options.ClonePath
	}

	result := g.runner.Run(workDir, GhPath(), args...)
	if !result.Success {
		return GitHubRepoCreateResult{
			Success: false,
			Error:   getGHErrorMessage(result),
		}
	}

	// Parse the created repository info
	// gh repo create outputs the URL of the created repo
	output := strings.TrimSpace(result.Stdout)
	repoURL := ""
	if strings.Contains(output, "github.com") {
		repoURL = output
	}

	createResult := GitHubRepoCreateResult{
		Success: true,
		Repo: GitHubRepo{
			Name:    options.Name,
			URL:     repoURL,
			Private: options.Private,
		},
	}

	if options.Clone {
		remote, err := g.createdRepoRemote(workDir, output)
		if err != "" {
			return GitHubRepoCreateResult{Error: err}
		}
		// gh initializes empty repositories locally, respecting init.defaultBranch.
		// Repositories initialized on GitHub are cloned with its existing retries.
		dir := inferRepoNameFromIdentifier(output)
		cloneDir := filepath.Join(workDir, dir)
		var setup CommandResult
		if !options.AddReadme && options.GitIgnore == "" && options.License == "" {
			setup = g.runner.RunGit(workDir, "init", dir)
			if setup.Success {
				setup = g.runner.RunGit(cloneDir, "remote", "add", "origin", remote)
			}
		} else {
			runner := g.forCreatedRepository(output)
			for attempt := 0; attempt < 4; attempt++ {
				if attempt > 0 {
					time.Sleep(3 * time.Second)
				}
				setup = runner.RunGit(workDir, "clone", remote)
				if setup.Success || setup.ExitCode != 128 {
					break
				}
			}
		}
		if !setup.Success {
			return GitHubRepoCreateResult{Error: getErrorMessage(setup)}
		}
		createResult.CloneDir = cloneDir
	}

	return createResult
}

// RepoCreateFromLocal creates a new GitHub repository from an existing local repository
// localPath: path to the local git repository
// name: name for the new GitHub repository (optional, defaults to folder name)
// description: repository description
// private: whether the repository should be private
// owner: the owner for the repository (username or organization login). If empty, defaults to authenticated user.
func (g *GitHubService) RepoCreateFromLocal(localPath string, name string, description string, private bool, owner string) GitHubRepoCreateResult {
	done := LogMethod("GitHubService.RepoCreateFromLocal", map[string]interface{}{"localPath": localPath, "name": name, "owner": owner})
	defer func() { done(nil, nil) }()

	if localPath == "" {
		return GitHubRepoCreateResult{
			Success: false,
			Error:   "Local repository path is required",
		}
	}

	// Sanitize inputs to prevent command injection
	// GitHub usernames/org names: alphanumeric, hyphens only (no leading hyphen)
	// Repo names: alphanumeric, hyphens, underscores, periods
	if owner != "" && !isValidGitHubOwner(owner) {
		return GitHubRepoCreateResult{
			Success: false,
			Error:   "Invalid owner name: must contain only alphanumeric characters and hyphens",
		}
	}
	if name != "" && !isValidGitHubRepoName(name) {
		return GitHubRepoCreateResult{
			Success: false,
			Error:   "Invalid repository name: must contain only alphanumeric characters, hyphens, underscores, and periods",
		}
	}

	// Retain gh's --push preflight before creating anything on GitHub.
	committed := g.runner.RunGit(localPath, "rev-parse", "HEAD")
	if !committed.Success {
		return GitHubRepoCreateResult{Error: getErrorMessage(committed)}
	}
	bare := g.runner.RunGit(localPath, "rev-parse", "--is-bare-repository")
	if !bare.Success {
		return GitHubRepoCreateResult{Error: getErrorMessage(bare)}
	}

	args := []string{"repo", "create"}

	// Construct the repository name with owner if specified
	repoIdentifier := name
	if owner != "" && name != "" {
		repoIdentifier = owner + "/" + name
	}

	if repoIdentifier != "" {
		args = append(args, repoIdentifier)
	}

	args = append(args, "--source", localPath)

	if private {
		args = append(args, "--private")
	} else {
		args = append(args, "--public")
	}

	if description != "" {
		args = append(args, "--description", description)
	}

	result := g.runner.Run(localPath, GhPath(), args...)
	if !result.Success {
		return GitHubRepoCreateResult{
			Success: false,
			Error:   getGHErrorMessage(result),
		}
	}
	pushArgs := []string{"push", "--set-upstream", "origin", "HEAD"}
	if strings.TrimSpace(bare.Stdout) == "true" {
		pushArgs = []string{"push", "origin", "--mirror"}
	}
	push := g.forCreatedRepository(result.Stdout).RunGit(localPath, pushArgs...)
	if !push.Success {
		return GitHubRepoCreateResult{Error: getErrorMessage(push)}
	}

	// Construct the full name for the result
	fullName := name
	if owner != "" && name != "" {
		fullName = owner + "/" + name
	}

	return GitHubRepoCreateResult{
		Success: true,
		Repo: GitHubRepo{
			Name:     name,
			FullName: fullName,
			Private:  private,
		},
	}
}

// A successful GitHub creation already established usable authentication.
// Other hosts still need their independent github.com authentication decision.
func (g *GitHubService) forCreatedRepository(repoURL string) *CommandRunner {
	u, err := url.Parse(strings.TrimSpace(repoURL))
	if err == nil && u.Hostname() == githubHost {
		return g.runner.forGitOperation(true)
	}
	return g.runner.forGitOperation()
}

// createdRepoRemote preserves the protocol selected by gh for a newly created
// repository. Creation prints its canonical URL even when the input was a name.
func (g *GitHubService) createdRepoRemote(workDir, repoURL string) (string, string) {
	u, err := url.Parse(repoURL)
	if err != nil || u.Host == "" || u.Path == "" {
		return "", "GitHub CLI did not return the created repository URL"
	}
	protocol := g.runner.RunGh(workDir, "config", "get", "git_protocol", "--host", u.Host)
	if !protocol.Success {
		return "", getGHErrorMessage(protocol)
	}
	if strings.TrimSpace(protocol.Stdout) == "ssh" {
		return "git@" + u.Host + ":" + strings.TrimPrefix(u.Path, "/") + ".git", ""
	}
	return strings.TrimSuffix(repoURL, "/") + ".git", ""
}

// ============================================================================
// Helper Functions
// ============================================================================

// getGHErrorMessage extracts the most informative error message from a gh command result
func getGHErrorMessage(result CommandResult) string {
	// gh typically outputs errors to stderr
	if result.Stderr != "" {
		// Clean up common prefixes
		errMsg := result.Stderr
		errMsg = strings.TrimPrefix(errMsg, "error: ")
		errMsg = strings.TrimPrefix(errMsg, "Error: ")
		errMsg = strings.TrimSpace(errMsg)
		lowerErr := strings.ToLower(errMsg)
		if strings.Contains(lowerErr, "failed to execute prompt script") ||
			strings.Contains(lowerErr, "could not read username for 'https://github.com'") ||
			(strings.Contains(lowerErr, "terminal prompts disabled") && strings.Contains(lowerErr, "github.com")) ||
			strings.Contains(lowerErr, "/dev/tty") {
			return "GitHub authentication failed. Connect GitHub in IOFabrik and retry."
		}
		return errMsg
	}
	if result.Error != "" {
		return result.Error
	}
	return "Unknown error"
}

// getString safely extracts a string from a map
func getString(m map[string]interface{}, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// getBool safely extracts a bool from a map
func getBool(m map[string]interface{}, key string) bool {
	if v, ok := m[key].(bool); ok {
		return v
	}
	return false
}

// formatInt converts an int to a string
func formatInt(n int) string {
	return strconv.Itoa(n)
}

// isValidGitHubOwner validates a GitHub username or organization name
// GitHub usernames: alphanumeric and hyphens, cannot start with hyphen, max 39 chars
func isValidGitHubOwner(owner string) bool {
	if len(owner) == 0 || len(owner) > 39 {
		return false
	}
	if owner[0] == '-' {
		return false
	}
	validOwnerPattern := regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9-]*$`)
	return validOwnerPattern.MatchString(owner)
}

// isValidGitHubRepoName validates a GitHub repository name
// Repo names: alphanumeric, hyphens, underscores, periods, max 100 chars
func isValidGitHubRepoName(name string) bool {
	if len(name) == 0 || len(name) > 100 {
		return false
	}
	validRepoPattern := regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)
	return validRepoPattern.MatchString(name)
}
