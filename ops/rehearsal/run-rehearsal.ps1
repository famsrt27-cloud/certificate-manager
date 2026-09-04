[CmdletBinding()]
param(
  [switch]$KeepSafeEvidence,
  [switch]$SkipImageBuild
)

# This script is deliberately local-only. It generates unique secrets and a local
# CA under ignored rehearsal-artifacts/, uses the real production targets, and
# writes no secret, URL, token, cookie, identifier, or PII to its status artifact.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$run = Join-Path $root ("rehearsal-artifacts/" + [Guid]::NewGuid().ToString("N"))
$project = "certificate-platform-rehearsal"
$statusPath = Join-Path $run "status.json"
$checks = [System.Collections.Generic.List[object]]::new()
$imageIds = [ordered]@{}

function Add-Check([string]$Name, [string]$Status, [string]$ReasonCode) {
  $checks.Add([ordered]@{ name = $Name; status = $Status; reason_code = $ReasonCode })
}
function Save-Status {
  [ordered]@{ schema_version = 1; rehearsal_timestamp = [DateTime]::UtcNow.ToString("o"); revision = (git -C $root rev-parse HEAD).Trim(); image_ids = $imageIds; checks = $checks } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $statusPath -NoNewline
}
function New-Secret([int]$Bytes) {
  $value = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($value) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($value).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}
function Invoke-Compose {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & docker compose --project-name $project --env-file (Join-Path $run "rehearsal.env") -f (Join-Path $root "compose.production.yaml") -f (Join-Path $root "compose.rehearsal.yaml") @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Compose command failed: $($Arguments -join ' ')" }
}

