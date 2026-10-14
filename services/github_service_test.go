package services

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// installFakeGh replaces the resolved gh binary with a shell script for the
// duration of a test so Change Request gh calls run deterministically offline.
func installFakeGh(t *testing.T, script string) {
	t.Helper()
	fakeGh := filepath.Join(t.TempDir(), "gh")
	if err := os.WriteFile(fakeGh, []byte(script), 0755); err != nil {
		t.Fatalf("write fake gh: %v", err)
	}
	resolveMu.Lock()
	resolvedGh = fakeGh
	resolveOnce = sync.Once{}
	resolveOnce.Do(func() {})
	resolveMu.Unlock()
	t.Cleanup(RefreshCLIPaths)
}

func readChangeRequestFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "change_requests", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return data
}

func TestMapGitHubAuthenticatedUserJSON(t *testing.T) {
	result := mapGitHubAuthenticatedUserJSON(readChangeRequestFixture(t, "authenticated_user.json"))
	if !result.Success {
		t.Fatalf("expected success, got %s", result.Error)
	}
	if result.User.Login != "iofabrik-user" || result.User.ID != "123456" || result.User.Name != "" {
		t.Fatalf("unexpected user mapping: %#v", result.User)
	}
}

func TestMapGitHubAuthenticatedUserJSONRejectsMalformedOrMissingLogin(t *testing.T) {
	for _, input := range [][]byte{[]byte("{"), []byte(`{"id": 1}`)} {
		result := mapGitHubAuthenticatedUserJSON(input)
		if result.Success || result.ErrorCode != GitHubChangeRequestErrorInternal {
			t.Fatalf("expected internal mapping error, got %#v", result)
		}
	}
}

func TestMapGitHubChangeRequestFilesJSON(t *testing.T) {
	result := mapGitHubChangeRequestFilesJSON(readChangeRequestFixture(t, "files-multipage.json"), 3)
	if !result.Success || !result.IsTruncated || result.ErrorCode != GitHubChangeRequestErrorFilesTruncated {
		t.Fatalf("expected truncated successful file result, got %#v", result)
	}
	if len(result.Files) != 2 || result.Files[1].PreviousPath != "config/original.json" {
		t.Fatalf("expected flattened renamed files, got %#v", result.Files)
	}
}

func TestMapGitHubChangeRequestDetailJSON(t *testing.T) {
	result := mapGitHubChangeRequestDetailJSON(readChangeRequestFixture(t, "request-detail.json"))
	if !result.Success {
		t.Fatalf("expected detail mapping success, got %#v", result)
	}
	if result.ChangeRequest.Number != 42 || result.TotalFiles != 3 {
		t.Fatalf("unexpected detail mapping: %#v", result)
	}
	if result.ChangeRequest.ReviewDecision != "" {
		t.Fatalf("expected unavailable review decision to remain empty, got %q", result.ChangeRequest.ReviewDecision)
	}
	if len(result.ChangeRequest.Reviewers) != 1 || result.ChangeRequest.Reviewers[0].Login != "reviewer" {
		t.Fatalf("unexpected reviewer mapping: %#v", result.ChangeRequest.Reviewers)
	}
}

