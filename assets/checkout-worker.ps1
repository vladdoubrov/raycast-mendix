param([string]$RequestFile = $env:MX_CHECKOUT_REQUEST, [switch]$NoLaunch, [switch]$AllowLocalTestRemote)
$ErrorActionPreference = 'Stop'
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD'
Remove-Item Env:LC_ALL -ErrorAction SilentlyContinue
# Never inherit credential-bearing Git traces from Raycast's environment.
Get-ChildItem Env: | Where-Object { $_.Name -match '^GIT_(TRACE|CURL_VERBOSE)' } | Remove-Item

# All Git children belong to this worker. Closing its terminal terminates them too.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public sealed class CheckoutJob : IDisposable {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string n);
 [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr p,uint s);
 [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long a,b; public uint flags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h; }
 [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic basic; public Io io; public UIntPtr a,b,c,d; }
 IntPtr handle;
 public CheckoutJob() {
  handle=CreateJobObject(IntPtr.Zero,null); var info=new Extended(); info.basic.flags=0x2000;
  int size=Marshal.SizeOf(info); IntPtr p=Marshal.AllocHGlobal(size);
  try { Marshal.StructureToPtr(info,p,false); if(handle==IntPtr.Zero || !SetInformationJobObject(handle,9,p,(uint)size)) throw new Exception("Cannot create Git process job"); }
  finally { Marshal.FreeHGlobal(p); }
 }
 public void Add(IntPtr process) { if(!AssignProcessToJobObject(handle,process)) throw new Exception("Cannot supervise Git process"); }
 public void Dispose() { if(handle!=IntPtr.Zero) { CloseHandle(handle); handle=IntPtr.Zero; } }
}
'@
$script:utf8 = New-Object System.Text.UTF8Encoding($false)
$script:status = $null
$script:job = $null
$script:cacheLock = $null
$script:targetLock = $null
$script:ownedStaging = $null
$script:ownedBuilding = $null
$script:total = [Diagnostics.Stopwatch]::StartNew()
$exitCode = 1
function SafeText([string]$Value) {
    $Value = $Value -replace '(?i)(https?://)[^/\s@]+@', '$1[redacted]@'
    return ($Value -replace '(?i)(Authorization\s*[:=]\s*).*', '$1[redacted]')
}
function Log([string]$Message) {
    $line = '{0} {1}' -f [DateTime]::UtcNow.ToString('o'), (SafeText $Message)
    Write-Host $line
    [IO.File]::AppendAllText((Join-Path $script:opDir 'console.log'), $line + "`n", $script:utf8)
}
function WriteJson([string]$Path, $Value) {
    $temp = $Path + '.tmp'
    $json = $Value | ConvertTo-Json -Depth 12
    # Readers and antivirus can briefly hold a file without FILE_SHARE_DELETE.
    for ($attempt=0; $attempt -lt 10; $attempt++) {
        try {
            [IO.File]::WriteAllText($temp, $json, $script:utf8)
            if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temp, $Path, [NullString]::Value) }
            else { [IO.File]::Move($temp, $Path) }
            return
        } catch [IO.IOException] {
            if ($attempt -eq 9) { throw }
            Start-Sleep -Milliseconds 100
        }
    }
}
function SaveStatus {
    $script:status.updatedAt = [DateTime]::UtcNow.ToString('o')
    $script:status.elapsedSeconds = [Math]::Round($script:total.Elapsed.TotalSeconds, 2)
    WriteJson (Join-Path $script:opDir 'status.json') $script:status
}
function CheckCancel {
    if (Test-Path -LiteralPath (Join-Path $script:opDir 'cancel.request')) { throw 'CANCELLED: Cancellation requested.' }
}
function Stage([string]$Name, [scriptblock]$Body) {
    CheckCancel
    $script:status.stage = $Name
    SaveStatus
    Log "Starting $Name"
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try { & $Body } finally {
        $script:status.timings[$Name] = [Math]::Round($timer.Elapsed.TotalSeconds, 2)
        SaveStatus
        Log ("Finished {0}: {1:N1}s" -f $Name, $timer.Elapsed.TotalSeconds)
    }
}
# Windows native argv escaping; no branch/path is evaluated as PowerShell code.
function QuoteArg([string]$Value) {
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
function Git([string[]]$GitArgs, [switch]$MayFail, [string]$InputText) {
    CheckCancel
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $script:gitExe
    $start.Arguments = ((@('-c','gc.auto=0','-c','maintenance.auto=false') + $GitArgs | ForEach-Object { QuoteArg $_ }) -join ' ')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = $script:utf8
    $start.StandardErrorEncoding = $script:utf8
    $start.RedirectStandardInput = $null -ne $InputText -and $InputText.Length -gt 0
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    $output = New-Object 'System.Collections.Generic.List[string]'
    $errors = New-Object 'System.Collections.Generic.List[string]'
    try {
        [void]$process.Start()
        if (-not $process.HasExited) {
            try { $script:job.Add($process.Handle) }
            catch { if (-not $process.HasExited) { throw } }
        }
        if ($start.RedirectStandardInput) {
            $inputBytes = $script:utf8.GetBytes($InputText)
            $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
            $process.StandardInput.Close()
        }
        $outTask = $process.StandardOutput.ReadLineAsync()
        $errTask = $process.StandardError.ReadLineAsync()
        $heartbeat = [Diagnostics.Stopwatch]::StartNew()
        while ($null -ne $outTask -or $null -ne $errTask) {
            CheckCancel
            if ($null -ne $outTask -and $outTask.IsCompleted) {
                $line = $outTask.GetAwaiter().GetResult()
                if ($null -eq $line) { $outTask = $null } else { $output.Add($line); $outTask = $process.StandardOutput.ReadLineAsync() }
            }
            if ($null -ne $errTask -and $errTask.IsCompleted) {
                $line = $errTask.GetAwaiter().GetResult()
                if ($null -eq $line) { $errTask = $null } else { $errors.Add($line); Log $line; $errTask = $process.StandardError.ReadLineAsync() }
            }
            if ($heartbeat.Elapsed.TotalSeconds -gt 3) { SaveStatus; $heartbeat.Restart() }
            Start-Sleep -Milliseconds 10
        }
        $process.WaitForExit()
        $code = $process.ExitCode
        $event = @{ time=[DateTime]::UtcNow.ToString('o'); arguments=($GitArgs | ForEach-Object { SafeText $_ }); exitCode=$code; seconds=$timer.Elapsed.TotalSeconds }
        [IO.File]::AppendAllText((Join-Path $script:opDir 'git-events.jsonl'), ($event | ConvertTo-Json -Compress -Depth 4) + "`n", $script:utf8)
        if ($code -ne 0 -and -not $MayFail) { throw "Git exited $code`: $(SafeText ($errors -join ' '))" }
        return @{ Text=($output -join "`n").Trim(); Error=($errors -join "`n"); Code=$code }
    } finally {
        if (-not $process.HasExited) { try { $process.Kill() } catch {} }
        $process.Dispose()
    }
}
function G([string[]]$GitArgs) { return (Git $GitArgs).Text }
function Config([string]$Repo, [string]$Key) { return (Git @('-C',$Repo,'config','--get',$Key) -MayFail).Text }
function AssertPlainPath([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse points are not supported: $current" }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}
function AssertChild([string]$Path, [string]$Parent) {
    $full = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Path escapes owned directory: $full" }
    AssertPlainPath $full
}
function GetLock([string]$Path) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $previousStage = $script:status.stage
    $deniedAttempts = 0
    while ($true) {
        CheckCancel
        try {
            # DeleteOnClose removes the file when the handle closes, also when the worker is killed.
            $handle = [IO.FileStream]::new($Path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 1, [IO.FileOptions]::DeleteOnClose)
            $script:status.stage = $previousStage
            return $handle
        }
        catch [IO.IOException] {
            if ($timer.Elapsed.TotalMinutes -gt 30) { throw "Timed out waiting for operation lock: $Path" }
            $script:status.stage = 'waiting-for-lock'
            SaveStatus
            Start-Sleep -Milliseconds 500
        }
        catch [UnauthorizedAccessException] {
            # Windows denies opening a file while the previous owner's delete is pending; that lasts only a moment.
            if (++$deniedAttempts -gt 20) { throw }
            Start-Sleep -Milliseconds 100
        }
    }
}
# Removes a temporary folder this operation created. Best effort: a scanner can hold files for a moment,
# and a leftover folder is reported rather than failing the cleanup.
function RemoveOwnedFolder([string]$Path, [string]$Parent) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
    try {
        AssertChild $Path $Parent
        # The \\?\ prefix lets Windows PowerShell 5.1 reach paths longer than 260 characters.
        $long = '\\?\' + [IO.Path]::GetFullPath($Path)
        # Never recurse through a junction or symlink; it could point at user data.
        if (@(Get-ChildItem -LiteralPath $long -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'It contains a reparse point.' }
        for ($attempt = 1; ; $attempt++) {
            try { Remove-Item -LiteralPath $long -Force -Recurse -ErrorAction Stop; break }
            catch { if ($attempt -ge 10) { throw }; Start-Sleep -Milliseconds 500 }
        }
        Log "Removed incomplete folder $Path"
    } catch {
        $message = "Could not remove incomplete folder $Path; delete it manually. $(SafeText $_.Exception.Message)"
        Log $message
        $script:status.error = ($script:status.error + ' ' + $message).Trim()
    }
}
function IsFull([string]$Repo) {
    if ((G @('-C',$Repo,'rev-parse','--is-shallow-repository')) -ne 'false') { return $false }
    if ((Git @('-C',$Repo,'config','--get-regexp','^(extensions\.partialclone|remote\..*\.(promisor|partialclonefilter))$') -MayFail).Code -eq 0) { return $false }
    $objects = G @('-C',$Repo,'rev-parse','--git-path','objects/info/alternates')
    if (-not [IO.Path]::IsPathRooted($objects)) { $objects = Join-Path $Repo $objects }
    return -not ((Test-Path -LiteralPath $objects) -and (Get-Item -LiteralPath $objects).Length -gt 0)
}
function RefreshCache([string]$Repo) {
    [void](G @('-C',$Repo,'fetch','--atomic','--prune','--progress','origin','+refs/heads/*:refs/heads/*','+refs/notes/mx_metadata:refs/notes/mx_metadata'))
}
function SaveManifest {
    WriteJson $script:manifestPath @{ schemaVersion=1; appId=$script:req.appId; remoteUrl=$script:req.remoteUrl; cloneType='full'; lastSuccessfulRefresh=[DateTime]::UtcNow.ToString('o') }
}
function AssertCache {
    $manifest = Get-Content -LiteralPath $script:manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.appId -ne $script:req.appId -or $manifest.remoteUrl -cne $script:req.remoteUrl -or $manifest.cloneType -ne 'full') { throw 'Cache ownership manifest does not match this app.' }
    if ((G @('-C',$script:cacheRepo,'rev-parse','--is-bare-repository')) -ne 'true' -or -not (IsFull $script:cacheRepo)) { throw 'Cache is not a complete, independent bare repository.' }
    if ((Config $script:cacheRepo 'remote.origin.url') -cne $script:req.remoteUrl) { throw 'Cache remote does not match this app.' }
}
try {
    $script:req = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $script:opDir = Split-Path -Parent ([IO.Path]::GetFullPath($RequestFile))
    if ($req.schemaVersion -ne 1 -or $req.appId -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $req.operationId -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid operation request.' }
    if ($req.action -notin @('checkout','refresh-cache','remove-cache') -or $req.cloneType -notin @('full','partial')) { throw 'Invalid action or clone type.' }
    $canonical = "https://git.api.mendix.com/$($req.appId).git/"
    if ($req.remoteUrl -cne $canonical -and -not ($AllowLocalTestRemote -and $req.remoteUrl.StartsWith('file:///'))) { throw 'Remote URL must be the canonical app URL, including its trailing slash.' }
    $script:status = [ordered]@{ schemaVersion=1; operationId=$req.operationId; appId=$req.appId; branch=$req.branch; action=$req.action; state='running'; stage='preflight'; strategy=''; target=$req.target; startedAt=[DateTime]::UtcNow.ToString('o'); updatedAt=''; pid=$PID; processStartedAt=(Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o'); ready=$false; timings=@{}; elapsedSeconds=0; error=''; mprPath=''; commit='' }
    SaveStatus
    $script:gitExe = (Get-Command git.exe -ErrorAction Stop).Source
    $script:job = New-Object CheckoutJob
    if ($req.diagnostics) { $env:GIT_TRACE2_PERF = Join-Path $opDir 'git-trace2-perf.log' }
    Log ('Git version: ' + (G @('--version')))
    Log ('PowerShell: ' + $PSVersionTable.PSVersion.ToString())
    if ($req.action -eq 'checkout') {
        if ($req.branch.StartsWith('-')) { throw 'Invalid branch name.' }
        [void](G @('check-ref-format','--branch',$req.branch))
        AssertPlainPath $req.projectsRoot
        [void][IO.Directory]::CreateDirectory($req.projectsRoot)
        AssertChild $req.target $req.projectsRoot
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($req.target)).TrimEnd('\','/') -ne [IO.Path]::GetFullPath($req.projectsRoot).TrimEnd('\','/')) { throw 'Checkout must be a direct child of the project root.' }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $key = [BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($req.target.ToLowerInvariant()))).Replace('-','') } finally { $sha.Dispose() }
        $script:targetLock = GetLock (Join-Path $req.projectsRoot ".mx-target-$key.lock")
        if (Test-Path -LiteralPath $req.target) { throw 'Destination already exists. No files were changed.' }
        $script:staging = Join-Path $req.projectsRoot ".mx-checkout-$($req.operationId)"
        AssertChild $staging $req.projectsRoot
        if (Test-Path -LiteralPath $staging) { throw 'Staging directory already exists; it is not removed because this operation did not create it.' }
        # From here on the staging folder belongs to this operation and is removed if it fails.
        $script:ownedStaging = $staging
        WriteJson (Join-Path $opDir 'ownership.json') @{ staging=$staging; target=$req.target; operationId=$req.operationId }
    }
    $useCache = ($req.cloneType -eq 'full' -and $req.reuseLocalRepositories) -or $req.action -ne 'checkout'
    if ($useCache) {
        AssertPlainPath $req.cacheRoot
        [void][IO.Directory]::CreateDirectory($req.cacheRoot)
        # The default cache sits among the user's projects; hide it like the other dot-folders there.
        $cacheBase = New-Object IO.DirectoryInfo (Split-Path (Split-Path $req.cacheRoot -Parent) -Parent)
        if ($cacheBase.Name -eq '.mendix-switcher-cache') {
            try { $cacheBase.Attributes = $cacheBase.Attributes -bor [IO.FileAttributes]::Hidden }
            catch { Log "Could not hide $($cacheBase.FullName): $($_.Exception.Message)" }
        }
        $script:cacheRepo = Join-Path $req.cacheRoot 'full.git'
        $script:manifestPath = Join-Path $req.cacheRoot 'manifest.json'
        AssertChild $cacheRepo $req.cacheRoot
        $script:cacheLock = GetLock (Join-Path $req.cacheRoot 'cache.lock')
        if ($req.action -eq 'remove-cache') {
            Stage 'remove-cache' {
                if (Test-Path -LiteralPath $cacheRepo) {
                    AssertCache
                    # Reject nested junctions before recursive removal. The target is fixed and app-owned.
                    if (@(Get-ChildItem -LiteralPath $cacheRepo -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Cache contains a reparse point; removal stopped.' }
                    Remove-Item -LiteralPath $cacheRepo -Force -Recurse
                    Remove-Item -LiteralPath $manifestPath -Force
                }
            }
        } else {
            Stage 'prepare-cache' {
                if (Test-Path -LiteralPath $cacheRepo) {
                    AssertCache
                    $status.strategy = 'warm-full-cache'
                    RefreshCache $cacheRepo
                    SaveManifest
                } else {
                    if (Test-Path -LiteralPath $manifestPath) { throw 'Cache manifest exists without its repository; inspect the cache before retrying.' }
                    $building = Join-Path $req.cacheRoot ".building-$($req.operationId)"
                    AssertChild $building $req.cacheRoot
                    if (Test-Path -LiteralPath $building) { throw 'Cache build directory already exists; it is not removed because this operation did not create it.' }
                    $script:ownedBuilding = $building
                    $seed = $null
                    foreach ($candidate in $req.seeds) {
                        try {
                            AssertPlainPath $candidate
                            if (-not (Test-Path -LiteralPath (Join-Path $candidate '.git') -PathType Container)) { continue }
                            if ((Get-ChildItem -LiteralPath (Join-Path $candidate '.git') -Filter '*.lock' -Recurse -Force | Measure-Object).Count) { continue }
                            if ((Config $candidate 'remote.origin.url').TrimEnd('/') -cne $req.remoteUrl.TrimEnd('/')) { continue }
                            if (IsFull $candidate) { $seed = $candidate; break }
                        } catch { Log "Skipping unavailable seed: $(SafeText $_.Exception.Message)" }
                    }
                    if ($seed) {
                        $status.strategy = 'seeded-full-cache'
                        # Reuse immutable object files directly; do not repack gigabytes through upload-pack.
                        # Git uses hard links when possible and copies when the filesystem requires it.
                        [void](G @('clone','--bare','--local','--',$seed,$building))
                        [void](G @('-C',$building,'remote','set-url','origin',$req.remoteUrl))
                        # A local clone imports local heads/tags. Replace those with remote-tracking
                        # refs before fetching, so unpublished branches/tags cannot appear in the cache.
                        $refCommands = New-Object 'System.Collections.Generic.List[string]'
                        foreach ($ref in ((G @('-C',$building,'for-each-ref','--format=%(refname)')) -split "`n" | Where-Object { $_ })) { $refCommands.Add("delete $ref") }
                        # Two transactions allow a branch to be both deleted and recreated.
                        if ($refCommands.Count) { [void](Git @('-C',$building,'update-ref','--stdin') -InputText (($refCommands -join "`n") + "`n")) }
                        $refCommands.Clear()
                        foreach ($record in ((G @('-C',$seed,'for-each-ref','--format=%(objectname) %(refname)','refs/remotes/origin/')) -split "`n" | Where-Object { $_ })) {
                            $parts = $record -split ' ',2
                            if ($parts[1] -ne 'refs/remotes/origin/HEAD') {
                                $refCommands.Add('update refs/heads/' + $parts[1].Substring('refs/remotes/origin/'.Length) + ' ' + $parts[0])
                            }
                        }
                        if ($refCommands.Count) { [void](Git @('-C',$building,'update-ref','--stdin') -InputText (($refCommands -join "`n") + "`n")) }
                        RefreshCache $building
                    } else {
                        $status.strategy = 'cold-full-cache'
                        [void](G @('clone','--bare','--progress','--',$req.remoteUrl,$building))
                        [void](G @('-C',$building,'fetch','--progress','origin','+refs/notes/mx_metadata:refs/notes/mx_metadata'))
                    }
                    [void](G @('-C',$building,'config','remote.origin.fetch','+refs/heads/*:refs/heads/*'))
                    if (-not (IsFull $building)) { throw 'New cache unexpectedly depends on missing objects.' }
                    [void](G @('-C',$building,'rev-parse','--verify','refs/notes/mx_metadata'))
                    [IO.Directory]::Move($building, $cacheRepo)
                    $script:ownedBuilding = $null
                    SaveManifest
                }
            }
            if ($req.action -eq 'checkout') {
                Stage 'materialize-local' {
                    $status.commit = G @('-C',$cacheRepo,'rev-parse','--verify',"refs/heads/$($req.branch)^{commit}")
                    [void](G @('clone','--local','--no-checkout','-c','core.autocrlf=false','-c','core.longpaths=true',"--branch=$($req.branch)",'--',$cacheRepo,$staging))
                    [void](G @('-C',$staging,'fetch','origin','+refs/notes/mx_metadata:refs/notes/mx_metadata'))
                    [void](G @('-C',$staging,'remote','set-url','origin',$req.remoteUrl))
                }
            }
        }
        $cacheLock.Dispose(); $script:cacheLock = $null
    } else {
        Stage 'clone-remote' {
            $status.strategy = 'direct-' + $req.cloneType
            $arguments = @('clone','--progress','--no-checkout','-c','core.autocrlf=false','-c','core.longpaths=true',"--branch=$($req.branch)")
            if ($req.cloneType -eq 'partial') { $arguments += '--filter=blob:none' }
            $result = Git ($arguments + @('--',$req.remoteUrl,$staging))
            if ($result.Error -match 'filtering not recognized by server, ignoring') {
                $status.strategy = 'direct-full-filter-unavailable'
                [void](Git @('-C',$staging,'config','--unset-all','remote.origin.promisor') -MayFail)
                [void](Git @('-C',$staging,'config','--unset-all','remote.origin.partialclonefilter') -MayFail)
                Log 'Server ignored the partial filter; completed a full clone.'
            }
            $status.commit = G @('-C',$staging,'rev-parse','--verify',"refs/remotes/origin/$($req.branch)^{commit}")
        }
        Stage 'fetch-metadata' { [void](G @('-C',$staging,'fetch','--progress','origin','+refs/notes/mx_metadata:refs/notes/mx_metadata')) }
    }
    if ($req.action -eq 'checkout') {
        Stage 'configure-checkout' {
            foreach ($pair in @(@('core.autocrlf','false'),@('core.longpaths','true'),@('mendix.sprintr-project-id',$req.appId),@('mendix.lineEndingResetDone','true'),@('notes.rewriteRef','refs/notes/mx_metadata'),@('notes.rewriteMode','overwrite'),@('notes.rewrite.rebase','true'),@('remote.origin.fetch','+refs/heads/*:refs/remotes/origin/*'))) {
                [void](G @('-C',$staging,'config','--replace-all',$pair[0],$pair[1]))
            }
            [void](G @('-C',$staging,'checkout',$req.branch,'--'))
            [void](G @('-C',$staging,'branch',"--set-upstream-to=origin/$($req.branch)",$req.branch))
        }
        Stage 'validate-checkout' {
            if ((Config $staging 'remote.origin.url') -cne $req.remoteUrl) { throw 'Origin validation failed.' }
            if ((G @('-C',$staging,'symbolic-ref','--short','HEAD')) -cne $req.branch) { throw 'Branch validation failed.' }
            if ((G @('-C',$staging,'rev-parse','HEAD')) -ne $status.commit) { throw 'Commit validation failed.' }
            if ((G @('-C',$staging,'rev-parse','--abbrev-ref','@{upstream}')) -cne "origin/$($req.branch)") { throw 'Upstream validation failed.' }
            [void](G @('-C',$staging,'rev-parse','--verify','refs/notes/mx_metadata'))
            if ($status.strategy -notmatch '^direct-partial$' -and -not (IsFull $staging)) { throw 'Full checkout is shallow or depends on another repository.' }
            if (G @('-C',$staging,'status','--porcelain','--untracked-files=normal')) { throw 'Checkout is not clean.' }
            $mprs = @(Get-ChildItem -LiteralPath $staging -Filter '*.mpr' -File)
            foreach ($dir in Get-ChildItem -LiteralPath $staging -Directory | Where-Object { $_.Name -ne '.git' }) { $mprs += @(Get-ChildItem -LiteralPath $dir.FullName -Filter '*.mpr' -File) }
            if ($mprs.Count -ne 1) { throw "Expected one MPR at root or one folder below, found $($mprs.Count)." }
            $script:mprRelative = $mprs[0].FullName.Substring($staging.Length).TrimStart('\','/')
        }
        Stage 'publish-checkout' {
            AssertChild $req.target $req.projectsRoot
            if (Test-Path -LiteralPath $req.target) { throw 'Destination was created by another process.' }
            [IO.Directory]::Move($staging, $req.target)
            $script:ownedStaging = $null
            $status.ready = $true
            $status.mprPath = Join-Path $req.target $mprRelative
        }
        Stage 'launch-studio-pro' {
            # Requests written before the launch field existed have none, so only an explicit false skips it.
            if (-not $NoLaunch -and $req.launch -ne $false) {
                if ($req.studioProExecutable) { Start-Process -FilePath $req.studioProExecutable -ArgumentList (QuoteArg $status.mprPath) }
                else { Invoke-Item -LiteralPath $status.mprPath }
            }
            # Same choice as openTerminal in launch.ts: Windows Terminal (`;` separates its commands), else this PowerShell with the user's profile.
            if (-not $NoLaunch -and $req.openTerminal -eq $true) {
                $wt = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Microsoft\WindowsApps\wt.exe'
                if (Test-Path -LiteralPath $wt) { Start-Process -FilePath $wt -ArgumentList '-d',(QuoteArg ($req.target -replace ';','\;')) }
                else { Start-Process -FilePath (Get-Process -Id $PID).Path -WorkingDirectory $req.target }
            }
        }
    }
    $status.state = 'completed'
    $exitCode = 0
    Log 'Operation completed.'
} catch {
    $message = SafeText $_.Exception.Message
    if ($script:status) {
        $status.error = $message
        $status.state = if ($message.StartsWith('CANCELLED:')) { 'cancelled' } elseif ($status.ready) { 'launch_failed' } else { 'failed' }
        Log $message
        Log "Existing project folders were preserved. Operation logs are kept in $($script:opDir)."
    } else { Write-Error $message -ErrorAction Continue }
} finally {
    # Closing the job kills any Git process that still has files open in the temporary folders.
    if ($script:job) { $job.Dispose() }
    if ($exitCode -ne 0 -and $script:status) {
        RemoveOwnedFolder $script:ownedStaging $req.projectsRoot
        RemoveOwnedFolder $script:ownedBuilding $req.cacheRoot
    }
    if ($script:cacheLock) { $cacheLock.Dispose() }
    if ($script:targetLock) { $targetLock.Dispose() }
    if ($script:status) { SaveStatus }
}
exit $exitCode
