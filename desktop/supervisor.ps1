param([string]$DataDir, [switch]$Stop)
$ErrorActionPreference = 'Stop'
if (!$DataDir) { $whaleCodex = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }; $DataDir = if ($env:WHALE_HOME) { $env:WHALE_HOME } else { Join-Path $whaleCodex 'whale-widget' } }
$DataDir = [IO.Path]::GetFullPath($DataDir)
$whaleHasher = [Security.Cryptography.SHA256]::Create()
$whaleHash = [BitConverter]::ToString($whaleHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($DataDir.ToLowerInvariant()))).Replace('-', '').Substring(0,24)
$whaleHasher.Dispose()
$whaleStopName = 'Local\CodexWhaleStop-' + $whaleHash
if ($Stop) { try { $whaleSignal = [Threading.EventWaitHandle]::OpenExisting($whaleStopName); [void]$whaleSignal.Set(); $whaleSignal.Dispose() } catch [Threading.WaitHandleCannotBeOpenedException] { }; return }
Add-Type -Namespace WhaleSupervisor -Name NativeConsole -MemberDefinition @'
[DllImport("kernel32.dll")] static extern bool FreeConsole();
[DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
public static bool HasConsole() { return GetConsoleWindow() != IntPtr.Zero; }
public static void DetachConsole() { FreeConsole(); }
'@
[WhaleSupervisor.NativeConsole]::DetachConsole()
$whaleFresh = $false
$whaleMutex = [Threading.Mutex]::new($true, ('Local\CodexWhaleWatch-' + $whaleHash), [ref]$whaleFresh)
if (!$whaleFresh) { $whaleMutex.Dispose(); return }
$whaleStop = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, $whaleStopName)
[void]$whaleStop.Reset()
$whaleChild = $null; $whaleOutput = $null; $whaleErrors = $null
$whaleLastLaunch = [DateTime]::MinValue
$whaleStateFile = Join-Path $DataDir 'supervisor-state.json'
$whaleParentPid = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId
@{ pid=$PID; parentPid=$whaleParentPid; consoleAttached=[WhaleSupervisor.NativeConsole]::HasConsole(); startedAt=[DateTime]::UtcNow.ToString('o'); host='PowerShell' } | ConvertTo-Json | Set-Content -LiteralPath $whaleStateFile -Encoding utf8
function Read-WhaleJson([string]$File) { if (Test-Path -LiteralPath $File) { Get-Content -LiteralPath $File -Raw | ConvertFrom-Json } else { @{} } }
$whaleFatal = $false
try {
    # Keep the pet running unless the service is disabled or the user stopped it.
    # The stop marker's name dates from the retired window-follow mode, whose own
    # markers had no pauseAll and no longer hold the pet back.
    while (!$whaleStop.WaitOne(500)) {
        $whaleNow = [DateTime]::UtcNow
        if ($whaleChild -and $whaleChild.HasExited) { $whaleChild.Dispose(); $whaleChild = $null }
        if (!$whaleChild -and ($whaleNow - $whaleLastLaunch).TotalSeconds -gt 4) {
            $whaleConfig = Read-WhaleJson (Join-Path $DataDir 'follow-config.json')
            # Local deployment hook: follow-config.json may append extra launch flags
            # (for example --no-sandbox where Chromium cannot initialise its sandbox).
            $whaleExtra = if ($whaleConfig.extraArgs) { ' ' + (@($whaleConfig.extraArgs) -join ' ') } else { '' }
            $whalePause = Read-WhaleJson (Join-Path $DataDir 'pause-until-host-exit.json')
            if ($whaleConfig.enabled -eq $false -or $whalePause.pauseAll -eq $true) { continue }
            if (!(Test-Path -LiteralPath $whaleConfig.electronPath)) { throw 'Desktop runtime is missing.' }
            $whaleMain = Join-Path $whaleConfig.pluginRoot 'desktop\main.cjs'
            $whaleStart = [Diagnostics.ProcessStartInfo]::new()
            $whaleStart.FileName = $whaleConfig.electronPath
            $whaleStart.Arguments = '"' + $whaleMain + '" "--whale-data=' + $DataDir + '" --supervised' + $whaleExtra
            $whaleStart.WorkingDirectory = $whaleConfig.pluginRoot
            $whaleStart.UseShellExecute=$false; $whaleStart.CreateNoWindow=$true
            $whaleStart.RedirectStandardInput=$true; $whaleStart.RedirectStandardOutput=$true; $whaleStart.RedirectStandardError=$true
            $whaleStart.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
            $whaleStart.EnvironmentVariables['WHALE_LAUNCH_TIME'] = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
            $whaleChild = [Diagnostics.Process]::new(); $whaleChild.StartInfo=$whaleStart
            [void]$whaleChild.Start(); $whaleLastLaunch=$whaleNow
            # Drain both outputs so a full pipe never blocks the pet.
            $whaleOutput=$whaleChild.StandardOutput.ReadToEndAsync(); $whaleErrors=$whaleChild.StandardError.ReadToEndAsync()
        }
    }
} catch {
    $whaleFatal = $true
    @{ message=$_.Exception.Message; at=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $DataDir 'supervisor-error.json') -Encoding utf8
} finally {
    if ($whaleChild) {
        try { $whaleChild.StandardInput.Close(); [void]$whaleChild.WaitForExit(7000) } catch { }
        $whaleChild.Dispose()
    }
    Remove-Item -LiteralPath $whaleStateFile -ErrorAction SilentlyContinue
    $whaleStop.Dispose(); $whaleMutex.Dispose()
}
if ($whaleFatal) { exit 1 }
