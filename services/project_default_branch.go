package services

import (
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
)

// ProjectDefaultBranchPreference is personal to this project. Automatic
// results are bound to origin's identity; a manual choice is retained until reset.
type ProjectDefaultBranchPreference struct {
	ManualBranch      string `json:"manualBranch,omitempty"`
	AutomaticBranch   string `json:"automaticBranch,omitempty"`
	AutomaticOrigin   string `json:"automaticOrigin,omitempty"`
	InitializedBranch string `json:"initializedBranch,omitempty"`
}

type ProjectDefaultBranchMode string

const (
	ProjectDefaultAutomatic ProjectDefaultBranchMode = "automatic"
	ProjectDefaultManual    ProjectDefaultBranchMode = "manual"
)

type ProjectDefaultBranchAvailability string

const (
	ProjectDefaultReady          ProjectDefaultBranchAvailability = "ready"
	ProjectDefaultNeedsSelection ProjectDefaultBranchAvailability = "needs-selection"
)

// ProjectDefaultBranchResult separates usable local identity from discovery
// diagnostics. Consumers must check Availability, not whether lookup succeeded.
type ProjectDefaultBranchResult struct {
	EffectiveBranch  string                           `json:"effectiveBranch"`
	Mode             ProjectDefaultBranchMode         `json:"mode"`
	Availability     ProjectDefaultBranchAvailability `json:"availability"`
	OriginRepository string                           `json:"originRepository"`
	LookupStatus     string                           `json:"lookupStatus"`
	LookupMessage    string                           `json:"lookupMessage"`
	Choices          []string                         `json:"choices"`
}

// Services can be constructed independently (including by initialization), so
// serialize personal-config read/modify/write across service instances.
var projectDefaultBranchMu sync.Mutex

// originGitHubRepository accepts GitHub HTTPS and SSH origins. It never lets gh
// infer a repository from another remote, and never persists embedded credentials.
func originGitHubRepository(remote string) string {
	if strings.HasPrefix(remote, "git@") {
		remote = "ssh://" + strings.Replace(remote, ":", "/", 1)
	}
	parsed, err := url.Parse(remote)
	if err != nil || !strings.EqualFold(parsed.Hostname(), "github.com") ||
		(parsed.Scheme != "https" && parsed.Scheme != "http" && parsed.Scheme != "ssh" && parsed.Scheme != "git") {
		return ""
	}
	path := strings.TrimSuffix(strings.Trim(parsed.Path, "/"), ".git")
	parts := strings.Split(path, "/")
	if len(parts) != 2 || !isValidGitHubOwner(parts[0]) || !isValidGitHubRepoName(parts[1]) {
		return ""
	}
	return strings.Join(parts, "/")
}

func (r *RepositorySettingsService) projectDefaultOrigin(repoPath string) (string, string) {
	remote := r.runner.RunGit(repoPath, "config", "--get", "remote.origin.url")
	if !remote.Success {
		return "", ""
	}
	origin := strings.TrimSpace(remote.Stdout)
	return origin, originGitHubRepository(origin)
}

func (r *RepositorySettingsService) projectDefaultChoices(repoPath string) []string {
	choices := make(map[string]bool)
	refs := r.runner.RunGit(repoPath, "for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/origin/")
	if refs.Success {
		for _, ref := range strings.Split(strings.TrimSpace(refs.Stdout), "\n") {
			if strings.HasPrefix(ref, "refs/heads/") {
				choices[strings.TrimPrefix(ref, "refs/heads/")] = true
			} else if strings.HasPrefix(ref, "refs/remotes/origin/") && ref != "refs/remotes/origin/HEAD" {
				choices[strings.TrimPrefix(ref, "refs/remotes/origin/")] = true
			}
		}
	}
	// An imported unborn branch is offered as an explicit choice, never inferred
	// as the default. Only initialized or manually selected unborn names are ready.
	if unborn := r.projectUnbornBranch(repoPath); unborn != "" {
		choices[unborn] = true
	}
	result := make([]string, 0, len(choices))
	for name := range choices {
		result = append(result, name)
	}
	sort.Strings(result)
	return result
}

