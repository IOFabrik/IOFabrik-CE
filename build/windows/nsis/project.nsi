Unicode true

####
## Please note: Template replacements don't work in this file. They are provided with default defines like
## mentioned underneath.
## If the keyword is not defined, "wails_tools.nsh" will populate them.
## If they are defined here, "wails_tools.nsh" will not touch them. This allows you to use this project.nsi manually
## from outside of Wails for debugging and development of the installer.
## 
## For development first make a wails nsis build to populate the "wails_tools.nsh":
## > wails build --target windows/amd64 --nsis
## Then you can call makensis on this file with specifying the path to your binary:
## For a AMD64 only installer:
## > makensis -DARG_WAILS_AMD64_BINARY=..\..\bin\app.exe
## For a ARM64 only installer:
## > makensis -DARG_WAILS_ARM64_BINARY=..\..\bin\app.exe
## Build one architecture per installer, with its matching IOFABRIK_TOOLS_DIR bundle.
####
## The following information is taken from the wails_tools.nsh file, but they can be overwritten here.
####
## !define INFO_PROJECTNAME    "my-project" # Default "iofabrik"
## !define INFO_COMPANYNAME    "My Company" # Default "My Company"
## !define INFO_PRODUCTNAME    "My Product Name" # Default "My Product"
## !define INFO_PRODUCTVERSION "1.0.0"     # Default "0.1.0"
## !define INFO_COPYRIGHT      "(c) Now, My Company" # Default "© 2025, My Company"
###
## !define PRODUCT_EXECUTABLE  "Application.exe"      # Default "${INFO_PROJECTNAME}.exe"
## !define UNINST_KEY_NAME     "UninstKeyInRegistry"  # Default "${INFO_COMPANYNAME}${INFO_PRODUCTNAME}"
####
# Per-user install keeps the uninstall entry in HKCU and lets the app replace its own exe without elevation.
!define WAILS_INSTALL_SCOPE "user"
!define REQUEST_EXECUTION_LEVEL "user"                # Per-user install/update path; see also https://nsis.sourceforge.io/Docs/Chapter4.html
####
## Include the wails tools
####
!include "wails_tools.nsh"

!ifndef IOFABRIK_TOOLS_DIR
    !error "IOFABRIK_TOOLS_DIR must point to the verified prepare-windows-tools output"
!endif
!include "${IOFABRIK_TOOLS_DIR}\bundle.nsh"
!if "${IOFABRIK_TOOLS_ARCH}" != "${ARCH}"
    !error "Tool bundle architecture must match the single installer architecture"
!endif
!if ! /FileExists "${IOFABRIK_TOOLS_DIR}\git\cmd\git.exe"
    !error "Missing bundled Git"
!endif
!if ! /FileExists "${IOFABRIK_TOOLS_DIR}\git\usr\bin\sh.exe"
    !error "Regular MinGit shell is required"
!endif
!if ! /FileExists "${IOFABRIK_TOOLS_DIR}\gh\bin\gh.exe"
    !error "Missing bundled GitHub CLI"
!endif
!if ! /FileExists "${IOFABRIK_TOOLS_DIR}\lfs\git-lfs.exe"
    !error "Missing bundled Git LFS"
!endif
!if ! /FileExists "${IOFABRIK_TOOLS_DIR}\manifest.json"
    !error "Missing tool provenance manifest"
!endif

# Keep numeric installer metadata and Installed Apps aligned with the release.
# The configuration may use a leading v; Windows version resources require numbers.
!searchreplace NSIS_PRODUCT_VERSION "${INFO_PRODUCTVERSION}" "v" ""
!undef INFO_PRODUCTVERSION
!define INFO_PRODUCTVERSION "${NSIS_PRODUCT_VERSION}"
VIProductVersion "${NSIS_PRODUCT_VERSION}.0"
VIFileVersion    "${NSIS_PRODUCT_VERSION}.0"

