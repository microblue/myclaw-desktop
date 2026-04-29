; MyClaw Custom NSIS Installer/Uninstaller Script
;
; Install: enables long paths, adds resources\cli to user PATH for openclaw CLI.
; Uninstall: removes the PATH entry and optionally deletes user data.

!ifndef nsProcess::FindProcess
  !include "nsProcess.nsh"
!endif

!macro customHeader
  ; Show install details by default so users can see what stage is running.
  ShowInstDetails show
  ShowUninstDetails show
!macroend

!macro customCheckAppRunning
  ; Make stage logs visible on assisted installers (defaults to hidden).
  SetDetailsPrint both
  DetailPrint "Preparing installation..."
  DetailPrint "Extracting MyClaw runtime files. This can take a few minutes on slower disks or while antivirus scanning is active."

  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0

  ${if} $R0 == 0
    ${if} ${isUpdated}
      # Auto-update: the app is already shutting down (quitAndInstall was called).
      # The before-quit handler needs up to 8s to gracefully stop the Gateway
      # process tree (5s timeout + force-terminate + re-quit).  Wait for the
      # app to exit on its own before resorting to force-kill.
      DetailPrint `Waiting for "${PRODUCT_NAME}" to finish shutting down...`
      Sleep 8000
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 != 0
        # App exited cleanly. Still kill long-lived child processes (gateway,
        # uv, python) which may not have followed the app's graceful exit.
        nsExec::ExecToStack 'taskkill /F /IM openclaw-gateway.exe'
        Pop $0
        Pop $1
        Goto done_killing
      ${endIf}
      # App didn't exit in time; fall through to force-kill
    ${endIf}
    ${if} ${isUpdated} ; skip the dialog for auto-updates
    ${else}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK doStopProcess
      Quit
    ${endIf}

    doStopProcess:
    DetailPrint `Closing running "${PRODUCT_NAME}"...`

    # Kill ALL processes whose executable lives inside $INSTDIR.
    # This covers MyClaw.exe (multiple Electron processes), openclaw-gateway.exe,
    # python.exe (skills runtime), uv.exe (package manager), and any other
    # child process that might hold file locks in the installation directory.
    #
    # Use PowerShell Get-CimInstance for path-based matching (most reliable),
    # with taskkill name-based fallback for restricted environments.
    # Note: Using backticks ` ` for the NSIS string allows us to use single quotes inside.
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $0
    Pop $1

    ${if} $0 != 0
      # PowerShell failed (policy restriction, etc.) — fall back to name-based kill
      nsExec::ExecToStack 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
      Pop $0
      Pop $1
    ${endIf}

    # Also kill well-known child processes that may have detached from the
    # Electron process tree or run from outside $INSTDIR (e.g. system python).
    nsExec::ExecToStack 'taskkill /F /IM openclaw-gateway.exe'
    Pop $0
    Pop $1

    # Wait for Windows to fully release file handles after process termination.
    # 5 seconds accommodates slow antivirus scanners and filesystem flush delays.
    Sleep 5000
    DetailPrint "Processes terminated. Continuing installation..."

    done_killing:
      ${nsProcess::Unload}
  ${endIf}

  ; Even if MyClaw.exe was not detected as running, orphan child processes
  ; (python.exe, openclaw-gateway.exe, uv.exe, etc.) from a previous crash
  ; or unclean shutdown may still hold file locks inside $INSTDIR.
  ; Unconditionally kill any process whose executable lives in the install dir.
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  Pop $1

  ; Always kill known process names as a belt-and-suspenders approach.
  ; PowerShell path-based kill may miss processes if the old MyClaw was installed
  ; in a different directory than $INSTDIR (e.g., per-machine -> per-user migration).
  ; taskkill is name-based and catches processes regardless of their install location.
  nsExec::ExecToStack 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'taskkill /F /IM openclaw-gateway.exe'
  Pop $0
  Pop $1
  ; Note: we intentionally do NOT kill uv.exe globally — it is a popular
  ; Python package manager and other users/CI jobs may have uv running.
  ; The PowerShell path-based kill above already handles uv inside $INSTDIR.

  ; Brief wait for handle release (main wait was already done above if app was running)
  Sleep 2000

  ; Release NSIS's CWD on $INSTDIR BEFORE the rename check.
  ; NSIS sets CWD to $INSTDIR in .onInit; Windows refuses to rename a directory
  ; that any process (including NSIS itself) has as its CWD.
  SetOutPath $TEMP

  ; Pre-emptively clear the old installation directory so that the 7z
  ; extraction `CopyFiles` step in extractAppPackage.nsh won't fail on
  ; locked files.  electron-builder's extractUsing7za macro extracts to a
  ; temp folder first, then uses `CopyFiles /SILENT` to copy into $INSTDIR.
  ; If ANY file in $INSTDIR is still locked, CopyFiles fails and triggers a
  ; "Can't modify MyClaw's files" retry loop -> "MyClaw 无法关闭" dialog.
  ;
  ; Strategy: rename (move) the old $INSTDIR out of the way.  Rename works
  ; even when AV/indexer have files open for reading (they use
  ; FILE_SHARE_DELETE sharing mode), whereas CopyFiles fails because it
  ; needs write/overwrite access which some AV products deny.
  ; Check if a previous installation exists ($INSTDIR is a directory).
  ; Use trailing backslash — the correct NSIS idiom for directory existence.
  ; (IfFileExists "$INSTDIR\*.*" only matches files containing a dot and
  ;  would fail for extensionless files or pure-subdirectory layouts.)
  IfFileExists "$INSTDIR\" 0 _instdir_clean
    ; Find the first available stale directory name (e.g. $INSTDIR._stale_0)
    ; This ensures we NEVER have to synchronously delete old leftovers before
    ; renaming the current $INSTDIR. We just move it out of the way instantly.
    StrCpy $R8 0
  _find_free_stale:
    IfFileExists "$INSTDIR._stale_$R8\" 0 _found_free_stale
    IntOp $R8 $R8 + 1
    Goto _find_free_stale

  _found_free_stale:
    ClearErrors
    Rename "$INSTDIR" "$INSTDIR._stale_$R8"
    IfErrors 0 _stale_moved
      ; Rename still failed — a process reopened a file or holds CWD in $INSTDIR.
      ; We must delete forcibly and synchronously to make room for CopyFiles.
      ; This can be slow (~1-3 minutes) if there are 10,000+ files and AV is active.
      nsExec::ExecToStack 'cmd.exe /c rd /s /q "$INSTDIR"'
      Pop $0
      Pop $1
      Sleep 2000
      CreateDirectory "$INSTDIR"
      Goto _instdir_clean
  _stale_moved:
    CreateDirectory "$INSTDIR"
  _instdir_clean:

  ; Pre-emptively remove the old uninstall registry entry so that
  ; electron-builder's uninstallOldVersion skips the old uninstaller entirely.
  ;
  ; Why: uninstallOldVersion has a hardcoded 5-retry loop that runs the old
  ; uninstaller repeatedly.  The old uninstaller's atomicRMDir fails on locked
  ; files (antivirus, indexing) causing a blocking "MyClaw 无法关闭" dialog.
  ; Deleting UninstallString makes uninstallOldVersion return immediately.
  ; The new installer will overwrite / extract all files on top of the old dir.
  ; registryAddInstallInfo will write the correct new entries afterwards.
  ; Clean both SHELL_CONTEXT and HKCU to cover cross-hive upgrades
  ; (e.g. old install was per-user, new install is per-machine or vice versa).
  DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" QuietUninstallString
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY_2}" QuietUninstallString
  !endif