func TestGitHubServiceLoadsChangeRequestDetailAndFiles(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)
	runGitCmd(t, repoPath, "remote", "add", "origin", "https://github.com/iofabrik/plant-project.git")

	tempDir := t.TempDir()
	fakeGh := filepath.Join(tempDir, "gh")
	script := `#!/bin/sh
case "$1" in
repo)
  printf '%s\n' '{"nameWithOwner":"iofabrik/plant-project","url":"https://github.com/iofabrik/plant-project","defaultBranchRef":{"name":"main"}}'
  ;;
pr)
  printf '%s\n' '{"number":42,"title":"Update mixer sequence","url":"https://github.com/iofabrik/plant-project/pull/42","state":"OPEN","author":{"login":"operator"},"headRefName":"work/mixer-interlock","headRefOid":"head-oid","baseRefName":"main","baseRefOid":"base-oid","mergeStateStatus":"CLEAN","changedFiles":2,"reviewRequests":[{"requestedReviewer":{"login":"reviewer"}}]}'
  ;;
api)
  printf '%s\n' '[[{"filename":"logic/Mixer.L5X","status":"modified","additions":12,"deletions":4},{"filename":"config/renamed.json","previous_filename":"config/original.json","status":"renamed","additions":1,"deletions":0}]]'
  ;;
*)
  exit 1
  ;;
esac
`
	if err := os.WriteFile(fakeGh, []byte(script), 0755); err != nil {
		t.Fatalf("write fake gh: %v", err)
	}

	resolveMu.Lock()
	resolvedGh = fakeGh
	resolveOnce = sync.Once{}
	resolveOnce.Do(func() {})
	resolveMu.Unlock()
	t.Cleanup(RefreshCLIPaths)

	service := NewGitHubService()
	detail := service.GetChangeRequest(repoPath, 42)
	if !detail.Success || detail.ChangeRequest.Reviewers[0].Login != "reviewer" || detail.TotalFiles != 2 {
		t.Fatalf("unexpected detail result: %#v", detail)
	}

	files := service.ListChangeRequestFiles(repoPath, 42)
	if !files.Success || files.IsTruncated || len(files.Files) != 2 {
		t.Fatalf("unexpected file result: %#v", files)
	}
	if files.Files[1].PreviousPath != "config/original.json" {
		t.Fatalf("expected renamed file metadata, got %#v", files.Files[1])
	}
}

func TestMapGitHubChangeRequestRepositoryJSON(t *testing.T) {
	result := mapGitHubChangeRequestRepositoryJSON(readChangeRequestFixture(t, "repository.json"))
	if !result.Success {
		t.Fatalf("expected repository mapping success, got %#v", result)
	}
	if result.Repository.NameWithOwner != "iofabrik/plant-project" || result.Repository.DefaultBranch != "main" {
		t.Fatalf("unexpected repository mapping: %#v", result.Repository)
	}
}

func TestMapGitHubChangeRequestListJSONOmitsExternalRequests(t *testing.T) {
	repository := GitHubChangeRequestRepository{NameWithOwner: "iofabrik/plant-project"}
	result := mapGitHubChangeRequestListJSON(readChangeRequestFixture(t, "open_requests.json"), repository)
	if !result.Success || len(result.ChangeRequests) != 1 || result.OmittedExternalCount != 1 {
		t.Fatalf("unexpected request list mapping: %#v", result)
	}
	request := result.ChangeRequests[0]
	if request.Number != 42 || request.Author.Login != "operator" || request.ReviewDecision != "APPROVED" {
		t.Fatalf("unexpected request mapping: %#v", request)
	}
}

func TestChangeRequestRemoteHost(t *testing.T) {
	tests := []struct {
		remoteURL  string
		wantHost   string
		wantGitHub bool
	}{
		{"git@github.com:iofabrik/plant-project.git", "github.com", true},
		{"https://github.com/iofabrik/plant-project.git", "github.com", true},
		{"ssh://git@github.enterprise.example/iofabrik/plant-project.git", "github.enterprise.example", true},
		{"https://github-mirror.example/iofabrik/plant-project.git", "github-mirror.example", false},
		{"https://gitlab.com/iofabrik/plant-project.git", "gitlab.com", false},
	}
	for _, test := range tests {
		host, isGitHub := changeRequestRemoteHost(test.remoteURL)
		if host != test.wantHost || isGitHub != test.wantGitHub {
			t.Errorf("changeRequestRemoteHost(%q) = (%q, %t), want (%q, %t)", test.remoteURL, host, isGitHub, test.wantHost, test.wantGitHub)
		}
	}
}

