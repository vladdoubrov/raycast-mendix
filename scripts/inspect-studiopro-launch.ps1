# Read-only diagnostic for Mendix Studio Pro / Version Selector launch integration.
# Use on Windows. This script does not launch, download, edit, or delete anything.
# After running it, you can click 'Edit in Studio Pro' in the Mendix Portal and
# inspect the handler path locally. Do not share raw command lines if they contain tokens.

$ErrorActionPreference = 'SilentlyContinue'
Write-Host '--- Candidate URI protocol registrations ---'
$roots = @('Registry::HKEY_CURRENT_USER\Software\Classes', 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Classes')
foreach ($root in $roots) {
  Get-ChildItem $root | Where-Object { $_.PSChildName -match '(?i)mendix|mxmodeler|studiopro|versionselector' } | ForEach-Object {
    $regPath = $_.PSPath
    $props = Get-ItemProperty -LiteralPath $regPath
    $cmdKey = Get-Item -LiteralPath "$regPath\shell\open\command"
    if ($null -ne $cmdKey -or $null -ne $props.'URL Protocol') {
      Write-Host ('Protocol/Key: ' + $_.PSChildName)
      Write-Host ('Handler: ' + $cmdKey.GetValue(''))
    }
  }
}
Write-Host '--- Installed Studio Pro executables (typical location) ---'
Get-ChildItem 'C:\Program Files\Mendix' -Filter 'studiopro.exe' -File -Recurse -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty FullName
Write-Host '--- Current Version Selector processes (names and paths only) ---'
Get-CimInstance Win32_Process | Where-Object { $_.Name -match '(?i)studio.?pro|versionselector|modeler' } |
  Select-Object Name, ExecutablePath | Format-Table -AutoSize
Write-Host 'No proof of a branch argument is implied by finding a URL handler.'
