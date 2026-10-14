//go:build !windows

package services

// The dot-prefixed name already hides this directory on macOS and Linux.
func hideIOFabrikDirectory(_ string) error {
	return nil
}