!macroend

; Override electron-builder's handleUninstallResult to prevent the
; "MyClaw 无法关闭" retry dialog when the old uninstaller fails.
;
; During upgrades, electron-builder copies the old uninstaller to a temp dir
; and runs it silently.  The old uninstaller uses atomicRMDir to rename every
; file out of $INSTDIR.  If ANY file is still locked (antivirus scanner,
; Windows Search indexer, delayed kernel handle release after taskkill), it
; aborts with a non-zero exit code.  The default handler retries 5× then shows
; a blocking MessageBox.
;
; This macro clears the error and lets the new installer proceed — it will
; simply overwrite / extract new files on top of the (partially cleaned) old
; installation directory.  This is safe because:
;   1. Processes have already been force-killed in customCheckAppRunning.
;   2. The new installer extracts a complete, self-contained file tree.
;   3. Any leftover old files that weren't removed are harmless.
!macro customUnInstallCheck
  ${if} $R0 != 0
    DetailPrint "Old uninstaller exited with code $R0. Continuing with overwrite install..."
  ${endIf}
  ClearErrors
!macroend

; Same safety net for the HKEY_CURRENT_USER uninstall path.
; Without this, handleUninstallResult would show a fatal error and Quit.
!macro customUnInstallCheckCurrentUser
  ${if} $R0 != 0
    DetailPrint "Old uninstaller (current user) exited with code $R0. Continuing..."
  ${endIf}
  ClearErrors
