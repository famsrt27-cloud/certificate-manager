[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TargetDatabaseUrl,
  [Parameter(Mandatory = $true)][string]$DumpPath,
  [string]$PgRestoreCommand = "pg_restore"
)

$ErrorActionPreference = "Stop"
$target = [Uri]$TargetDatabaseUrl
if ([string]::IsNullOrWhiteSpace($target.Host) -or [string]::IsNullOrWhiteSpace($target.AbsolutePath.Trim('/'))) {
  throw "An explicit target database URL with host and database name is required."
}
if ($target.Host -match "(?i)(^|[.-])(prod|production)([.-]|$)" -or $target.AbsolutePath -match "(?i)(prod|production)") {
  throw "Restore target appears to be production; this tool refuses it."
}
if (-not (Test-Path -LiteralPath $DumpPath -PathType Leaf)) { throw "Dump file does not exist." }

# Intentionally no reset or create flags: target selection is explicit and must already be an empty isolated database.
& $PgRestoreCommand --exit-on-error --no-owner --no-privileges --dbname=$TargetDatabaseUrl $DumpPath
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed with exit code $LASTEXITCODE." }
Write-Output "PostgreSQL restore completed into the explicit non-production target."