func (r *RepositorySettingsService) projectUnbornBranch(repoPath string) string {
	if r.runner.RunGit(repoPath, "rev-parse", "--verify", "HEAD").Success {
		return ""
	}
	head := r.runner.RunGit(repoPath, "symbolic-ref", "--quiet", "HEAD")
	if head.Success && strings.HasPrefix(strings.TrimSpace(head.Stdout), "refs/heads/") {
		return strings.TrimPrefix(strings.TrimSpace(head.Stdout), "refs/heads/")
	}
	return ""
}

func (r *RepositorySettingsService) projectDefaultUsable(repoPath, branch string, allowUnborn bool) bool {
	if branch == "" || !r.runner.RunGit(repoPath, "check-ref-format", "refs/heads/"+branch).Success {
		return false
	}
	for _, ref := range []string{"refs/heads/" + branch, "refs/remotes/origin/" + branch} {
		if r.runner.RunGit(repoPath, "show-ref", "--verify", "--quiet", ref).Success {
			return true
		}
	}
	return allowUnborn && r.projectUnbornBranch(repoPath) == branch
}

func (r *RepositorySettingsService) resolveProjectDefault(repoPath string, config RepoPersonalConfig, origin, repository string) ProjectDefaultBranchResult {
	preference := config.DefaultBranch
	result := ProjectDefaultBranchResult{
		Mode: ProjectDefaultAutomatic, Availability: ProjectDefaultNeedsSelection,
		OriginRepository: repository, LookupStatus: "not-requested", Choices: r.projectDefaultChoices(repoPath),
	}
	branch := ""
	allowUnborn := false
	if preference.ManualBranch != "" {
		result.Mode = ProjectDefaultManual
		branch, allowUnborn = preference.ManualBranch, true
	} else if repository != "" && strings.EqualFold(preference.AutomaticOrigin, repository) {
		branch = preference.AutomaticBranch
		result.LookupStatus = "cached"
	} else if origin == "" {
		branch, allowUnborn = preference.InitializedBranch, true
	}
	if r.projectDefaultUsable(repoPath, branch, allowUnborn) {
		result.EffectiveBranch, result.Availability = branch, ProjectDefaultReady
	}
	return result
}

// GetProjectDefaultBranch validates persisted identity locally without network
// access. Use it at action entry points; discovery is reserved for open/refresh.
func (r *RepositorySettingsService) GetProjectDefaultBranch(repoPath string) ProjectDefaultBranchResult {
	projectDefaultBranchMu.Lock()
	defer projectDefaultBranchMu.Unlock()
	return r.projectDefaultBranch(repoPath, false)
}

// RefreshProjectDefaultBranch explicitly discovers origin's GitHub default and
// retains the last successful result for offline use. Manual choices survive it.
func (r *RepositorySettingsService) RefreshProjectDefaultBranch(repoPath string) ProjectDefaultBranchResult {
	projectDefaultBranchMu.Lock()
	defer projectDefaultBranchMu.Unlock()
	return r.projectDefaultBranch(repoPath, true)
}