!macroend

; --- Auto-start checkbox variable (declared at global scope) ---
Var AutoStartCheckbox
Var AutoStartState

; --- Force-reinstall-OpenClaw checkbox (declared at global scope) ---
; Shown on a custom page between the directory picker and file extraction.
; When checked, $PROFILE\.openclaw is wiped before files are copied so that
; a broken config / skills / cache state can be recovered by reinstalling.
; CLI equivalent: /FORCE_REINSTALL_OPENCLAW (handled in customInit below).
Var ForceReinstallOpenClawCheckbox
Var ForceReinstallOpenClawState

; --- CLI opt-in for the uninstall-time .openclaw wipe ---
; Legacy flag — kept for back-compat with anything that calls Uninstall.exe
; with /REMOVE_OPENCLAW.  Treated as a synonym for /UNINSTALL_SCOPE=full.
Var RemoveOpenClawFromCLI

; --- Uninstall scope: "full" | "main+runtime" | "main-only" ---
; Default "full" matches user expectation of a clean uninstall.  Advanced
; users can pick a softer scope from the welcome page.  Headless (silent)
; uninstalls take this from /UNINSTALL_SCOPE=<value> (parsed in customUnInit)
; and skip the page entirely.
Var UninstallScope
; Radio-button handles for the welcome page (declared at global scope so
; the create / leave functions in customUnWelcomePage can share them).
Var UnScopeRadioFull
Var UnScopeRadioRuntime
Var UnScopeRadioMainOnly

; NOTE on scope / compile timing:
; electron-builder injects this installer.nsh at the very START of the
; generated NSIS script — BEFORE it !includes MUI2.nsh, multiUser.nsh
; (FileFunc), or the StdUtils plugin.  That means any Function declared
; at the top-level here is compiled before those libraries are loaded
; and will fail with "Plugin not found" / "Invalid command" / "macro
; named X not found" if its body uses ${GetParameters}, ${isUpdated},
; MUI_HEADER_TEXT, etc.
;
; Macros, on the other hand, are only EXPANDED at their !insertmacro
; call site — which for customInit / customPageAfterChangeDir /
; customUnInit happens inside the electron-builder templates, AFTER
; MUI2/FileFunc are loaded.  So we nest the Page's Functions inside
; the customPageAfterChangeDir macro: their bodies then compile at
; expansion time, with every library already available.
;
; nsDialogs.nsh is standalone (no MUI dep) and just registers macros,
; so including it at the top is harmless even in this early context.
!include nsDialogs.nsh

!macro customInit
  ; Accept /FORCE_REINSTALL_OPENCLAW as the headless equivalent of ticking
  ; the install-time checkbox.  Silent mode skips the custom page, so this
  ; is the only way to opt into the wipe from the command line.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/FORCE_REINSTALL_OPENCLAW" $R1
  ${IfNot} ${Errors}
    StrCpy $ForceReinstallOpenClawState ${BST_CHECKED}
  ${EndIf}
!macroend

!macro customUnInit
  ; Default scope: full clean.  This is the recommended option and what
  ; silent uninstalls get unless overridden.  Most users uninstalling want
  ; a clean slate, and v1.6+ first-launch heuristics rely on a missing
  ; ~/.myclaw/runtime/ to trigger fresh init — leaving it behind makes the
  ; next install start "half-configured" with no setup wizard.
  StrCpy $UninstallScope "full"

  ${GetParameters} $R0

  ; Legacy flag: /REMOVE_OPENCLAW behaves like /UNINSTALL_SCOPE=full.
  ; Anything that previously passed it gets the new full-clean by default.
  ClearErrors
  ${GetOptions} $R0 "/REMOVE_OPENCLAW" $R1
  ${IfNot} ${Errors}
    StrCpy $RemoveOpenClawFromCLI "1"
    StrCpy $UninstallScope "full"
  ${EndIf}

  ; Headless override: /UNINSTALL_SCOPE=full | main+runtime | main-only
  ClearErrors
  ${GetOptions} $R0 "/UNINSTALL_SCOPE=" $R1
  ${IfNot} ${Errors}
    ${if} $R1 == "full"
      StrCpy $UninstallScope "full"
    ${elseif} $R1 == "main+runtime"
      StrCpy $UninstallScope "main+runtime"
    ${elseif} $R1 == "main-only"
      StrCpy $UninstallScope "main-only"
    ${else}
      DetailPrint "Warning: unknown /UNINSTALL_SCOPE value '$R1'; using full"
    ${endif}
  ${EndIf}
