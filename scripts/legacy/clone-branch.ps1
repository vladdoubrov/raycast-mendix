# Clone one Mendix Team Server branch and open its .mpr.
# Launched by the Raycast action in its own PowerShell window, so a multi-GB clone
# can run as long as it needs and its progress and errors stay visible.
# Raycast passes the values as MX_CLONE_* environment variables (no command-line quoting);
# by hand: .\clone-branch.ps1 -Url https://git.api.mendix.com/<app-id>.git -Branch <branch> -Target C:\Mendix\<folder>
param(
  [string]$Url = $env:MX_CLONE_URL,
  [string]$Branch = $env:MX_CLONE_BRANCH,
  [string]$Target = $env:MX_CLONE_TARGET,
  [string]$StudioPro = $env:MX_CLONE_STUDIOPRO
)

if (-not $Url -or -not $Branch -or -not $Target) {
  Write-Host "Usage: clone-branch.ps1 -Url <repo url> -Branch <branch> -Target <folder> [-StudioPro <studiopro.exe>]" -ForegroundColor Red
  return
}

# Raycast's environment lacks the full PATH and PATHEXT (without PATHEXT, a bare `git` does not
# resolve to git.exe), so load both the way a new terminal would.
$env:Path = @(
  [Environment]::GetEnvironmentVariable("Path", "Machine"),
  [Environment]::GetEnvironmentVariable("Path", "User"),
  $env:Path
) -join ";"
$env:PATHEXT = [Environment]::GetEnvironmentVariable("PATHEXT", "Machine")
# Raycast sets LC_ALL to a BCP 47 tag (en-NL-u-ca-...) that Git's sh rejects with setlocale warnings.
Remove-Item Env:LC_ALL -ErrorAction SilentlyContinue
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "git was not found on PATH. Install Git for Windows (https://git-scm.com/download/win) and try again." -ForegroundColor Red
  return
}

function Format-Duration([TimeSpan]$Span) {
  if ($Span.TotalHours -ge 1) { return "{0}h {1:D2}m {2:D2}s" -f [int][Math]::Floor($Span.TotalHours), $Span.Minutes, $Span.Seconds }
  if ($Span.TotalMinutes -ge 1) { return "{0}m {1:D2}s" -f $Span.Minutes, $Span.Seconds }
  return "{0:N1}s" -f $Span.TotalSeconds
}

# Each step prints its start time and duration; the summary is printed however the script ends.
$timings = [ordered]@{}
$total = [Diagnostics.Stopwatch]::StartNew()
$step = $null
function Start-Step([string]$Name) {
  $script:stepName = $Name
  $script:step = [Diagnostics.Stopwatch]::StartNew()
  Write-Host ""
  Write-Host "[$(Get-Date -Format HH:mm:ss)] $Name" -ForegroundColor Cyan
}
function Stop-Step {
  $timings[$script:stepName] = $script:step.Elapsed
  $script:step = $null
  Write-Host "[$(Get-Date -Format HH:mm:ss)] $($script:stepName) took $(Format-Duration $timings[$script:stepName])" -ForegroundColor DarkGray
}

$Host.UI.RawUI.WindowTitle = "Mendix clone: $Branch"
Write-Host "Branch : $Branch"
Write-Host "Target : $Target"
Write-Host "Start  : $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")"

try {
  Start-Step "git clone"
  Write-Host "The Mendix server first prepares the download; this can take a minute or more before progress appears." -ForegroundColor DarkGray
  # git refuses a non-empty destination, and removes the folder again if the clone fails or is cancelled (Ctrl+C).
  # Credentials come from the Git credential helper; nothing secret is passed on this command line.
  # autocrlf/longpaths are set before the checkout, as Studio Pro does: files keep their stored line
  # endings (so mx-postclone.sh has none to reset) and deep javasource/widget paths do not fail.
  git clone --progress -c core.autocrlf=false -c core.longpaths=true --single-branch "--branch=$Branch" -- $Url $Target
  $exitCode = $LASTEXITCODE
  Stop-Step
  if ($exitCode -ne 0) {
    Write-Host ""
    Write-Host "git clone failed (exit code $exitCode). See the output above." -ForegroundColor Red
    return
  }

  # Make the clone look like a Studio Pro download (Team Server id, notes, all branches, line endings).
  # mx-postclone.sh is a copy of Documents\Projects\Tools\mx-postclone.sh, run with Git for Windows' bash.
  Start-Step "mx-postclone.sh"
  $gitRoot = Split-Path -Parent (Get-Command git).Source
  while ($gitRoot -and -not (Test-Path -LiteralPath (Join-Path $gitRoot "bin\bash.exe"))) { $gitRoot = Split-Path -Parent $gitRoot }
  if (-not $gitRoot) {
    Write-Host "Git Bash (bin\bash.exe) was not found next to git; cannot run mx-postclone.sh." -ForegroundColor Red
    return
  }
  & (Join-Path $gitRoot "bin\bash.exe") (Join-Path $PSScriptRoot "mx-postclone.sh") $Target
  $exitCode = $LASTEXITCODE
  Stop-Step
  if ($exitCode -ne 0) {
    Write-Host ""
    Write-Host "mx-postclone.sh failed (exit code $exitCode). Fix the cause, then rerun it in Git Bash:" -ForegroundColor Red
    Write-Host "  bash `"$(Join-Path $PSScriptRoot "mx-postclone.sh")`" `"$Target`""
    return
  }

  # Studio Pro projects normally have an MPR at the root; tolerate one nested level.
  $mpr = Get-ChildItem -LiteralPath $Target -Filter *.mpr -File | Select-Object -First 1
  if (-not $mpr) { $mpr = Get-ChildItem -LiteralPath $Target -Filter *.mpr -File -Depth 1 -Recurse | Select-Object -First 1 }
  if (-not $mpr) {
    Write-Host ""
    Write-Host "Clone complete, but no .mpr file was found in $Target." -ForegroundColor Red
    return
  }

  Write-Host ""
  Write-Host "Clone ready. Opening $($mpr.FullName)" -ForegroundColor Green
  if ($StudioPro) {
    Start-Process -FilePath $StudioPro -ArgumentList "`"$($mpr.FullName)`""
  } else {
    Invoke-Item -LiteralPath $mpr.FullName  # .mpr file association / Mendix Version Selector
  }
} finally {
  # A step still running here failed early or was cancelled (Ctrl+C); record how far it got.
  if ($step) { $timings["$stepName (stopped)"] = $step.Elapsed }
  Write-Host ""
  Write-Host "Timings" -ForegroundColor Cyan
  foreach ($name in $timings.Keys) { Write-Host ("  {0,-26} {1}" -f $name, (Format-Duration $timings[$name])) }
  Write-Host ("  {0,-26} {1}" -f "Total", (Format-Duration $total.Elapsed))
}