func TestGetChangeRequestRepositoryClassifiesUnresolvedRepository(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)
	runGitCmd(t, repoPath, "remote", "add", "origin", "https://github.com/iofabrik/missing.git")

	tempDir := t.TempDir()
	fakeGh := filepath.Join(tempDir, "gh")
	script := "#!/bin/sh\necho \"GraphQL: Could not resolve to a Repository with the name 'iofabrik/missing'.\" >&2\nexit 1\n"
	if err := os.WriteFile(fakeGh, []byte(script), 0755); err != nil {
		t.Fatalf("write fake gh: %v", err)
	}

	resolveMu.Lock()
	resolvedGh = fakeGh
	resolveOnce = sync.Once{}
	resolveOnce.Do(func() {})
	resolveMu.Unlock()
	t.Cleanup(RefreshCLIPaths)

	result := NewGitHubService().GetChangeRequestRepository(repoPath)
	if result.Success || result.ErrorCode != GitHubChangeRequestErrorRepositoryUnresolved {
		t.Fatalf("expected repository_unresolved, got %#v", result)
	}
}

func TestMapGitHubChangeRequestError(t *testing.T) {
	tests := []struct {
		message string
		want    GitHubChangeRequestErrorCode
	}{
		{"not logged in to github.com", GitHubChangeRequestErrorAuthRequired},
		{"HTTP 401: Bad credentials", GitHubChangeRequestErrorAuthRequired},
		{"HTTP 403: Resource not accessible by integration", GitHubChangeRequestErrorPermissionDenied},
		{"API rate limit exceeded", GitHubChangeRequestErrorRateLimited},
		{"dial tcp: lookup api.github.com: no such host", GitHubChangeRequestErrorNetworkUnavailable},
		{"unexpected failure", GitHubChangeRequestErrorInternal},
	}
	for _, test := range tests {
		if got := mapGitHubChangeRequestError(CommandResult{Stderr: test.message}); got != test.want {
			t.Errorf("mapGitHubChangeRequestError(%q) = %q, want %q", test.message, got, test.want)
		}
	}
}

func TestGitHubServiceGetAuthenticatedUserUsesGHAPI(t *testing.T) {
	tempDir := t.TempDir()
	argsPath := filepath.Join(tempDir, "args")
	fakeGh := filepath.Join(tempDir, "gh")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > '" + argsPath + "'\nprintf '%s\\n' '{\"login\":\"fixture-user\",\"id\":42,\"type\":\"User\",\"name\":\"Fixture\"}'\n"
	if err := os.WriteFile(fakeGh, []byte(script), 0755); err != nil {
		t.Fatalf("write fake gh: %v", err)
	}

	resolveMu.Lock()
	resolvedGh = fakeGh
	resolveOnce = sync.Once{}
	resolveOnce.Do(func() {})
	resolveMu.Unlock()
	t.Cleanup(RefreshCLIPaths)

	result := NewGitHubService().GetAuthenticatedUser()
	if !result.Success || result.User.Login != "fixture-user" {
		t.Fatalf("expected fake gh user, got %#v", result)
	}
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatalf("read fake gh arguments: %v", err)
	}
	if !strings.Contains(string(args), "api\n--hostname\ngithub.com\nuser") {
		t.Fatalf("GetAuthenticatedUser used unexpected gh arguments: %q", args)
	}
}

func TestGitHubService_IsGHInstalled(t *testing.T) {
	svc := NewGitHubService()
	installed := svc.IsGHInstalled()
	// This test just checks that the method runs without panic
	// The result depends on whether gh is installed on the system
	t.Logf("GitHub CLI installed: %v", installed)
}

func TestGitHubService_GetGHVersion(t *testing.T) {
	svc := NewGitHubService()
	version := svc.GetGHVersion()
	if svc.IsGHInstalled() && version == "" {
		t.Error("Expected version string when gh is installed")
	}
	t.Logf("GitHub CLI version: %s", version)
}

func TestGitHubServiceAuthStatusUsesStructuredUserQuery(t *testing.T) {
	for _, tt := range []struct {
		name string
		json string
		code GitHubChangeRequestErrorCode
	}{
		{"active account", `{"login":"operator","id":42,"type":"User","name":"Operator"}`, ""},
		{"malformed JSON", `{`, GitHubChangeRequestErrorInternal},
		{"missing login", `{"id":42}`, GitHubChangeRequestErrorInternal},
	} {
		t.Run(tt.name, func(t *testing.T) {
			// The bundled gh 2.65 supports api --jq but not auth status --json.
			installFakeGh(t, "#!/bin/sh\n"+
				"[ \"$*\" = 'api --hostname github.com user --jq {login,id,type,name}' ] || exit 9\n"+
				"printf '%s\\n' '"+tt.json+"'\n")
			status := NewGitHubService().AuthStatus()
			if status.LoggedIn != (tt.code == "") || status.Host != "github.com" || status.ErrorCode != tt.code {
				t.Fatalf("unexpected status: %#v", status)
			}
			if status.LoggedIn && (status.Username != "operator" || status.AccountType != "user" || status.Error != "") {
				t.Fatalf("unexpected account details: %#v", status)
			}
		})
	}
}

