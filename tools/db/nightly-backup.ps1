# Nightly read-only backup of the live Supabase database (run by the Windows
# Task Scheduler task "seiGEN nightly DB backup"; see docs/database/backup-and-restore.md).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\db\nightly-backup.ps1
#
# - runs tools/db/live-backup.js --out C:\seigen-backups\supabase (outside the repo)
# - appends one line per run to C:\seigen-backups\backup.log
# - after a SUCCESSFUL run, keeps the newest 14 complete backups (folders with
#   manifest.json) and deletes older ones; after a failed run it deletes nothing
# - exits non-zero on failure
#
# No secrets here: live-backup.js reads SUPABASE_DB_URL from the repo's .env
# and never prints it. The backups themselves hold shops' secret phrases,
# device keys and passcode hashes: never upload or share them.

param(
  [string]$BackupRoot = 'C:\seigen-backups',
  [int]$Keep = 14
)

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dest = Join-Path $BackupRoot 'supabase'
$log = Join-Path $BackupRoot 'backup.log'

function Write-Log([string]$line) {
  Add-Content -Path $log -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz') + ' ' + $line) -Encoding UTF8
}

New-Item -ItemType Directory -Force $dest | Out-Null

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
  Write-Log 'FAILED node not found on PATH'
  exit 2
}

Push-Location $repo
try {
  $output = & $node.Source 'tools\db\live-backup.js' '--out' $dest 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}

$result = $null
if ($code -eq 0) {
  # the summary is the JSON block on stdout (stderr warnings, if any, are mixed in)
  $start = [array]::IndexOf([string[]]$output, '{')
  $end = [array]::LastIndexOf([string[]]$output, '}')
  if ($start -ge 0 -and $end -gt $start) {
    try { $result = ($output[$start..$end] -join "`n") | ConvertFrom-Json } catch { $result = $null }
  }
}
if ($code -ne 0 -or $null -eq $result -or -not (Test-Path (Join-Path $result.folder 'manifest.json'))) {
  $err = ($output | Where-Object { $_ -match 'ERROR' } | Select-Object -First 1)
  if (-not $err) { $err = ($output | Select-Object -Last 1) }
  Write-Log ("FAILED exit=$code " + $err + ' (nothing pruned)')
  exit 1
}

$complete = Get-ChildItem -Path $dest -Directory |
  Where-Object { Test-Path (Join-Path $_.FullName 'manifest.json') } |
  Sort-Object Name -Descending
$pruned = 0
foreach ($old in ($complete | Select-Object -Skip $Keep)) {
  Remove-Item -Recurse -Force -LiteralPath $old.FullName
  $pruned++
}

$bytes = (Get-ChildItem -Recurse -File -LiteralPath $result.folder | Measure-Object Length -Sum).Sum
Write-Log ('OK folder=' + $result.folder + ' size=' + [math]::Round($bytes / 1KB) + 'KB rows=' + $result.rows +
  ' kept=' + [math]::Min($complete.Count, $Keep) + ' pruned=' + $pruned)
exit 0
