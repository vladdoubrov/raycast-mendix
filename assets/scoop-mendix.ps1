# Runs Scoop for the Mendix bucket in a visible window, so download progress and the admin prompt
# (machine-scope installs) are shown. Inputs: MX_SCOOP_ACTION = install | update; MX_SCOOP_APP = <bucket>/<app>.
$ErrorActionPreference = 'Stop'
try {
    if (-not (Get-Command scoop -ErrorAction SilentlyContinue)) { throw 'Scoop was not found on PATH.' }
    switch ($env:MX_SCOOP_ACTION) {
        'install' {
            # Only exact Studio Pro manifests; the app name reaches scoop as a single argument.
            if ($env:MX_SCOOP_APP -notmatch '^[\w.-]+/mendix-studio-pro-\d+\.\d+\.\d+(-machine)?$') { throw "Unexpected Scoop app: $env:MX_SCOOP_APP" }
            $host.UI.RawUI.WindowTitle = "scoop install $env:MX_SCOOP_APP"
            scoop install $env:MX_SCOOP_APP
        }
        'update' {
            $host.UI.RawUI.WindowTitle = 'scoop update'
            scoop update
        }
        default { throw "Unknown action: $env:MX_SCOOP_ACTION" }
    }
    # Scoop reports failures (e.g. "Scoop uses Git...") with an exit code, not an exception.
    if ($LASTEXITCODE) { throw "Scoop failed with exit code $LASTEXITCODE; see the messages above." }
    Write-Host ''
    Write-Host 'Done. In Raycast, refresh Mendix Studio Pro Versions with Ctrl+R. You can close this window.' -ForegroundColor Green
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
}
