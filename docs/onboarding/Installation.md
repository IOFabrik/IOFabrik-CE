# Install IOFabrik on Windows

> Install, update, or remove the supported Windows x64 application.

Download `iofabrik-amd64-installer.exe` from the
[latest IOFabrik release](https://github.com/IOFabrik/IOFabrik-CE/releases/latest).
The installer is for Windows x64. The separately published
`iofabrik-windows-amd64.exe` is the application update artifact; use the
installer for your first installation.

1. Open the downloaded installer and review the license agreement.
2. Follow the installer steps. The default location is
   `%LOCALAPPDATA%\Programs\IOFabrik` for your Windows account.
3. Launch **IOFabrik** from the Start menu or desktop shortcut.
4. Complete the in-app setup for the project tools you need.

Keep Windows security protection enabled. If Windows blocks the installer,
check that it came from the official release and review its digital signature
in the file's Properties. Contact support if the signature is missing or invalid.

## Get updates

Production Windows x64 builds check for stable releases at startup and every
six hours. You can also open **Settings → General → Check for updates**.
The update window shows download and verification progress. Choose
**Restart & Apply** when the update is ready.

A skipped version is remembered until the application exits. Development builds
and other platforms do not self-update. Older versions that use the retired
release feed should be upgraded by running the current installer.

## Uninstall

Remove IOFabrik from Windows **Settings → Apps → Installed apps**.
The uninstaller offers an optional action to remove user data; select it only
if you also want to remove application settings and local tool data.

**Related:** [Auto-Updater](../technical/infrastructure/Auto-Updater.md) | [Build and Release](../technical/guides/Build%20and%20Release.md)
