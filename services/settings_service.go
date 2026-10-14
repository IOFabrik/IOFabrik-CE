package services

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// SettingsService manages app and user settings
type SettingsService struct {
	runner      *CommandRunner
	settingsDir string
	legacyDir   string
	app         *application.App
}

// NewSettingsService creates a new SettingsService
func NewSettingsService() *SettingsService {
	locations := GetDataLocationsSnapshot()

	return &SettingsService{
		runner:      NewCommandRunner(),
		settingsDir: locations.RoamingConfigDir,
		legacyDir:   locations.LegacyRoamingConfigDir,
	}
}

// SetApp sets the application reference (called after app initialization)
func (s *SettingsService) SetApp(app *application.App) {
	s.app = app
}

// AppSettings contains application preferences
type AppSettings struct {
	Theme                string   `json:"theme"`                // "dark", "light", "system"
	LastRepoPath         string   `json:"lastRepoPath"`         // Last opened repository path
	RecentFolders        []string `json:"recentFolders"`        // Recently opened folders (max 10)
	DeveloperModeEnabled bool     `json:"developerModeEnabled"` // Show internal developer tools and diagnostics
	TimelineHeight       int      `json:"timelineHeight"`       // Preferred Explorer Timeline height in pixels
}

func defaultAppSettings() AppSettings {
	return AppSettings{
		Theme:                "dark",
		DeveloperModeEnabled: false,
		TimelineHeight:       160,
	}
}

// UserProfile contains git user configuration
type UserProfile struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

// DetectedIdentity contains the resolved git identity and where each field came from.
// Used by EnsureIdentity to report what was found and whether it had to auto-set anything.
type DetectedIdentity struct {
	Name        string `json:"name"`
	Email       string `json:"email"`
	NameSource  string `json:"nameSource"`  // "local", "global", "auto-set"
	EmailSource string `json:"emailSource"` // "local", "global", "auto-set"
	WasAutoSet  bool   `json:"wasAutoSet"`  // true if we wrote to local config
}

// GetAppSettings returns the current app settings
func (s *SettingsService) GetAppSettings() AppSettings {
	done := LogMethod("SettingsService.GetAppSettings", nil)
	defer func() { done(nil, nil) }()

	settings := defaultAppSettings()

	settingsPath := filepath.Join(s.settingsDir, "settings.json")
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		legacySettingsPath := filepath.Join(s.legacyDir, "settings.json")
		legacyData, legacyErr := os.ReadFile(legacySettingsPath)
		if legacyErr != nil {
			return settings
		}
		decodeAppSettings(legacyData, &settings)
		return settings
	}

	decodeAppSettings(data, &settings)
	return settings
}

func decodeAppSettings(data []byte, settings *AppSettings) {
	defaults := defaultAppSettings()
	settings.Theme = defaults.Theme
	settings.DeveloperModeEnabled = defaults.DeveloperModeEnabled
	settings.TimelineHeight = defaults.TimelineHeight
	_ = json.Unmarshal(data, settings)

	if strings.TrimSpace(settings.Theme) == "" {
		settings.Theme = defaults.Theme
	}
	if settings.TimelineHeight < 80 || settings.TimelineHeight > 320 {
		settings.TimelineHeight = defaults.TimelineHeight
	}
}

// GetDataLocations returns the active and legacy data locations for diagnostics.
func (s *SettingsService) GetDataLocations() DataLocations {
	return GetDataLocationsSnapshot()
}

// SaveAppSettings saves the app settings
func (s *SettingsService) SaveAppSettings(settings AppSettings) error {
	done := LogMethod("SettingsService.SaveAppSettings", nil)
	defer func() { done(nil, nil) }()

	// Ensure settings directory exists
	if err := os.MkdirAll(s.settingsDir, 0755); err != nil {
		return err
	}

	settingsPath := filepath.Join(s.settingsDir, "settings.json")
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(settingsPath, data, 0644)
}

// maxRecentFolders is the maximum number of recent folders to keep
const maxRecentFolders = 10