VIAddVersionKey "CompanyName"     "${INFO_COMPANYNAME}"
VIAddVersionKey "FileDescription" "${INFO_PRODUCTNAME} Installer"
VIAddVersionKey "ProductVersion"  "${INFO_PRODUCTVERSION}"
VIAddVersionKey "FileVersion"     "${INFO_PRODUCTVERSION}"
VIAddVersionKey "LegalCopyright"  "${INFO_COPYRIGHT}"
VIAddVersionKey "ProductName"     "${INFO_PRODUCTNAME}"

# Enable HiDPI support. https://nsis.sourceforge.io/Reference/ManifestDPIAware
ManifestDPIAware true

!include "MUI.nsh"

!define MUI_ICON "..\icon.ico"
!define MUI_UNICON "..\icon.ico"
# !define MUI_WELCOMEFINISHPAGE_BITMAP "resources\leftimage.bmp" #Include this to add a bitmap on the left side of the Welcome Page. Must be a size of 164x314
!define MUI_FINISHPAGE_NOAUTOCLOSE # Wait on the INSTFILES page so the user can take a look into the details of the installation steps
!define MUI_ABORTWARNING # This will warn the user if they exit from the installer.
!define MUI_LICENSEPAGE_RADIOBUTTONS
!define MUI_LICENSEPAGE_RADIOBUTTONS_TEXT_ACCEPT "I accept the terms of the Beta Software License Agreement"
!define MUI_LICENSEPAGE_RADIOBUTTONS_TEXT_DECLINE "I do not accept the terms"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXECUTABLE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch IOFabrik"

!insertmacro MUI_PAGE_WELCOME # Welcome to the installer page.
!insertmacro MUI_PAGE_LICENSE "resources\license.txt" # Requires explicit acceptance before continuing
!insertmacro MUI_PAGE_DIRECTORY # In which folder install page.
!insertmacro MUI_PAGE_INSTFILES # Installing page.
!insertmacro MUI_PAGE_FINISH # Finished installation page.

!insertmacro MUI_UNPAGE_CONFIRM # Confirm uninstall page
!insertmacro MUI_UNPAGE_COMPONENTS # Optional uninstall components
!insertmacro MUI_UNPAGE_INSTFILES # Uninstalling page

!insertmacro MUI_LANGUAGE "English" # Set the Language of the installer

## The following two statements can be used to sign the installer and the uninstaller. The path to the binaries are provided in %1
#!uninstfinalize 'signtool --file "%1"'
#!finalize 'signtool --file "%1"'

Name "${INFO_PRODUCTNAME}"
OutFile "..\..\..\bin\${INFO_PROJECTNAME}-${ARCH}-installer.exe" # Name of the installer's file.
InstallDir "$LOCALAPPDATA\IOFabrik\app" # App-owned files share one discoverable root.
ShowInstDetails show # This will always show the installation details.

Function .onInit
   !insertmacro wails.checkArchitecture
FunctionEnd