!macroend

; The uninstaller welcome page.  Replaces MUI's default welcome with a
; nsDialogs-based scope picker (3 radio buttons, default = full clean).
;
; Why hijack the welcome page: electron-builder's uninstaller pipeline
; is welcome → instfiles → finish.  customUnInstall runs INSIDE instfiles
; (i.e. the work is already happening); the only place we can ask the
; user a question and have customUnInstall act on the answer is the
; welcome page.  The trade-off is that we lose the standard "Click Next
; to begin uninstall" branding.
;
; Silent mode: nsDialogs::Show falls through immediately without rendering
; in /S mode, so $UninstallScope keeps whatever customUnInit set
; (default "full" or whatever /UNINSTALL_SCOPE=... selected).
!macro customUnWelcomePage
  Function un.uninstScopePageCreate
    !insertmacro MUI_HEADER_TEXT "Uninstall MyClaw.One" "Choose how thoroughly to remove MyClaw.One from this computer."

    nsDialogs::Create 1018
    Pop $0
    ${if} $0 == error
      Abort
    ${endIf}

    ${NSD_CreateLabel} 0 0 100% 28u "Pick a scope. The default removes everything; the other options are for advanced users who plan to reinstall and want to preserve some state."
    Pop $0

    ; --- Option 1: Full clean (default, recommended) ---
    ${NSD_CreateRadioButton} 0 36u 100% 12u "Full clean (recommended) — remove app + ~/.myclaw + ~/.openclaw + AppData"
    Pop $UnScopeRadioFull
    ${NSD_CreateLabel} 16u 50u 100% 12u "Reinstall starts fresh, including the first-launch setup wizard."
    Pop $0

    ; --- Option 2: Main + runtime ---
    ${NSD_CreateRadioButton} 0 70u 100% 12u "Remove app + MyClaw runtime — keep ~/.openclaw and provider configs"
    Pop $UnScopeRadioRuntime
    ${NSD_CreateLabel} 16u 84u 100% 12u "Reinstall re-fetches openclaw but remembers your providers and channels."
    Pop $0

    ; --- Option 3: Main only ---
    ${NSD_CreateRadioButton} 0 104u 100% 12u "Remove app only — keep all configuration and runtime data"
    Pop $UnScopeRadioMainOnly
    ${NSD_CreateLabel} 16u 118u 100% 12u "Choose this if you plan to reinstall right away and want zero downtime."
    Pop $0

    ; Default selection follows whatever customUnInit / CLI flag set.
    ${if} $UninstallScope == "main-only"
      ${NSD_SetState} $UnScopeRadioMainOnly ${BST_CHECKED}
    ${elseif} $UninstallScope == "main+runtime"
      ${NSD_SetState} $UnScopeRadioRuntime ${BST_CHECKED}
    ${else}
      ${NSD_SetState} $UnScopeRadioFull ${BST_CHECKED}
    ${endIf}

    nsDialogs::Show
  FunctionEnd

  Function un.uninstScopePageLeave
    ${NSD_GetState} $UnScopeRadioFull $0
    ${if} $0 == ${BST_CHECKED}
      StrCpy $UninstallScope "full"
      Goto _scope_chosen
    ${endIf}
    ${NSD_GetState} $UnScopeRadioRuntime $0
    ${if} $0 == ${BST_CHECKED}
      StrCpy $UninstallScope "main+runtime"
      Goto _scope_chosen
    ${endIf}
    ${NSD_GetState} $UnScopeRadioMainOnly $0
    ${if} $0 == ${BST_CHECKED}
      StrCpy $UninstallScope "main-only"
      Goto _scope_chosen
    ${endIf}
    ; No selection — fall back to default.
    StrCpy $UninstallScope "full"
  _scope_chosen:
  FunctionEnd

  UninstPage custom un.uninstScopePageCreate un.uninstScopePageLeave
!macroend

