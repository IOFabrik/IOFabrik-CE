package services

import (
	"encoding/json"
	"testing"

	"github.com/zalando/go-keyring"
)

// TestAuthServiceRoundTrip verifies save → load → clear lifecycle.
func TestAuthServiceRoundTrip(t *testing.T) {
	keyring.MockInit()
	svc := NewAuthService()

	// Clean slate
	_ = svc.ClearSession()

	// 1. LoadSession should return empty when nothing is stored
	session, err := svc.LoadSession()
	if err != nil {
		t.Fatalf("LoadSession on empty keychain: %v", err)
	}
	if session != "" {
		t.Fatalf("expected empty session, got: %s", session)
	}

	// 2. SaveSession should persist data
	testSession := map[string]interface{}{
		"access_token":  "test-access-token",
		"refresh_token": "test-refresh-token",
		"expires_at":    1700000000,
	}
	data, _ := json.Marshal(testSession)
	if err := svc.SaveSession(string(data)); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}

	// 3. LoadSession should return what we saved
	loaded, err := svc.LoadSession()
	if err != nil {
		t.Fatalf("LoadSession after save: %v", err)
	}
	if loaded != string(data) {
		t.Fatalf("loaded session mismatch.\nwant: %s\ngot:  %s", string(data), loaded)
	}

	// 4. ClearSession should remove it
	if err := svc.ClearSession(); err != nil {
		t.Fatalf("ClearSession: %v", err)
	}

	session, err = svc.LoadSession()
	if err != nil {
		t.Fatalf("LoadSession after clear: %v", err)
	}
	if session != "" {
		t.Fatalf("expected empty session after clear, got: %s", session)
	}
}

// TestAuthServiceSaveEmptyRejects verifies that empty session data is rejected.
func TestAuthServiceSaveEmptyRejects(t *testing.T) {
	keyring.MockInit()
	svc := NewAuthService()

	err := svc.SaveSession("")
	if err == nil {
		t.Fatal("expected error when saving empty session, got nil")
	}
}

func TestAuthServiceMigratesLegacySessionAndClearsBothNames(t *testing.T) {
	keyring.MockInit()
	if err := keyring.Set(legacyKeyringService, keyringUser, "legacy-session"); err != nil {
		t.Fatal(err)
	}
	svc := NewAuthService()
	if got, err := svc.LoadSession(); err != nil || got != "legacy-session" {
		t.Fatalf("legacy session was not recovered: %q, %v", got, err)
	}
	if got, err := keyring.Get(keyringService, keyringUser); err != nil || got != "legacy-session" {
		t.Fatalf("session was not stored under the new name: %q, %v", got, err)
	}
	if err := svc.SaveSession("current-session"); err != nil {
		t.Fatal(err)
	}
	if got, err := svc.LoadSession(); err != nil || got != "current-session" {
		t.Fatalf("legacy session replaced the current session: %q, %v", got, err)
	}
	if err := svc.ClearSession(); err != nil {
		t.Fatal(err)
	}
	if got, err := svc.LoadSession(); err != nil || got != "" {
		t.Fatalf("logout recovered an old session: %q, %v", got, err)
	}
}
