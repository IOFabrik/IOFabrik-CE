// Package services provides backend functionality for the IOFabrik application.
// This file contains the AuthService which stores and retrieves Supabase session
// tokens securely via the OS credential store (macOS Keychain, Windows Credential
// Manager, Linux Secret Service / libsecret).
package services

import (
	"errors"
	"fmt"
	"sync"

	"github.com/zalando/go-keyring"
)

const (
	// keyringService is the service name stored in the OS credential manager.
	keyringService       = "com.iofabrik.desktop"
	legacyKeyringService = "com.controlzebra.desktop"

	// keyringUser is the account name under which the session token is stored.
	keyringUser = "supabase-session"
)

// AuthService provides secure session persistence via the OS keychain.
// The frontend calls SaveSession after successful login, LoadSession on app
// startup to rehydrate, and ClearSession on logout.
type AuthService struct {
	mu sync.Mutex
}

// NewAuthService creates a new AuthService instance.
func NewAuthService() *AuthService {
	return &AuthService{}
}

// SaveSession stores the serialised Supabase session JSON in the OS keychain.
// It overwrites any previously stored session.
func (a *AuthService) SaveSession(sessionJSON string) error {
	done := LogMethod("AuthService.SaveSession", nil)
	defer func() { done(nil, nil) }()

	a.mu.Lock()
	defer a.mu.Unlock()

	if sessionJSON == "" {
		return fmt.Errorf("session data cannot be empty")
	}

	// go-keyring's Set creates or updates the credential
	if err := keyring.Set(keyringService, keyringUser, sessionJSON); err != nil {
		return fmt.Errorf("failed to save session to keychain: %w", err)
	}

	return nil
}

// LoadSession retrieves the stored Supabase session JSON from the OS keychain.
// Returns an empty string (no error) if no session has been stored yet, so the
// frontend can treat empty-string as "not authenticated".
func (a *AuthService) LoadSession() (string, error) {
	done := LogMethod("AuthService.LoadSession", nil)
	defer func() { done(nil, nil) }()

	a.mu.Lock()
	defer a.mu.Unlock()

	secret, err := keyring.Get(keyringService, keyringUser)
	if errors.Is(err, keyring.ErrNotFound) {
		secret, err = keyring.Get(legacyKeyringService, keyringUser)
		if err == nil {
			if saveErr := keyring.Set(keyringService, keyringUser, secret); saveErr != nil {
				return "", fmt.Errorf("failed to migrate session to keychain: %w", saveErr)
			}
		}
	}
	if err != nil {
		// "not found" is the expected case when no session has been stored.
		// go-keyring returns keyring.ErrNotFound for this.
		if errors.Is(err, keyring.ErrNotFound) {
			return "", nil
		}
		return "", fmt.Errorf("failed to load session from keychain: %w", err)
	}

	return secret, nil
}

// ClearSession removes the stored session from the OS keychain.
// It is a no-op (no error) if no session exists.
func (a *AuthService) ClearSession() error {
	done := LogMethod("AuthService.ClearSession", nil)
	defer func() { done(nil, nil) }()

	a.mu.Lock()
	defer a.mu.Unlock()

	var failures []error
	for _, service := range []string{keyringService, legacyKeyringService} {
		if err := keyring.Delete(service, keyringUser); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			failures = append(failures, err)
		}
	}
	if err := errors.Join(failures...); err != nil {
		return fmt.Errorf("failed to clear session from keychain: %w", err)
	}
	return nil
}