!macro customPageAfterChangeDir
  Function forceReinstallOpenClawPageCreate
    ; Auto-updates pass /updated — skip the page so user state carries
    ; forward unchanged.  We parse the command line directly instead of
    ; using ${isUpdated} (StdUtils plugin not resolvable at Function
    ; compile time even inside a late-expanded macro, because the plugin
    ; directory is registered later still).
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/updated" $R1
    ${IfNot} ${Errors}
      Abort
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "OpenClaw 重置选项" "选择是否在安装前清除已有的 OpenClaw 数据"

    nsDialogs::Create 1018
    Pop $0
    ${if} $0 == error
      Abort
    ${endIf}

    ${NSD_CreateLabel} 0 0 100% 48u "如果 OpenClaw 无法启动，或反复安装仍未修复问题，可勾选下面的选项。安装程序会在复制文件前清除 $PROFILE\.openclaw 下的全部旧配置、skills 与缓存，然后进行全新安装。$\r$\n$\r$\n警告：此操作不可恢复，请先备份需要保留的数据。"
    Pop $0

    ${NSD_CreateCheckbox} 0 56u 100% 12u "强制重新安装 OpenClaw (将删除 $PROFILE\.openclaw 下所有文件)"
    Pop $ForceReinstallOpenClawCheckbox
    ${NSD_SetState} $ForceReinstallOpenClawCheckbox $ForceReinstallOpenClawState

    nsDialogs::Show
  FunctionEnd

  Function forceReinstallOpenClawPageLeave
    ${NSD_GetState} $ForceReinstallOpenClawCheckbox $ForceReinstallOpenClawState
  FunctionEnd

  Page custom forceReinstallOpenClawPageCreate forceReinstallOpenClawPageLeave
!macroend

!macro customInstall
  ; --- Force-reinstall OpenClaw: wipe $PROFILE\.openclaw if the user opted in ---
  ; Runs before any extraction so the fresh install starts from a clean state.
  ; Scope: only the profile running the installer; per-machine installs do NOT
  ; touch other users' .openclaw (matches user intent — they're reinstalling for
  ; themselves, and silently wiping other users' data would surprise admins).
  ${if} $ForceReinstallOpenClawState == ${BST_CHECKED}
    DetailPrint "Force reinstall OpenClaw: removing $PROFILE\.openclaw..."
    RMDir /r "$PROFILE\.openclaw"
    IfFileExists "$PROFILE\.openclaw\*.*" 0 _ci_fr_done
      Sleep 2000
      nsExec::ExecToStack 'cmd.exe /c rd /s /q "$PROFILE\.openclaw"'
      Pop $0
      Pop $1
      IfFileExists "$PROFILE\.openclaw\*.*" 0 _ci_fr_done
        DetailPrint "Warning: some files under $PROFILE\.openclaw could not be removed. Please delete manually after reboot."
    _ci_fr_done:
  ${endIf}

  ; Async cleanup of old dirs left by the rename loop in customCheckAppRunning.
  ; Wait 60s before starting deletion to avoid I/O contention with MyClaw's
  ; first launch (Windows Defender scan, ASAR mapping, etc.).
  ; ExecShell SW_HIDE is completely detached from NSIS and avoids pipe blocking.
  IfFileExists "$INSTDIR._stale_0\" 0 _ci_stale_cleaned
    ; Use PowerShell to extract the basename of $INSTDIR so the glob works
    ; even when the user picked a custom install folder name.
    ; E.g. $INSTDIR = D:\Apps\MyClaw → glob = MyClaw._stale_*
    ExecShell "" "cmd.exe" `/c ping -n 61 127.0.0.1 >nul & cd /d "$INSTDIR\.." & for /d %D in ("$INSTDIR._stale_*") do rd /s /q "%D"` SW_HIDE
  _ci_stale_cleaned:
  DetailPrint "Core files extracted. Finalizing system integration..."

  ; Enable Windows long path support (Windows 10 1607+ / Windows 11).
  ; pnpm virtual store paths can exceed the default MAX_PATH limit of 260 chars.
  ; Writing to HKLM requires admin privileges; on per-user installs without
  ; elevation this call silently fails — no crash, just no key written.
  DetailPrint "Enabling long-path support (if permissions allow)..."
  WriteRegDWORD HKLM "SYSTEM\CurrentControlSet\Control\FileSystem" "LongPathsEnabled" 1

  ; Add $INSTDIR to Windows Defender exclusion list so that real-time scanning
  ; doesn't block the first app launch (Defender scans every newly-created file,
  ; causing 10-30s startup delay on a fresh install).  Requires elevation;
  ; silently fails on non-admin per-user installs (no harm done).
  DetailPrint "Configuring Windows Defender exclusion..."
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Add-MpPreference -ExclusionPath '$INSTDIR' -ErrorAction SilentlyContinue"`
  Pop $0
  Pop $1

  ; Use PowerShell to update the current user's PATH.
  ; This avoids NSIS string-buffer limits and preserves long PATH values.
  DetailPrint "Updating user PATH for the OpenClaw CLI..."
  InitPluginsDir
  ClearErrors
  File "/oname=$PLUGINSDIR\update-user-path.ps1" "${PROJECT_DIR}\resources\cli\win32\update-user-path.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\update-user-path.ps1" -Action add -CliDir "$INSTDIR\resources\cli"'
  Pop $0
  Pop $1
  StrCmp $0 "error" 0 +2
    DetailPrint "Warning: Failed to launch PowerShell while updating PATH."
  StrCmp $0 "timeout" 0 +2
    DetailPrint "Warning: PowerShell PATH update timed out."
  StrCmp $0 "0" 0 +2
    Goto _ci_done
  DetailPrint "Warning: PowerShell PATH update exited with code $0."

  _ci_done:

  ; --- Register auto-start in HKLM Run registry if checkbox was checked ---
  ; The checkbox is on the finish page; for silent/auto-update installs, default to enabled.
  ; Write to HKLM (per-machine) since installer runs elevated.
  ${if} ${isUpdated}
    ; Preserve existing auto-start setting during auto-updates — don't touch the registry
  ${else}
    ; For fresh install / manual install, always register auto-start
    ; (The installer page checkbox is handled in the finish page callback below)
    DetailPrint "Registering MyClaw auto-start..."
    WriteRegStr HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" "MyClaw" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  ${endIf}

  DetailPrint "Installation steps complete."