func TestGitHubServiceAuthStatusClassifiesFailures(t *testing.T) {
	for _, tt := range []struct {
		name, output string
		code         GitHubChangeRequestErrorCode
	}{
		{"signed out", "To get started with GitHub CLI, please run: gh auth login", GitHubChangeRequestErrorAuthRequired},
		{"no account for host", "You are not logged into any accounts on github.com", GitHubChangeRequestErrorAuthRequired},
		{"expired credentials", "gh: Bad credentials (HTTP 401)", GitHubChangeRequestErrorAuthRequired},
		{"DNS failure", "Get https://api.github.com/user: dial tcp: lookup api.github.com: no such host", GitHubChangeRequestErrorNetworkUnavailable},
		{"connection failure", "error connecting to api.github.com", GitHubChangeRequestErrorNetworkUnavailable},
		{"timeout", "context deadline exceeded", GitHubChangeRequestErrorNetworkUnavailable},
		{"rate limit", "API rate limit exceeded", GitHubChangeRequestErrorRateLimited},
		{"unknown failure", "unexpected diagnostic detail", GitHubChangeRequestErrorInternal},
	} {
		t.Run(tt.name, func(t *testing.T) {
			installFakeGh(t, "#!/bin/sh\nprintf '%s\\n' '"+tt.output+"' >&2\nexit 1\n")
			status := NewGitHubService().AuthStatus()
			if status.LoggedIn || status.ErrorCode != tt.code || status.Error == "" || strings.Contains(status.Error, "diagnostic") {
				t.Fatalf("unexpected command failure: %#v", status)
			}
		})
	}
}

func TestGitHubService_AuthStatus(t *testing.T) {
	svc := NewGitHubService()
	if !svc.IsGHInstalled() {
		t.Skip("gh CLI not installed")
	}

	status := svc.AuthStatus()
	t.Logf("Auth status - LoggedIn: %v, Username: %s, Error: %s",
		status.LoggedIn, status.Username, status.Error)
}

func TestGitHubService_RepoList(t *testing.T) {
	svc := NewGitHubService()
	if !svc.IsGHInstalled() {
		t.Skip("gh CLI not installed")
	}

	status := svc.AuthStatus()
	if !status.LoggedIn {
		t.Skip("Not logged in to GitHub")
	}

	result := svc.RepoList(5, "")
	if !result.Success {
		t.Errorf("RepoList failed: %s", result.Error)
		return
	}

	t.Logf("Found %d repositories", len(result.Repos))
	for _, repo := range result.Repos {
		t.Logf("  - %s (private: %v)", repo.FullName, repo.Private)
	}
}

func TestGitHubService_RepoList_Visibility(t *testing.T) {
	svc := NewGitHubService()
	if !svc.IsGHInstalled() {
		t.Skip("gh CLI not installed")
	}

	status := svc.AuthStatus()
	if !status.LoggedIn {
		t.Skip("Not logged in to GitHub")
	}

	// Test public repos
	publicResult := svc.RepoList(5, "public")
	if publicResult.Success {
		t.Logf("Found %d public repositories", len(publicResult.Repos))
	}

	// Test private repos
	privateResult := svc.RepoList(5, "private")
	if privateResult.Success {
		t.Logf("Found %d private repositories", len(privateResult.Repos))
	}
}

