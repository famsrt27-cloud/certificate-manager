[CmdletBinding()]
param([string]$ArtifactDirectory = "restore-drill-artifacts")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$artifacts = [System.IO.Path]::GetFullPath((Join-Path $root $ArtifactDirectory))
[System.IO.Directory]::CreateDirectory($artifacts) | Out-Null
$compose = Join-Path $root "compose.restore-drill.yaml"; $project = "certificate-platform-restore-drill"
$manifest = Join-Path $artifacts "durable-object-manifest.json"; $dump = Join-Path $artifacts "postgres-source.dump"; $status = Join-Path $artifacts "restore-drill-status.json"
$sourceDb = "postgresql://restore_drill:restore-drill-local-only@127.0.0.1:55434/certificate_platform_restore_source"
$targetDb = "postgresql://restore_drill:restore-drill-local-only@127.0.0.1:55435/certificate_platform_restore_target"

function Invoke-Compose { param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args) & docker compose --project-name $project -f $compose @Args; if ($LASTEXITCODE -ne 0) { throw "Compose command failed." } }
try {
  Invoke-Compose up --detach --wait
  $env:DATABASE_URL = $sourceDb; & pnpm.cmd db:migrate; if ($LASTEXITCODE -ne 0) { throw "Source migration failed." }
  $env:RESTORE_DRILL_SOURCE_DATABASE_URL = $sourceDb; $env:RESTORE_DRILL_TARGET_DATABASE_URL = $targetDb; $env:RESTORE_DRILL_MANIFEST_PATH = $manifest
  $env:SOURCE_S3_ENDPOINT = "http://127.0.0.1:9004"; $env:SOURCE_S3_BUCKET = "restore-drill-private"; $env:SOURCE_S3_ACCESS_KEY = "restore-drill-source"; $env:SOURCE_S3_SECRET_KEY = "restore-drill-source-secret"
  $env:BACKUP_S3_ENDPOINT = "http://127.0.0.1:9005"; $env:BACKUP_S3_BUCKET = "restore-drill-private"; $env:BACKUP_S3_ACCESS_KEY = "restore-drill-backup"; $env:BACKUP_S3_SECRET_KEY = "restore-drill-backup-secret"
  & node --import tsx (Join-Path $root "ops/backup/restore-drill-seed.ts"); if ($LASTEXITCODE -ne 0) { throw "Source seed failed." }
  # minio-backup is the isolated durable-object recovery source after the primary source is stopped.
  & node (Join-Path $root "ops/backup/object-copy.mjs") --manifest $manifest --target-prefix BACKUP_S3 --create-target-bucket --status (Join-Path $artifacts "object-backup-status.json"); if ($LASTEXITCODE -ne 0) { throw "Object backup failed." }
  Invoke-Compose exec -T postgres-source sh -c "PGPASSWORD=restore-drill-local-only pg_dump -U restore_drill -d certificate_platform_restore_source -Fc -f /tmp/source.dump"
  $sourceContainer = (& docker compose --project-name $project -f $compose ps -q postgres-source).Trim(); & docker cp "${sourceContainer}:/tmp/source.dump" $dump; if ($LASTEXITCODE -ne 0) { throw "Database backup copy failed." }
  Invoke-Compose stop postgres-source minio-source
  $targetContainer = (& docker compose --project-name $project -f $compose ps -q postgres-restored).Trim(); & docker cp $dump "${targetContainer}:/tmp/source.dump"; if ($LASTEXITCODE -ne 0) { throw "Database restore copy failed." }
  Invoke-Compose exec -T postgres-restored sh -c "PGPASSWORD=restore-drill-local-only pg_restore --exit-on-error --no-owner --no-privileges -U restore_drill -d certificate_platform_restore_target /tmp/source.dump"
  $env:RESTORED_S3_ENDPOINT = "http://127.0.0.1:9006"; $env:RESTORED_S3_BUCKET = "restore-drill-private"; $env:RESTORED_S3_ACCESS_KEY = "restore-drill-target"; $env:RESTORED_S3_SECRET_KEY = "restore-drill-target-secret"
  # Re-copy from the isolated backup target, never from the unavailable original.
  $env:SOURCE_S3_ENDPOINT = $env:BACKUP_S3_ENDPOINT; $env:SOURCE_S3_BUCKET = $env:BACKUP_S3_BUCKET; $env:SOURCE_S3_ACCESS_KEY = $env:BACKUP_S3_ACCESS_KEY; $env:SOURCE_S3_SECRET_KEY = $env:BACKUP_S3_SECRET_KEY
  & node (Join-Path $root "ops/backup/object-copy.mjs") --manifest $manifest --target-prefix RESTORED_S3 --create-target-bucket; if ($LASTEXITCODE -ne 0) { throw "Object restore failed." }
  & node --import tsx (Join-Path $root "ops/backup/restore-drill-verify.ts"); if ($LASTEXITCODE -ne 0) { throw "Relational verification failed." }
  & node (Join-Path $root "ops/backup/object-verify.mjs") --manifest $manifest --prefix RESTORED_S3; if ($LASTEXITCODE -ne 0) { throw "Object verification failed." }
  @{ restore_drill = "success"; completed_at = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json -Compress | Set-Content -LiteralPath $status -NoNewline
  Write-Output "Isolated restore drill passed. Artifacts remain in the ignored directory until operator cleanup."
} catch {
  @{ restore_drill = "failure"; completed_at = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json -Compress | Set-Content -LiteralPath $status -NoNewline
  throw
} finally { Invoke-Compose down --volumes --remove-orphans }