!macroend

; Helper: remove a directory with retry-on-locked.  Wraps the same
; "RMDir /r → wait → cmd /c rd /s /q → warn" pattern that was previously
; inlined per directory.  Caller supplies a unique `tag` so the labels
; don't collide across multiple !insertmacro sites in the same function
; (NSIS's ${__LINE__} expands to "file.line.depth" — contains dots,
; invalid for label names).
;
; Also emits a trace line to $TEMP\myclaw-uninst-trace.log on every
; invocation.  Silent mode (/S) suppresses DetailPrint output entirely,
; so this disk log is the ONLY way CI (or a user inspecting after a
; failed uninstall) can see which dirs the macro tried to remove and
; what PowerShell reported back.  $TEMP is not touched by any of our
; cleanup paths so the log survives the uninstall.
!macro _CU_RemoveDir tag dirPath
  ; Trace: start.  Append via cmd echo >> (NSIS FileOpen/FileWrite
  ; produced empty zero-byte files under /S — see customUnInstall note).
  nsExec::ExecToStack `cmd.exe /c (echo [${tag}] enter dir=${dirPath}) >> "$TEMP\myclaw-uninst-trace.log"`
  Pop $0
  Pop $1
  nsExec::ExecToStack `cmd.exe /c (echo [${tag}] enter dir=${dirPath}) >> "$WINDIR\Temp\myclaw-uninst-trace.log"`
  Pop $0
  Pop $1

  IfFileExists "${dirPath}\*.*" 0 _crd_absent_${tag}

    DetailPrint "Removing ${dirPath}..."
    ; PowerShell with a retry loop handles the long tail of file-handle
    ; release on Windows much more reliably than NSIS's RMDir + sleep:
    ;   - electron-log keeps myclaw-YYYY-MM-DD.log open for up to ~10s
    ;     after the parent exits
    ;   - Chromium's sqlite WAL files (Cookies-journal, etc.) hold
    ;     handles via the kernel for a similar window
    ;   - Windows Defender real-time scan opens every newly-created
    ;     file briefly during cleanup
    ; The loop tries up to 8 times (~32s wall) before giving up.
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = '${dirPath}'; for ($$i = 0; $$i -lt 8; $$i++) { Remove-Item -LiteralPath $$d -Recurse -Force -ErrorAction SilentlyContinue; if (-not (Test-Path -LiteralPath $$d)) { Write-Output 'gone'; break } ; Write-Output ('iter ' + $$i + ': still there'); Start-Sleep -Seconds 4 }"`
    Pop $0
    Pop $1

    nsExec::ExecToStack `cmd.exe /c (echo [${tag}] ps_exit=$0) >> "$TEMP\myclaw-uninst-trace.log"`
    Pop $2
    Pop $3
    nsExec::ExecToStack `cmd.exe /c (echo [${tag}] ps_exit=$0) >> "$WINDIR\Temp\myclaw-uninst-trace.log"`
    Pop $2
    Pop $3

    IfFileExists "${dirPath}\*.*" 0 _crd_done_${tag}
      DetailPrint "Warning: ${dirPath} still has files after 8 retries"
      nsExec::ExecToStack `cmd.exe /c (echo [${tag}] LEFTOVER after retries) >> "$TEMP\myclaw-uninst-trace.log"`
      Pop $0
      Pop $1
      nsExec::ExecToStack `cmd.exe /c (echo [${tag}] LEFTOVER after retries) >> "$WINDIR\Temp\myclaw-uninst-trace.log"`
      Pop $0
      Pop $1
    Goto _crd_done_${tag}

  _crd_absent_${tag}:
    nsExec::ExecToStack `cmd.exe /c (echo [${tag}] absent skipped) >> "$TEMP\myclaw-uninst-trace.log"`
    Pop $0
    Pop $1
    nsExec::ExecToStack `cmd.exe /c (echo [${tag}] absent skipped) >> "$WINDIR\Temp\myclaw-uninst-trace.log"`
    Pop $0
    Pop $1

  _crd_done_${tag}:
