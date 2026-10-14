package main

import (
	"context"
	"crypto/sha256"
	"errors"

	"github.com/wailsapp/wails/v3/pkg/updater"
	githubupdater "github.com/wailsapp/wails/v3/pkg/updater/providers/github"
)

func newAppUpdaterConfig(version string) (updater.Config, error) {
	provider, err := githubupdater.New(githubupdater.Config{
		Repository:    "IOFabrik/IOFabrik-CE",
		Prerelease:    false,
		ChecksumAsset: "SHA256SUMS",
	})
	if err != nil {
		return updater.Config{}, err
	}
	return updater.Config{
		CurrentVersion: version,
		Providers:      []updater.Provider{checksumRequiredProvider{Provider: provider}},
		Window:         &updater.BuiltinWindow{},
	}, nil
}

// Wails beta.16 treats a missing checksum asset as optional. IOFabrik's
// release contract requires SHA256SUMS, including on the manual update path.
type checksumRequiredProvider struct{ updater.Provider }

func (p checksumRequiredProvider) Check(ctx context.Context, request updater.CheckRequest) (*updater.Release, error) {
	release, err := p.Provider.Check(ctx, request)
	if err != nil || release == nil {
		return release, err
	}
	verification := release.Verification
	if verification == nil || verification.DigestAlgo != "sha256" || len(verification.Digest) != sha256.Size {
		return nil, errors.New("This update is missing valid verification information.\nKeep using your current version and contact IOFabrik support.")
	}
	return release, nil
}