// GetRecentFolders returns the list of recently opened folders
func (s *SettingsService) GetRecentFolders() []string {
	settings := s.GetAppSettings()
	if settings.RecentFolders == nil {
		return []string{}
	}
	return settings.RecentFolders
}

// AddRecentFolder adds a folder to the recent folders list
// It moves the folder to the front if it already exists
func (s *SettingsService) AddRecentFolder(folderPath string) error {
	if folderPath == "" {
		return nil
	}

	settings := s.GetAppSettings()
	if settings.RecentFolders == nil {
		settings.RecentFolders = []string{}
	}

	// Remove if already exists (will re-add at front)
	filtered := []string{}
	for _, f := range settings.RecentFolders {
		if f != folderPath {
			filtered = append(filtered, f)
		}
	}

	// Add to front
	settings.RecentFolders = append([]string{folderPath}, filtered...)

	// Limit to maxRecentFolders
	if len(settings.RecentFolders) > maxRecentFolders {
		settings.RecentFolders = settings.RecentFolders[:maxRecentFolders]
	}

	// Also update LastRepoPath
	settings.LastRepoPath = folderPath

	return s.SaveAppSettings(settings)
}

// ClearRecentFolders clears the recent folders list
func (s *SettingsService) ClearRecentFolders() error {
	settings := s.GetAppSettings()
	settings.RecentFolders = []string{}
	return s.SaveAppSettings(settings)
}

// GetUserProfile returns the git user config (global or for a specific repo)
// Uses concurrent goroutines to fetch name and email in parallel
func (s *SettingsService) GetUserProfile(repoPath string) UserProfile {
	profile := UserProfile{}

	// No repository path means "global profile" (used by Settings > Git Identity).
	// Avoid plain `git config user.name` here because it can behave like a local
	// lookup and fail outside a repository on Windows packaged builds.
	if repoPath == "" {
		var wg sync.WaitGroup
		var nameResult, emailResult CommandResult

		wg.Add(2)
		go func() {
			defer wg.Done()
			nameResult = s.runner.RunGit(".", "config", "--global", "user.name")
		}()
		go func() {
			defer wg.Done()
			emailResult = s.runner.RunGit(".", "config", "--global", "user.email")
		}()
		wg.Wait()

		if nameResult.Success {
			profile.Name = strings.TrimSpace(nameResult.Stdout)
		}
		if emailResult.Success {
			profile.Email = strings.TrimSpace(emailResult.Stdout)
		}

		return profile
	}

	// Repo profile: prefer local values, then fall back to global.
	var wg sync.WaitGroup
	var localName, localEmail, globalName, globalEmail CommandResult

	wg.Add(4)
	go func() {
		defer wg.Done()
		localName = s.runner.RunGit(repoPath, "config", "--local", "user.name")
	}()
	go func() {
		defer wg.Done()
		localEmail = s.runner.RunGit(repoPath, "config", "--local", "user.email")
	}()
	go func() {
		defer wg.Done()
		globalName = s.runner.RunGit(repoPath, "config", "--global", "user.name")
	}()
	go func() {
		defer wg.Done()
		globalEmail = s.runner.RunGit(repoPath, "config", "--global", "user.email")
	}()
	wg.Wait()

	if localName.Success && strings.TrimSpace(localName.Stdout) != "" {
		profile.Name = strings.TrimSpace(localName.Stdout)
	} else if globalName.Success {
		profile.Name = strings.TrimSpace(globalName.Stdout)
	}

	if localEmail.Success && strings.TrimSpace(localEmail.Stdout) != "" {
		profile.Email = strings.TrimSpace(localEmail.Stdout)
	} else if globalEmail.Success {
		profile.Email = strings.TrimSpace(globalEmail.Stdout)
	}

	return profile
}