Section
    !insertmacro wails.setShellContext

    # Best effort: close running processes that can lock files in $INSTDIR during upgrade/reinstall.
    # This avoids common "Error opening file for writing" failures.
    nsExec::ExecToLog 'taskkill /F /T /IM "${PRODUCT_EXECUTABLE}"'
    Pop $0
    nsExec::ExecToLog 'taskkill /F /T /IM "control-zebra.exe"'
    Pop $0
    Sleep 800

    # WebView2 is supplied by Windows; no runtime or bootstrapper is redistributed.

    SetOutPath $INSTDIR
    
    !insertmacro wails.files

    # Replace managed tools as a complete distribution, removing obsolete helpers.
    # Never touch system Git/gh installations or their shared user configuration.
    RMDir /r "$LOCALAPPDATA\IOFabrik\tools\bin"
    SetOutPath "$LOCALAPPDATA\IOFabrik\tools\bin"
    File /r "${IOFABRIK_TOOLS_DIR}\*"
    SetOutPath $INSTDIR
    # Remove the legacy updater when upgrading an existing installation.
    Delete "$INSTDIR\cz-updater.exe"

    CreateShortcut "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"
    CreateShortCut "$DESKTOP\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"

    !insertmacro wails.associateFiles
    !insertmacro wails.associateCustomProtocols
    
    !insertmacro wails.writeUninstaller

    # Retire only known application files in the former default install folder.
    # User-selected install locations are not recursively removed.
    ${If} $INSTDIR != "$LOCALAPPDATA\Programs\${INFO_PRODUCTNAME}"
        Delete "$LOCALAPPDATA\Programs\${INFO_PRODUCTNAME}\${PRODUCT_EXECUTABLE}"
        Delete "$LOCALAPPDATA\Programs\${INFO_PRODUCTNAME}\cz-updater.exe"
        Delete "$LOCALAPPDATA\Programs\${INFO_PRODUCTNAME}\uninstall.exe"
        RMDir "$LOCALAPPDATA\Programs\${INFO_PRODUCTNAME}"
    ${EndIf}

    # Retire the previous product only when its registered location is a known
    # default. Keep custom installations and all project/data folders intact.
    SetRegView 64
    ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ControlZebraControlZebra" "UninstallString"
    ${If} $1 == '$\"$LOCALAPPDATA\ControlZebra\app\uninstall.exe$\"'
        StrCpy $2 "$LOCALAPPDATA\ControlZebra\app"
        Call RetirePreviousDefaultInstall
    ${ElseIf} $1 == '$\"$LOCALAPPDATA\Programs\ControlZebra\uninstall.exe$\"'
        StrCpy $2 "$LOCALAPPDATA\Programs\ControlZebra"
        Call RetirePreviousDefaultInstall
    ${EndIf}
SectionEnd

Function RetirePreviousDefaultInstall
    Delete "$2\control-zebra.exe"
    Delete "$2\cz-updater.exe"
    ${If} $2 != $INSTDIR
        Delete "$2\uninstall.exe"
        RMDir "$2"
    ${EndIf}
    Delete "$SMPROGRAMS\ControlZebra.lnk"
    Delete "$DESKTOP\ControlZebra.lnk"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ControlZebraControlZebra"
FunctionEnd

Section /o "un.Remove user data (settings, logs, cache)" un.RemoveUserData
    !insertmacro wails.setShellContext

    # Roaming config (canonical + legacy)
    RMDir /r "$AppData\IOFabrik"
    RMDir /r "$AppData\ControlZebra\config"
    RMDir /r "$AppData\control-zebra"
    RMDir /r "$AppData\control-zebra.exe"

    # Local machine data (logs, cache, webview2, tools)
    RMDir /r "$LocalAppData\IOFabrik\config"
    RMDir /r "$LocalAppData\IOFabrik\logs"
    RMDir /r "$LocalAppData\IOFabrik\cache"
    RMDir /r "$LocalAppData\IOFabrik\integration"
    RMDir /r "$LocalAppData\IOFabrik\webview2"
    RMDir /r "$LocalAppData\IOFabrik\migrations"
    RMDir /r "$LocalAppData\ControlZebra\config"
    RMDir /r "$LocalAppData\ControlZebra\logs"
    RMDir /r "$LocalAppData\ControlZebra\cache"
    RMDir /r "$LocalAppData\ControlZebra\integration"
    RMDir /r "$LocalAppData\ControlZebra\webview2"
    RMDir /r "$LocalAppData\ControlZebra\migrations"
    RMDir /r "$LocalAppData\ControlZebra\tools"
    RMDir /r "$LocalAppData\ControlZebra\bin"
SectionEnd

Section "uninstall" 
    !insertmacro wails.setShellContext

    RMDir /r "$AppData\${PRODUCT_EXECUTABLE}" # Remove the WebView2 DataPath

    RMDir /r $INSTDIR
    RMDir /r "$LOCALAPPDATA\IOFabrik\tools"
    RMDir /r "$LOCALAPPDATA\IOFabrik\bin"
    RMDir "$LOCALAPPDATA\IOFabrik"

    Delete "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk"
    Delete "$DESKTOP\${INFO_PRODUCTNAME}.lnk"

    !insertmacro wails.unassociateFiles
    !insertmacro wails.unassociateCustomProtocols

    !insertmacro wails.deleteUninstaller
SectionEnd