func TestFormatInt(t *testing.T) {
	tests := []struct {
		input    int
		expected string
	}{
		{0, "0"},
		{1, "1"},
		{10, "10"},
		{100, "100"},
		{-1, "-1"},
		{30, "30"},
	}

	for _, test := range tests {
		result := formatInt(test.input)
		if result != test.expected {
			t.Errorf("formatInt(%d) = %s, expected %s", test.input, result, test.expected)
		}
	}
}

func TestGitHubService_AuthLogout(t *testing.T) {
	// Never run logout against the developer's real GitHub CLI or config.
	t.Setenv("GH_CONFIG_DIR", t.TempDir())
	for _, test := range []struct {
		name, script, message string
	}{
		{"logged in", "#!/bin/sh\nread confirmation\n[ \"$confirmation\" = y ] || exit 2\nexit 0\n", "Logged out successfully"},
		{"already logged out", "#!/bin/sh\nprintf '%s\\n' 'not logged in' >&2\nexit 1\n", "Already logged out"},
	} {
		t.Run(test.name, func(t *testing.T) {
			installFakeGh(t, test.script)
			result := NewGitHubService().AuthLogout()
			if !result.Success || result.Message != test.message {
				t.Fatalf("unexpected logout result: %+v", result)
			}
		})
	}
}

func TestChangeRequestURLHelpers(t *testing.T) {
	cases := []struct {
		name   string
		output string
		url    string
		number int
	}{
		{"clean url", "https://github.com/o/r/pull/42\n", "https://github.com/o/r/pull/42", 42},
		{"url among noise", "Creating pull request for feature into main\nhttps://github.com/o/r/pull/7\n", "https://github.com/o/r/pull/7", 7},
		{"trailing slash", "https://github.com/o/r/pull/13/\n", "https://github.com/o/r/pull/13/", 13},
		{"query suffix", "https://github.com/o/r/pull/99?tab=files", "https://github.com/o/r/pull/99?tab=files", 99},
		{"no url", "gh: could not create pull request", "gh: could not create pull request", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotURL := extractChangeRequestURL(tc.output)
			if gotURL != tc.url {
				t.Fatalf("extractChangeRequestURL = %q, want %q", gotURL, tc.url)
			}
			if gotNumber := changeRequestNumberFromURL(gotURL); gotNumber != tc.number {
				t.Fatalf("changeRequestNumberFromURL(%q) = %d, want %d", gotURL, gotNumber, tc.number)
			}
		})
	}
}

func TestCreateChangeRequestValidatesInput(t *testing.T) {
	svc := NewGitHubService()
	cases := []struct {
		name string
		opts GitHubCreateChangeRequestOptions
	}{
		{"missing title", GitHubCreateChangeRequestOptions{SourceBranch: "work", TargetBranch: "main"}},
		{"missing source", GitHubCreateChangeRequestOptions{Title: "Update", TargetBranch: "main"}},
		{"missing target", GitHubCreateChangeRequestOptions{Title: "Update", SourceBranch: "work"}},
		{"same branch", GitHubCreateChangeRequestOptions{Title: "Update", SourceBranch: "work", TargetBranch: "WORK"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Validation returns before any git or gh call, so a bare temp dir is enough.
			result := svc.CreateChangeRequest(t.TempDir(), tc.opts)
			if result.Success || result.ErrorCode != GitHubChangeRequestErrorInternal {
				t.Fatalf("expected internal validation error, got %#v", result)
			}
		})
	}
}