New-Item -ItemType Directory -Path $run -Force | Out-Null
try {
  & docker info | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "DOCKER_UNAVAILABLE" }

  $pgPassword = New-Secret 32; $redisPassword = New-Secret 32
  $storageRootPassword = New-Secret 32; $storageAppSecret = New-Secret 32
  $mfaKey = New-Secret 32; $signingKey = New-Secret 32; $historicalSigningKey = New-Secret 32; $sessionSecret = New-Secret 48
  $certDirectory = Join-Path $run "certs"; New-Item -ItemType Directory -Path $certDirectory -Force | Out-Null
  $extensions = Join-Path $run "tls.ext"
  @("subjectAltName=DNS:rehearsal.localhost,DNS:postgres,DNS:redis,DNS:storage,DNS:proxy,IP:127.0.0.1", "extendedKeyUsage=serverAuth") |
    Set-Content -LiteralPath $extensions
  $mount = "${run}:/work"
  & docker run --rm -v $mount alpine/openssl req -x509 -newkey rsa:2048 -nodes -keyout /work/ca.key -out /work/ca.crt -days 2 -subj /CN=certificate-platform-rehearsal-ca | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "LOCAL_CA_GENERATION_FAILED" }
  & docker run --rm -v $mount alpine/openssl req -newkey rsa:2048 -nodes -keyout /work/edge.key -out /work/edge.csr -subj /CN=rehearsal.localhost | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "LOCAL_CERTIFICATE_GENERATION_FAILED" }
  & docker run --rm -v $mount alpine/openssl x509 -req -in /work/edge.csr -CA /work/ca.crt -CAkey /work/ca.key -CAcreateserial -out /work/edge.crt -days 2 -extfile /work/tls.ext | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "LOCAL_CERTIFICATE_GENERATION_FAILED" }
  Copy-Item (Join-Path $run "edge.crt") (Join-Path $run "postgres.crt")
  Copy-Item (Join-Path $run "edge.key") (Join-Path $run "postgres.key")
  Copy-Item (Join-Path $run "edge.crt") (Join-Path $run "redis.crt")
  Copy-Item (Join-Path $run "edge.key") (Join-Path $run "redis.key")
  New-Item -ItemType Directory -Path (Join-Path $certDirectory "CAs") -Force | Out-Null
  Copy-Item (Join-Path $run "edge.crt") (Join-Path $certDirectory "public.crt")
  Copy-Item (Join-Path $run "edge.key") (Join-Path $certDirectory "private.key")
  Copy-Item (Join-Path $run "ca.crt") (Join-Path $certDirectory "CAs/ca.crt")
  # Docker Compose on Windows ignores secret uid/gid/mode. Keep the ignored
  # rehearsal edge key root-owned and narrowly group-readable for proxy GID 0.
  & docker run --rm --entrypoint /bin/sh -v $mount alpine/openssl -c "chmod 0640 /work/edge.key"
  if ($LASTEXITCODE -ne 0) { throw "REHEARSAL_EDGE_KEY_MODE_FAILED" }
  @("port 0", "tls-port 6379", "tls-cert-file /run/rehearsal/redis.crt", "tls-key-file /run/rehearsal/redis.key", "tls-ca-cert-file /run/rehearsal/ca.crt", "tls-auth-clients no", "requirepass $redisPassword", "appendonly yes") |
    Set-Content -LiteralPath (Join-Path $run "redis.conf")

  @(
    "NODE_ENV=production", "DATABASE_URL=postgresql://rehearsal_app:$pgPassword@postgres:5432/certificate_platform_rehearsal?sslmode=verify-full",
    "REDIS_URL=rediss://:$redisPassword@redis:6379/0", "OBJECT_STORAGE_ENDPOINT=https://storage:9000", "OBJECT_STORAGE_REGION=us-east-1", "OBJECT_STORAGE_FORCE_PATH_STYLE=true",
    "OBJECT_STORAGE_BUCKET=certificate-platform-rehearsal-private", "OBJECT_STORAGE_ACCESS_KEY=rehearsal-app", "OBJECT_STORAGE_SECRET_KEY=$storageAppSecret",
    "BULLMQ_PREFIX=certificate-platform-rehearsal", "VERIFICATION_PUBLIC_BASE_URL=https://rehearsal.localhost:18443",
    "VERIFICATION_ACTIVE_KID=rehearsal-current", "VERIFICATION_SIGNING_KEYS_JSON={`"rehearsal-current`":`"$signingKey`",`"rehearsal-historical`":`"$historicalSigningKey`"}",
    "SESSION_SECRET=$sessionSecret", "ADMIN_ALLOWED_ORIGINS=https://rehearsal.localhost:18443", "ADMIN_MFA_POLICY=REQUIRED", "ADMIN_MFA_ENCRYPTION_KEY=$mfaKey",
    "PRODUCTION_DEPENDENCY_NETWORK=certificate-platform-rehearsal-dependencies", "TLS_CERTIFICATE_SECRET_NAME=rehearsal-edge-certificate", "TLS_PRIVATE_KEY_SECRET_NAME=rehearsal-edge-private-key", "REHEARSAL_POSTGRES_DATABASE=certificate_platform_rehearsal", "REHEARSAL_POSTGRES_USER=rehearsal_app", "REHEARSAL_POSTGRES_PASSWORD=$pgPassword",
    "REHEARSAL_REDIS_PASSWORD=$redisPassword", "REHEARSAL_STORAGE_ROOT_USER=rehearsal-root", "REHEARSAL_STORAGE_ROOT_PASSWORD=$storageRootPassword",
    "REHEARSAL_CA_FILE=$($run.Replace('\','/'))/ca.crt", "REHEARSAL_EDGE_CERT_FILE=$($run.Replace('\','/'))/edge.crt", "REHEARSAL_EDGE_KEY_FILE=$($run.Replace('\','/'))/edge.key",
    "REHEARSAL_POSTGRES_CERT_FILE=$($run.Replace('\','/'))/postgres.crt", "REHEARSAL_POSTGRES_KEY_FILE=$($run.Replace('\','/'))/postgres.key", "REHEARSAL_REDIS_CONFIG_FILE=$($run.Replace('\','/'))/redis.conf",
    "REHEARSAL_REDIS_CERT_FILE=$($run.Replace('\','/'))/redis.crt", "REHEARSAL_REDIS_KEY_FILE=$($run.Replace('\','/'))/redis.key", "REHEARSAL_STORAGE_CERT_DIRECTORY=$($certDirectory.Replace('\','/'))"
  ) | Set-Content -LiteralPath (Join-Path $run "rehearsal.env")

  Invoke-Compose config | Out-Null; Add-Check "compose_configuration" "PASS" "PRODUCTION_OVERRIDE_VALIDATED"
  if (-not $SkipImageBuild) {
    Invoke-Compose build web api worker migrate
    foreach ($service in @("web", "api", "worker", "migrate")) {
      $imageId = ([string](& docker compose --project-name $project --env-file (Join-Path $run "rehearsal.env") -f (Join-Path $root "compose.production.yaml") -f (Join-Path $root "compose.rehearsal.yaml") images -q $service)).Trim()
      if ([string]::IsNullOrWhiteSpace($imageId)) { throw "MISSING_PRODUCTION_IMAGE_ID" }
      $imageIds[$service] = $imageId
    }
    Add-Check "production_images" "PASS" "PRODUCTION_TARGETS_BUILT"
  } else {
    # -SkipImageBuild is permitted only for the sealed images supplied to this
    # rehearsal.  Observe that every production target is present before relying
    # on it; this is evidence of reuse, not a manufactured skipped-stage PASS.
    foreach ($service in @("web", "api", "worker", "migrate")) {
      $imageName = "certificate-platform-rehearsal-$service"
      $imageId = ([string](& docker image inspect --format '{{.Id}}' $imageName 2>$null)).Trim()
      if ([string]::IsNullOrWhiteSpace($imageId)) { throw "MISSING_SEALED_PRODUCTION_IMAGE" }
      $imageIds[$service] = $imageId
    }
    Add-Check "production_images" "PASS" "SEALED_IMAGE_REUSE_OBSERVED"
  }
  Invoke-Compose up --detach --wait postgres redis storage
  Invoke-Compose up --detach storage-bootstrap
  Invoke-Compose wait storage-bootstrap
  Invoke-Compose up --detach --wait api
  $beforeMigration = (Invoke-Compose exec -T postgres psql -U rehearsal_app -d certificate_platform_rehearsal -tAc "select count(*) from pg_catalog.pg_tables where schemaname = 'public' and tablename = 'pgmigrations';").Trim()
  if ($beforeMigration -ne "0") { throw "APPLICATION_RAN_MIGRATIONS_AUTOMATICALLY" }
  Invoke-Compose stop api
  Invoke-Compose run --rm migrate; Add-Check "migration_first_run" "PASS" "EXPLICIT_MIGRATION_SUCCEEDED"
  $migrationCount = (Invoke-Compose exec -T postgres psql -U rehearsal_app -d certificate_platform_rehearsal -tAc "select count(*) from pgmigrations;").Trim()
  if ([int]$migrationCount -lt 1) { throw "MIGRATION_SCHEMA_STATE_ABSENT" }
  Invoke-Compose run --rm migrate; Add-Check "migration_idempotency" "PASS" "EXPLICIT_MIGRATION_RERUN_SUCCEEDED"

  Invoke-Compose -Arguments @("exec", "-T", "-d", "postgres", "psql", "-U", "rehearsal_app", "-d", "certificate_platform_rehearsal", "-c", "select pg_advisory_lock(7241865325823964); select pg_sleep(15);") | Out-Null
  $lockHeld = $false
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    $lockState = (Invoke-Compose -Arguments @("exec", "-T", "postgres", "psql", "-U", "rehearsal_app", "-d", "certificate_platform_rehearsal", "-tAc", "select case when pg_try_advisory_lock(7241865325823964) then 'UNLOCKED' else 'LOCKED' end;")).Trim()
    if ($lockState -eq "LOCKED") { $lockHeld = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $lockHeld) { throw "MIGRATION_ADVISORY_LOCK_HOLDER_NOT_OBSERVED" }
  & docker compose --project-name $project --env-file (Join-Path $run "rehearsal.env") -f (Join-Path $root "compose.production.yaml") -f (Join-Path $root "compose.rehearsal.yaml") run --rm migrate | Out-Null
  if ($LASTEXITCODE -eq 0) { throw "MIGRATION_ADVISORY_LOCK_NOT_ENFORCED" }
  Add-Check "migration_advisory_lock" "PASS" "ADVISORY_LOCK_FAILED_VISIBLE"

  # The proxy is only started after migrations have completed.  Exercise the
  # actual TLS edge, rather than inferring it from Compose configuration.
  Invoke-Compose up --detach --wait web api worker proxy
  $httpsStatus = (& curl.exe --silent --show-error --ssl-no-revoke --output NUL --write-out "%{http_code}" --cacert (Join-Path $run "ca.crt") "https://rehearsal.localhost:18443/").Trim()
  if ($httpsStatus -ne "200") { throw "HTTPS_EDGE_UNEXPECTED_STATUS" }
  $httpStatus = (& curl.exe --silent --show-error --output NUL --write-out "%{http_code}" "http://rehearsal.localhost:18080/").Trim()
  if ($httpStatus -ne "308") { throw "HTTP_TO_HTTPS_REDIRECT_UNEXPECTED_STATUS" }
  $sameSiteApiStatus = (& curl.exe --silent --show-error --ssl-no-revoke --output NUL --write-out "%{http_code}" --request POST --header "Content-Type: application/json" --data "{}" --cacert (Join-Path $run "ca.crt") "https://rehearsal.localhost:18443/api/public/verify").Trim()
  if ($sameSiteApiStatus -ne "400") { throw "SAME_SITE_API_PROXY_UNEXPECTED_STATUS" }
  Add-Check "https_edge" "PASS" "HTTPS_AND_SAME_SITE_API_OBSERVED"

  # The remaining rows are intentionally BLOCKED until their discrete smoke/failure
  # commands have been run and recorded by an operator. They cannot turn PASS from
  # documentation or from this scaffold alone.
  foreach ($name in @("private_operator_boundary", "security_configuration", "restored_data_runtime", "postgres_failure", "redis_failure", "storage_failure", "worker_queue_recovery", "rollback_forward_recovery", "key_lifecycle")) {
    Add-Check $name "BLOCKED" "OPERATOR_EXERCISE_NOT_RECORDED"
  }
} catch {
  if ($checks.Count -eq 0) { Add-Check "compose_configuration" "BLOCKED" "DOCKER_OR_LOCAL_CA_UNAVAILABLE" }
  foreach ($name in @("production_images", "migration_first_run", "migration_idempotency", "migration_advisory_lock", "https_edge", "private_operator_boundary", "security_configuration", "restored_data_runtime", "postgres_failure", "redis_failure", "storage_failure", "worker_queue_recovery", "rollback_forward_recovery", "key_lifecycle")) {
    if (-not ($checks | Where-Object { $_.name -eq $name })) { Add-Check $name "BLOCKED" "REHEARSAL_ABORTED" }
  }
  Write-Warning "Rehearsal did not complete: $($_.Exception.Message)"
} finally {
  Save-Status
  & node (Join-Path $root "ops/rehearsal/completion-gate.mjs") $statusPath
  $gateExit = $LASTEXITCODE
  if (Test-Path -LiteralPath (Join-Path $run "rehearsal.env")) {
    & docker compose --project-name $project --env-file (Join-Path $run "rehearsal.env") -f (Join-Path $root "compose.production.yaml") -f (Join-Path $root "compose.rehearsal.yaml") down --volumes --remove-orphans 2>$null
  }
  if (-not $KeepSafeEvidence) { Remove-Item -LiteralPath $run -Recurse -Force -ErrorAction SilentlyContinue }
  exit $gateExit
}
