// Package services provides backend functionality for the IOFabrik application.
package services

import (
	"context"
	"errors"
	"log"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/updater"
)

const appUpdateCheckInterval = 6 * time.Hour

var errAppUpdaterNotInitialized = errors.New("app updater is not initialized")

type appUpdater interface {
	Check(context.Context) (*updater.Release, error)
	CheckAndInstall(context.Context) error
}

type appUpdateTimer interface {
	Stop() bool
}

// AppUpdateService is the frontend-facing coordinator for Wails' built-in
// updater. Update operations are available only in production Windows/amd64
// builds and are serialized so a manual check cannot race a background check.
type AppUpdateService struct {
	currentVersion string
	updater        appUpdater
	enabled        bool

	operationMu sync.Mutex
	startOnce   sync.Once
	timerMu     sync.Mutex
	timer       appUpdateTimer
	stopped     bool

	ctx       context.Context
	cancel    context.CancelFunc
	unlisten  func()
	interval  time.Duration
	afterFunc func(time.Duration, func()) appUpdateTimer
	logf      func(string, ...any)
}

// NewAppUpdateService creates the application update coordinator and attaches
// its background schedule to Wails' ApplicationStarted lifecycle event.
func NewAppUpdateService(version string, app *application.App) *AppUpdateService {
	ctx, cancel := context.WithCancel(context.Background())
	service := &AppUpdateService{
		currentVersion: normalizeAppVersion(version),
		enabled:        AppUpdatesEnabled(),
		ctx:            ctx,
		cancel:         cancel,
		interval:       appUpdateCheckInterval,
		afterFunc: func(delay time.Duration, callback func()) appUpdateTimer {
			return time.AfterFunc(delay, callback)
		},
		logf: log.Printf,
	}

	if app != nil {
		service.updater = app.Updater
		service.unlisten = app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
			service.applicationStarted()
		})
	}

	return service
}

// GetCurrentVersion returns the normalized version configured at build time.
func (s *AppUpdateService) GetCurrentVersion() string {
	return s.currentVersion
}

// CheckForUpdates opens Wails' built-in updater window and runs an update flow.
// Unsupported and development builds intentionally treat the call as a no-op.
func (s *AppUpdateService) CheckForUpdates() error {
	if !s.enabled {
		return nil
	}
	if s.updater == nil {
		return errAppUpdaterNotInitialized
	}

	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	if err := s.ctx.Err(); err != nil {
		return err
	}
	return s.updater.CheckAndInstall(s.ctx)
}

// ServiceShutdown stops the background schedule and releases the application
// event subscription. Wails excludes lifecycle methods from frontend bindings.
func (s *AppUpdateService) ServiceShutdown() error {
	s.timerMu.Lock()
	s.stopped = true
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	s.timerMu.Unlock()

	s.cancel()
	if s.unlisten != nil {
		s.unlisten()
		s.unlisten = nil
	}
	return nil
}

func (s *AppUpdateService) applicationStarted() {
	if !s.enabled || s.updater == nil || s.ctx.Err() != nil {
		return
	}

	s.startOnce.Do(func() {
		go s.runBackgroundCheck()
		s.scheduleNextBackgroundCheck()
	})
}

func (s *AppUpdateService) scheduleNextBackgroundCheck() {
	s.timerMu.Lock()
	defer s.timerMu.Unlock()
	if s.stopped {
		return
	}

	s.timer = s.afterFunc(s.interval, func() {
		s.runBackgroundCheck()
		s.scheduleNextBackgroundCheck()
	})
}

// runBackgroundCheck remains silent when the app is current or the provider
// fails. A discovered release is the only condition that opens updater UI.
func (s *AppUpdateService) runBackgroundCheck() {
	if !s.enabled || s.updater == nil || s.ctx.Err() != nil {
		return
	}

	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	// Shutdown may have happened while this check waited for a manual flow.
	if s.ctx.Err() != nil {
		return
	}

	release, err := s.updater.Check(s.ctx)
	if err != nil {
		s.logf("[AppUpdateService] background update check failed: %v", err)
		return
	}
	if release == nil {
		return
	}

	// Check first so routine polling only opens the built-in updater window
	// after a release has actually been found. CheckAndInstall checks again.
	if err := s.updater.CheckAndInstall(s.ctx); err != nil {
		s.logf("[AppUpdateService] background update flow failed: %v", err)
	}
}

func normalizeAppVersion(version string) string {
	return strings.TrimPrefix(strings.TrimSpace(version), "v")
}

// AppUpdatesEnabled reports whether this binary may perform self-updates.
func AppUpdatesEnabled() bool {
	return appUpdatesEnabledFor(productionBuild, runtime.GOOS, runtime.GOARCH)
}

func appUpdatesEnabledFor(production bool, goos, goarch string) bool {
	return production && goos == "windows" && goarch == "amd64"
}