func TestVerifyBranchSyncedForChangeRequest(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git unavailable: %v", err)
	}
	root := t.TempDir()
	runGitCmd(t, root, "init", "--bare", "-b", "main", "origin.git")
	originPath := filepath.Join(root, "origin.git")
	workPath := filepath.Join(root, "work")
	runGitCmd(t, root, "clone", originPath, "work")
	configureChangeRequestIdentity(t, workPath)
	commitChangeRequestFile(t, workPath, "shared.txt", "base\n", "base commit")
	runGitCmd(t, workPath, "push", "origin", "main")
	runGitCmd(t, workPath, "checkout", "-b", "feature/x")
	commitChangeRequestFile(t, workPath, "logic.txt", "feature\n", "feature commit")
	runGitCmd(t, workPath, "push", "-u", "origin", "feature/x")

	svc := NewGitHubService()
	if _, _, ok := svc.verifyBranchSyncedForChangeRequest(workPath, "feature/x"); !ok {
		t.Fatalf("expected a pushed, synced branch to pass")
	}

	// A local commit that is not pushed leaves the branch ahead of origin.
	commitChangeRequestFile(t, workPath, "ahead.txt", "ahead\n", "ahead commit")
	if code, _, ok := svc.verifyBranchSyncedForChangeRequest(workPath, "feature/x"); ok || code != GitHubChangeRequestErrorBranchNotSynced {
		t.Fatalf("expected branch_not_synced for an unpushed commit, got code=%q ok=%v", code, ok)
	}

	// An uncommitted change is caught before the remote comparison.
	writeChangeRequestFile(t, workPath, "dirty.txt", "dirty\n")
	if code, _, ok := svc.verifyBranchSyncedForChangeRequest(workPath, "feature/x"); ok || code != GitHubChangeRequestErrorBranchNotSynced {
		t.Fatalf("expected branch_not_synced for a dirty working tree, got code=%q ok=%v", code, ok)
	}
}

func TestFindOpenChangeRequestForBranch(t *testing.T) {
	const repoScript = `repo)
  printf '%s\n' '{"nameWithOwner":"iofabrik/plant-project","url":"https://github.com/iofabrik/plant-project","defaultBranchRef":{"name":"main"}}'
  ;;
`

	newRepo := func(t *testing.T) string {
		repoPath := createTestRepo(t)
		t.Cleanup(func() { cleanupTestRepo(t, repoPath) })
		runGitCmd(t, repoPath, "remote", "add", "origin", "https://github.com/iofabrik/plant-project.git")
		return repoPath
	}

	t.Run("empty source is rejected before any gh call", func(t *testing.T) {
		svc := NewGitHubService()
		result := svc.FindOpenChangeRequestForBranch(t.TempDir(), "   ")
		if result.Success || result.ErrorCode != GitHubChangeRequestErrorInternal {
			t.Fatalf("expected internal error for empty source, got %#v", result)
		}
	})

	t.Run("finds an existing open request", func(t *testing.T) {
		repoPath := newRepo(t)
		installFakeGh(t, "#!/bin/sh\ncase \"$1\" in\n"+repoScript+`pr)
  printf '%s\n' '[{"number":7,"title":"Update mixer","url":"https://github.com/iofabrik/plant-project/pull/7","state":"OPEN","author":{"login":"operator"},"headRefName":"feature/x","baseRefName":"main","isCrossRepository":false}]'
  ;;
*) exit 1 ;;
esac
`)
		result := NewGitHubService().FindOpenChangeRequestForBranch(repoPath, "feature/x")
		if !result.Success || !result.Found || result.ChangeRequest.Number != 7 {
			t.Fatalf("expected to find request #7, got %#v", result)
		}
	})

	t.Run("reports no request when the list is empty", func(t *testing.T) {
		repoPath := newRepo(t)
		installFakeGh(t, "#!/bin/sh\ncase \"$1\" in\n"+repoScript+`pr)
  printf '%s\n' '[]'
  ;;
*) exit 1 ;;
esac
`)
		result := NewGitHubService().FindOpenChangeRequestForBranch(repoPath, "feature/x")
		if !result.Success || result.Found {
			t.Fatalf("expected no request found, got %#v", result)
		}
	})

	t.Run("skips cross-repository requests", func(t *testing.T) {
		repoPath := newRepo(t)
		installFakeGh(t, "#!/bin/sh\ncase \"$1\" in\n"+repoScript+`pr)
  printf '%s\n' '[{"number":9,"title":"Fork change","url":"https://github.com/fork/plant-project/pull/9","state":"OPEN","author":{"login":"outsider"},"headRefName":"feature/x","baseRefName":"main","isCrossRepository":true}]'
  ;;
*) exit 1 ;;
esac
`)
		result := NewGitHubService().FindOpenChangeRequestForBranch(repoPath, "feature/x")
		if !result.Success || result.Found {
			t.Fatalf("expected cross-repository request to be skipped, got %#v", result)
		}
	})
}