!macroend

!macro customUnInstall
  ; Trace: confirm we entered customUnInstall under silent mode.
  ; Wipe stale logs from prior runs so what we read is from THIS run.
  ; Use cmd echo > redirect (and >> later) — NSIS FileOpen/FileWrite
  ; produced empty zero-byte files in earlier silent-mode CI runs for
  ; reasons that don't repro in non-silent mode; cmd's echo redirect
  ; is rock-solid in both contexts.
  nsExec::ExecToStack `cmd.exe /c (echo [customUnInstall] enter scope=$UninstallScope) > "$TEMP\myclaw-uninst-trace.log"`
  Pop $0
  Pop $1
  nsExec::ExecToStack `cmd.exe /c (echo [customUnInstall] enter scope=$UninstallScope) > "$WINDIR\Temp\myclaw-uninst-trace.log"`
  Pop $0
  Pop $1

  ; Remove auto-start registry entries (both HKLM and HKCU, in case either was set)
  DeleteRegValue HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" "MyClaw"
  DeleteRegValue HKCU "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" "MyClaw"

  ; Remove Windows Defender exclusion added during install
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Remove-MpPreference -ExclusionPath '$INSTDIR' -ErrorAction SilentlyContinue"`
  Pop $0
  Pop $1

  ; Remove resources\cli from user PATH via PowerShell so long PATH values are handled safely
  InitPluginsDir
  ClearErrors
  File "/oname=$PLUGINSDIR\update-user-path.ps1" "${PROJECT_DIR}\resources\cli\win32\update-user-path.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\update-user-path.ps1" -Action remove -CliDir "$INSTDIR\resources\cli"'
  Pop $0
  Pop $1
  StrCmp $0 "error" 0 +2
    DetailPrint "Warning: Failed to launch PowerShell while removing PATH entry."
  StrCmp $0 "timeout" 0 +2
    DetailPrint "Warning: PowerShell PATH removal timed out."
  StrCmp $0 "0" 0 +2
    Goto _cu_pathDone
  DetailPrint "Warning: PowerShell PATH removal exited with code $0."

  _cu_pathDone:

  ; --- Scope-driven cleanup ---
  ;
  ; Three scopes (set on the welcome page or via /UNINSTALL_SCOPE=...):
  ;
  ;   "full"          — remove everything: app + ~/.myclaw + ~/.openclaw +
  ;                     %APPDATA%\myclaw-desktop + %LOCALAPPDATA%\myclaw-desktop.
  ;                     Reinstall starts from the first-launch wizard.
  ;
  ;   "main+runtime"  — remove app + ~/.myclaw, keep ~/.openclaw and the
  ;                     Electron userData (provider/channel config in
  ;                     electron-store).  Reinstall re-fetches openclaw
  ;                     but remembers the user's setup.
  ;
  ;   "main-only"     — keep everything except the app binary.  For users
  ;                     about to reinstall immediately.
  ;
  ; Always: kill running processes, release file locks before touching dirs.
  ; Always: removed auto-start, PATH, Defender exclusion above (those are
  ; pure system integration, not "user data").
  DetailPrint "Uninstall scope: $UninstallScope"
  nsExec::ExecToStack `cmd.exe /c (echo [scope-branch] $UninstallScope) >> "$TEMP\myclaw-uninst-trace.log"`
  Pop $0
  Pop $1
  nsExec::ExecToStack `cmd.exe /c (echo [scope-branch] $UninstallScope) >> "$WINDIR\Temp\myclaw-uninst-trace.log"`
  Pop $0
  Pop $1

  ${if} $UninstallScope == "main-only"
    nsExec::ExecToStack `cmd.exe /c (echo [scope-branch] early-exit main-only) >> "$TEMP\myclaw-uninst-trace.log"`
    Pop $0
    Pop $1
    Goto _cu_done
  ${endIf}

  ; Kill any lingering MyClaw processes (and their child trees) so we can
  ; release file locks on electron-store JSON, gateway sockets, runtime
  ; node_modules, log files in %APPDATA%, etc.  Both "full" and
  ; "main+runtime" scopes need this.
  ;
  ; Belt + suspenders:
  ;   1. taskkill /T /IM MyClaw.One.exe — kills the main app + its tree
  ;   2. taskkill /F /IM openclaw-gateway.exe — gateway can detach
  ;   3. PowerShell path-match — catches any node.exe / npm spawned from
  ;      $INSTDIR (utilityProcess workers, runtime install worker, etc.)
  ;      that might have escaped the parent tree.
  ;   4. Longer sleep — Electron's log writer often holds the .log file
  ;      open for ~3-5s after main process exit while flushing buffers.
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    nsExec::ExecToStack 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
    Pop $0
    Pop $1
  ${endIf}
  ${nsProcess::Unload}
  nsExec::ExecToStack 'taskkill /F /IM openclaw-gateway.exe'
  Pop $0
  Pop $1
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  Pop $1
  Sleep 5000

  ; --- Always remove ~/.myclaw (the runtime install) on full + main+runtime ---
  ; This is the dir created by ensure_myclaw_runtime_installed; leaving it
  ; behind makes the next install think the runtime is already there and
  ; skip the first-launch flow.  Removing it = clean reinit on next run.
  !insertmacro _CU_RemoveDir myclaw_runtime "$PROFILE\.myclaw"

  ; --- Full clean: also wipe Electron userData + ~/.openclaw ---
  ${if} $UninstallScope == "full"
    ; Electron's app.getName() returns the package.json "name" field
    ; ("myclaw-desktop"), not productName ("MyClaw.One"), so userData
    ; lives under %APPDATA%\myclaw-desktop\, not %APPDATA%\MyClaw.One\.
    ;
    ; CRITICAL: use $PROFILE\AppData\... not $APPDATA / $LOCALAPPDATA.
    ; In a per-machine uninstaller, electron-builder calls
    ; SetShellVarContext all, which makes $APPDATA resolve to
    ; C:\ProgramData (and $LOCALAPPDATA likewise) — i.e. the wrong
    ; place entirely.  The Electron userData was written using the
    ; running user's profile context, so the only path that actually
    ; matches is $PROFILE\AppData\....  $PROFILE is unaffected by
    ; shell context.
    !insertmacro _CU_RemoveDir appdata_roaming "$PROFILE\AppData\Roaming\myclaw-desktop"
    !insertmacro _CU_RemoveDir appdata_local   "$PROFILE\AppData\Local\myclaw-desktop"
    !insertmacro _CU_RemoveDir openclaw_home   "$PROFILE\.openclaw"
  ${endIf}

  ; --- Per-machine installs: clean other users' profiles too ---
  ; Same scope rules: full = everything, main+runtime = ~/.myclaw only.
  StrCpy $R0 0
  _cu_enumLoop:
    EnumRegKey $R1 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList" $R0
    StrCmp $R1 "" _cu_enumDone
    ReadRegStr $R2 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$R1" "ProfileImagePath"
    StrCmp $R2 "" _cu_enumNext
    ExpandEnvStrings $R3 $R2
    StrCmp $R3 $PROFILE _cu_enumNext
    ; Use plain RMDir /r for other-user dirs — we can't easily warn / retry
    ; for accounts other than the one running the uninstall.
    RMDir /r "$R3\.myclaw"
    ${if} $UninstallScope == "full"
      RMDir /r "$R3\AppData\Roaming\myclaw-desktop"
      RMDir /r "$R3\AppData\Local\myclaw-desktop"
      RMDir /r "$R3\.openclaw"
    ${endIf}
  _cu_enumNext:
    IntOp $R0 $R0 + 1
    Goto _cu_enumLoop
  _cu_enumDone:

  _cu_done:
!macroend
