[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceDatabaseUrl,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [string]$PgDumpCommand = "pg_dump"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($SourceDatabaseUrl)) { throw "A source database URL is required." }
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { throw "An operator-controlled output directory is required." }

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null
$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$dumpPath = Join-Path $resolvedOutput "postgres-$timestamp.dump"
$statusPath = Join-Path $resolvedOutput "backup-status.json"

try {
  # Custom format is portable to PostgreSQL 16 pg_restore and does not expose the URL in output.
  & $PgDumpCommand --format=custom --no-owner --no-privileges --file=$dumpPath --dbname=$SourceDatabaseUrl
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE." }
  $size = (Get-Item -LiteralPath $dumpPath).Length
  @{ database_backup = "success"; completed_at = [DateTime]::UtcNow.ToString("o"); size_bytes = $size } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $statusPath -NoNewline
  Write-Output "PostgreSQL backup completed: $timestamp ($size bytes)"
} catch {
  Remove-Item -LiteralPath $dumpPath -Force -ErrorAction SilentlyContinue
  @{ database_backup = "failure"; completed_at = [DateTime]::UtcNow.ToString("o") } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $statusPath -NoNewline
  throw
}