func (r *RepositorySettingsService) projectDefaultBranch(repoPath string, refresh bool) (result ProjectDefaultBranchResult) {
	config, err := r.readRepoPersonalConfig(repoPath)
	origin, repository := r.projectDefaultOrigin(repoPath)
	result = r.resolveProjectDefault(repoPath, config, origin, repository)
	if err != nil {
		result.LookupStatus = "settings-error"
		result.LookupMessage = "Personal settings could not be read. Check the project folder and try again."
		return result
	}
	if !refresh {
		return result
	}
	// Discovery may outlive changes to origin or the available refs. Revalidate
	// on every refresh exit, including unavailable tools, failed requests and
	// unusable metadata, while keeping lookup diagnostics separate from readiness.
	defer func() {
		status, message := result.LookupStatus, result.LookupMessage
		currentOrigin, currentRepository := r.projectDefaultOrigin(repoPath)
		result = r.resolveProjectDefault(repoPath, config, currentOrigin, currentRepository)
		result.LookupStatus, result.LookupMessage = status, message
	}()
	if repository == "" {
		result.LookupStatus = "not-github"
		result.LookupMessage = "Choose a default branch for this project."
		return result
	}
	github := NewGitHubService()
	github.runner = r.runner
	if !github.IsGHInstalled() {
		result.LookupStatus = "unavailable"
		result.LookupMessage = "GitHub CLI is unavailable. Install it or choose a branch."
		return result
	}
	lookup := r.runner.Run(repoPath, GhPath(), "repo", "view", repository, "--json", "nameWithOwner,defaultBranchRef")
	if !lookup.Success {
		result.LookupStatus = "unavailable"
		result.LookupMessage = "GitHub's default could not be checked. Check your connection and sign-in, or choose a branch."
		return result
	}
	metadata := mapGitHubChangeRequestRepositoryJSON([]byte(lookup.Stdout))
	if !metadata.Success || metadata.Repository.DefaultBranch == "" {
		result.LookupStatus = "no-default"
		result.LookupMessage = "GitHub did not provide a default branch. Choose a branch or try refreshing."
		return result
	}
	updated := config
	updated.DefaultBranch.AutomaticBranch = metadata.Repository.DefaultBranch
	updated.DefaultBranch.AutomaticOrigin = repository
	if saved := r.writeRepoPersonalConfig(repoPath, updated); !saved.Success {
		result.LookupStatus, result.LookupMessage = "settings-error", saved.Error
		return result
	}
	// Failed persistence must continue to resolve the previous stored preference.
	config = updated
	result.LookupStatus = "github"
	return result
}

// SetProjectDefaultBranch stores an exact manual selection after the UI's
// confirmation. It changes neither the checkout nor GitHub's default.
func (r *RepositorySettingsService) SetProjectDefaultBranch(repoPath, branch string) OperationResult {
	projectDefaultBranchMu.Lock()
	defer projectDefaultBranchMu.Unlock()
	config, err := r.readRepoPersonalConfig(repoPath)
	if err != nil {
		return failedOp("Personal settings could not be read. Check the project folder and try again.")
	}
	if !r.projectDefaultUsable(repoPath, branch, true) {
		return failedOp("That branch is unavailable. Refresh the project and choose an available branch.")
	}
	config.DefaultBranch.ManualBranch = branch
	return r.writeRepoPersonalConfig(repoPath, config)
}

// UseGitHubDefault switches modes only when discovery or the stored automatic
// result is usable. Failure leaves the manual preference untouched.
func (r *RepositorySettingsService) UseGitHubDefault(repoPath string) OperationResult {
	projectDefaultBranchMu.Lock()
	defer projectDefaultBranchMu.Unlock()
	if refreshed := r.projectDefaultBranch(repoPath, true); refreshed.LookupStatus == "settings-error" {
		return failedOp(refreshed.LookupMessage)
	}
	config, err := r.readRepoPersonalConfig(repoPath)
	if err != nil {
		return failedOp("Personal settings could not be read. Check the project folder and try again.")
	}
	origin, repository := r.projectDefaultOrigin(repoPath)
	config.DefaultBranch.ManualBranch = ""
	if r.resolveProjectDefault(repoPath, config, origin, repository).Availability != ProjectDefaultReady || repository == "" {
		return failedOp("GitHub's default branch is unavailable. Keep your selection and try refreshing when connected.")
	}
	return r.writeRepoPersonalConfig(repoPath, config)
}

func (r *RepositorySettingsService) recordInitializedDefaultBranch(repoPath, branch string) OperationResult {
	projectDefaultBranchMu.Lock()
	defer projectDefaultBranchMu.Unlock()
	config, err := r.readRepoPersonalConfig(repoPath)
	if err != nil {
		return failedOp("The new project's settings could not be saved. Check the project folder and try again.")
	}
	config.DefaultBranch.InitializedBranch = branch
	return r.writeRepoPersonalConfig(repoPath, config)
}

func writePersonalConfigAtomic(directory, destination string, data []byte, replace func(string, string) error) error {
	file, err := os.CreateTemp(directory, personalConfigTempPattern)
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return replace(file.Name(), destination)
}