// SetUserProfile sets the git user config
func (s *SettingsService) SetUserProfile(repoPath string, profile UserProfile, global bool) OperationResult {
	done := LogMethod("SettingsService.SetUserProfile", map[string]interface{}{"repoPath": repoPath, "global": global})
	defer func() { done(nil, nil) }()

	workDir := "."
	if repoPath != "" {
		workDir = repoPath
	}

	// Build base args - use separate slices to avoid append side effects
	globalFlag := []string{}
	if global {
		globalFlag = []string{"--global"}
	}

	// Set user name
	if profile.Name != "" {
		nameArgs := append([]string{"config"}, globalFlag...)
		nameArgs = append(nameArgs, "user.name", profile.Name)
		result := s.runner.RunGit(workDir, nameArgs...)
		if !result.Success {
			return OperationResult{
				Success: false,
				Error:   "Failed to set user name: " + result.Stderr,
			}
		}
	}

	// Set user email
	if profile.Email != "" {
		emailArgs := append([]string{"config"}, globalFlag...)
		emailArgs = append(emailArgs, "user.email", profile.Email)
		result := s.runner.RunGit(workDir, emailArgs...)
		if !result.Success {
			return OperationResult{
				Success: false,
				Error:   "Failed to set user email: " + result.Stderr,
			}
		}
	}

	return OperationResult{
		Success: true,
		Message: "Profile updated successfully",
	}
}

// EnsureIdentity checks that the repo has git user.name and user.email configured.
// If either is missing from both local and global git config, it auto-sets from the
// provided fallback values (typically from the Supabase login) into LOCAL repo config.
//
// Priority (read):  local repo config > global config > fallback
// Priority (write): only writes to local repo config, never touches global
//
// This should be called whenever a repo is opened. The fallbackName and fallbackEmail
// come from the authenticated IOFabrik user (Supabase session).
func (s *SettingsService) EnsureIdentity(repoPath string, fallbackName string, fallbackEmail string) DetectedIdentity {
	done := LogMethod("SettingsService.EnsureIdentity", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()

	identity := DetectedIdentity{}

	if repoPath == "" {
		// No repo open — nothing to ensure
		identity.Name = fallbackName
		identity.Email = fallbackEmail
		identity.NameSource = "auto-set"
		identity.EmailSource = "auto-set"
		return identity
	}

	// Read local and global config concurrently
	var wg sync.WaitGroup
	var localName, localEmail, globalName, globalEmail CommandResult

	wg.Add(4)
	go func() { defer wg.Done(); localName = s.runner.RunGit(repoPath, "config", "--local", "user.name") }()
	go func() { defer wg.Done(); localEmail = s.runner.RunGit(repoPath, "config", "--local", "user.email") }()
	go func() { defer wg.Done(); globalName = s.runner.RunGit(repoPath, "config", "--global", "user.name") }()
	go func() { defer wg.Done(); globalEmail = s.runner.RunGit(repoPath, "config", "--global", "user.email") }()
	wg.Wait()

	// Resolve name: local > global > fallback
	switch {
	case localName.Success && strings.TrimSpace(localName.Stdout) != "":
		identity.Name = strings.TrimSpace(localName.Stdout)
		identity.NameSource = "local"
	case globalName.Success && strings.TrimSpace(globalName.Stdout) != "":
		identity.Name = strings.TrimSpace(globalName.Stdout)
		identity.NameSource = "global"
	default:
		identity.Name = fallbackName
		identity.NameSource = "auto-set"
	}

	// Resolve email: local > global > fallback
	switch {
	case localEmail.Success && strings.TrimSpace(localEmail.Stdout) != "":
		identity.Email = strings.TrimSpace(localEmail.Stdout)
		identity.EmailSource = "local"
	case globalEmail.Success && strings.TrimSpace(globalEmail.Stdout) != "":
		identity.Email = strings.TrimSpace(globalEmail.Stdout)
		identity.EmailSource = "global"
	default:
		identity.Email = fallbackEmail
		identity.EmailSource = "auto-set"
	}

	// Auto-set any missing fields into LOCAL repo config
	if identity.NameSource == "auto-set" && identity.Name != "" {
		s.runner.RunGit(repoPath, "config", "--local", "user.name", identity.Name)
		identity.WasAutoSet = true
	}
	if identity.EmailSource == "auto-set" && identity.Email != "" {
		s.runner.RunGit(repoPath, "config", "--local", "user.email", identity.Email)
		identity.WasAutoSet = true
	}

	return identity
}
