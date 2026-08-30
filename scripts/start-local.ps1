[CmdletBinding()]
param(
    [switch]$NoOpen,
    [switch]$ExitAfterReady
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$logRoot = Join-Path $repoRoot ".local\logs"
$webUrl = "http://localhost:3100/admin/participants"
$envPath = Join-Path $repoRoot ".env"

function Get-ConfiguredPort {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][int]$Default
    )

    $rawValue = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrWhiteSpace($rawValue) -and (Test-Path -LiteralPath $envPath)) {
        $escapedName = [regex]::Escape($Name)
        $line = Get-Content -LiteralPath $envPath |
            Where-Object { $_ -match "^\s*$escapedName\s*=" } |
            Select-Object -Last 1
        if ($null -ne $line) {
            $rawValue = ($line -split "=", 2)[1].Trim().Trim('"').Trim("'")
        }
    }

    if ([string]::IsNullOrWhiteSpace($rawValue)) {
        return $Default
    }

    $port = 0
    if (-not [int]::TryParse($rawValue, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        throw "$Name must be a valid TCP port."
    }
    return $port
}

$apiPort = Get-ConfiguredPort -Name "API_PORT" -Default 3001
$workerPort = Get-ConfiguredPort -Name "WORKER_HEALTH_PORT" -Default 3002
$services = @(
    [pscustomobject]@{
        Name = "Web"
        Port = 3100
        HealthUrl = "http://127.0.0.1:3100/admin/participants"
        Command = "pnpm.cmd --filter @certificate-platform/web dev:e2e"
    },
    [pscustomobject]@{
        Name = "API"
        Port = $apiPort
        HealthUrl = "http://127.0.0.1:$apiPort/health/ready"
        Command = "pnpm.cmd --filter @certificate-platform/api dev"
    },
    [pscustomobject]@{
        Name = "Worker"
        Port = $workerPort
        HealthUrl = "http://127.0.0.1:$workerPort/health/ready"
        Command = "pnpm.cmd --filter @certificate-platform/worker dev"
    }
)
$startedProcesses = [System.Collections.Generic.List[object]]::new()
$stopping = $false

function Write-Step {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$FailureMessage
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage (exit code $LASTEXITCODE)"
    }
}

function Test-HttpReady {
    param([Parameter(Mandatory)][string]$Uri)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 3
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
    }
    catch {
        return $false
    }
}

function Test-WebApiProxyReady {
    $uri = "http://127.0.0.1:3100/api/admin/auth/session"
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 3
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    }
    catch {
        if ($null -ne $_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
            return $statusCode -ge 400 -and $statusCode -lt 500
        }
        return $false
    }
}

function Test-LocalPortInUse {
    param([Parameter(Mandatory)][int]$Port)

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    return $null -ne $listener
}

function Test-AllServicesReady {
    foreach ($service in $services) {
        if (-not (Test-HttpReady -Uri $service.HealthUrl)) {
            return $false
        }
    }
    return Test-WebApiProxyReady
}

function Open-TestPage {
    if (-not $NoOpen) {
        Write-Host "Opening $webUrl" -ForegroundColor Green
        Start-Process -FilePath $webUrl
    }
}

function Wait-ForDocker {
    param(
        [Parameter(Mandatory)][string]$DockerPath,
        [int]$TimeoutSeconds = 120
    )

    & $DockerPath info *> $null
    if ($LASTEXITCODE -eq 0) {
        return
    }

    $dockerDesktopPath = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (-not (Test-Path -LiteralPath $dockerDesktopPath)) {
        throw "Docker is not ready and Docker Desktop was not found at its standard location. Start Docker, then run start-local.cmd again."
    }

    Write-Host "Docker is not ready. Starting Docker Desktop..." -ForegroundColor Yellow
    Start-Process -FilePath $dockerDesktopPath -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Seconds 3
        & $DockerPath info *> $null
        if ($LASTEXITCODE -eq 0) {
            return
        }
    } while ((Get-Date) -lt $deadline)

    throw "Docker did not become ready within $TimeoutSeconds seconds."
}

function Start-LocalService {
    param(
        [Parameter(Mandatory)]$Service,
        [Parameter(Mandatory)][string]$RunLogRoot
    )

    $safeName = $Service.Name.ToLowerInvariant()
    $stdoutPath = Join-Path $RunLogRoot "$safeName.out.log"
    $stderrPath = Join-Path $RunLogRoot "$safeName.err.log"
    $process = Start-Process `
        -FilePath $env:ComSpec `
        -ArgumentList @("/d", "/c", $Service.Command) `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru

    $record = [pscustomobject]@{
        Name = $Service.Name
        Process = $process
        StdoutPath = $stdoutPath
        StderrPath = $stderrPath
    }
    $startedProcesses.Add($record)
    Write-Host "Started $($Service.Name) (PID $($process.Id))" -ForegroundColor DarkGray
}

function Show-RecentLogs {
    foreach ($record in $startedProcesses) {
        foreach ($path in @($record.StdoutPath, $record.StderrPath)) {
            if (Test-Path -LiteralPath $path) {
                Write-Host "`n--- $path ---" -ForegroundColor Yellow
                Get-Content -LiteralPath $path -Tail 30 -ErrorAction SilentlyContinue
            }
        }
    }
}

function Stop-StartedServices {
    if ($stopping) {
        return
    }
    $script:stopping = $true

    if ($startedProcesses.Count -eq 0) {
        return
    }

    Write-Host "`nStopping services started by this launcher..." -ForegroundColor Yellow
    $recordsToStop = $startedProcesses.ToArray()
    [array]::Reverse($recordsToStop)
    foreach ($record in $recordsToStop) {
        if (-not $record.Process.HasExited) {
            & taskkill.exe /PID $record.Process.Id /T /F *> $null
        }
    }
}

Set-Location -LiteralPath $repoRoot
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

try {
    Write-Step "Checking local services"
    if (Test-AllServicesReady) {
        Write-Host "Web, API, and Worker are already ready. No duplicate processes were started." -ForegroundColor Green
        Open-TestPage
        exit 0
    }

    $occupiedServices = @($services | Where-Object { Test-LocalPortInUse -Port $_.Port })
    if ($occupiedServices.Count -gt 0) {
        $occupiedSummary = ($occupiedServices | ForEach-Object { "$($_.Name):$($_.Port)" }) -join ", "
        throw "Required ports are already in use but the full stack is not healthy: $occupiedSummary. The launcher will not stop unknown processes."
    }

    $pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $pnpmCommand) {
        throw "pnpm.cmd was not found. Install the repository's approved pnpm version, then try again."
    }
    $dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
    if ($null -eq $dockerCommand) {
        $dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
    }
    if ($null -eq $dockerCommand) {
        throw "Docker was not found. Install Docker Desktop, then try again."
    }
    if (-not (Test-Path -LiteralPath $envPath)) {
        throw "The local .env file is missing. Create it from .env.example and configure local-only values before starting the stack."
    }

    Write-Step "Starting Docker infrastructure"
    Wait-ForDocker -DockerPath $dockerCommand.Source
    Invoke-CheckedCommand `
        -FilePath $dockerCommand.Source `
        -Arguments @("compose", "up", "-d", "--wait", "postgres", "redis", "minio") `
        -FailureMessage "Docker infrastructure could not be started"

    Write-Step "Installing locked dependencies"
    Invoke-CheckedCommand `
        -FilePath $pnpmCommand.Source `
        -Arguments @("install", "--frozen-lockfile") `
        -FailureMessage "Dependency installation failed"

    Write-Step "Applying database migrations"
    Invoke-CheckedCommand `
        -FilePath $pnpmCommand.Source `
        -Arguments @("db:migrate") `
        -FailureMessage "Database migration failed"

    $runStamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $runLogRoot = Join-Path $logRoot $runStamp
    New-Item -ItemType Directory -Path $runLogRoot -Force | Out-Null

    Write-Step "Starting Web, API, and Worker"
    $previousApiInternalBaseUrl = [Environment]::GetEnvironmentVariable("API_INTERNAL_BASE_URL", "Process")
    [Environment]::SetEnvironmentVariable("API_INTERNAL_BASE_URL", "http://127.0.0.1:$apiPort", "Process")
    try {
        foreach ($service in $services) {
            Start-LocalService -Service $service -RunLogRoot $runLogRoot
        }
    }
    finally {
        [Environment]::SetEnvironmentVariable("API_INTERNAL_BASE_URL", $previousApiInternalBaseUrl, "Process")
    }

    Write-Step "Waiting for application readiness"
    $readyDeadline = (Get-Date).AddSeconds(120)
    do {
        foreach ($record in $startedProcesses) {
            if ($record.Process.HasExited) {
                Show-RecentLogs
                throw "$($record.Name) stopped before the application became ready."
            }
        }

        if (Test-AllServicesReady) {
            Write-Host "The local stack is ready." -ForegroundColor Green
            Write-Host "Test page: $webUrl" -ForegroundColor Green
            Write-Host "Logs: $runLogRoot" -ForegroundColor DarkGray
            Open-TestPage

            if ($ExitAfterReady) {
                Stop-StartedServices
                exit 0
            }

            Write-Host "`nKeep this window open while testing. Press Ctrl+C to stop Web, API, and Worker." -ForegroundColor White
            while ($true) {
                Start-Sleep -Seconds 2
                foreach ($record in $startedProcesses) {
                    if ($record.Process.HasExited) {
                        Show-RecentLogs
                        throw "$($record.Name) stopped unexpectedly."
                    }
                }
            }
        }

        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $readyDeadline)

    Show-RecentLogs
    throw "The application did not become ready within 120 seconds."
}
catch {
    Write-Host "`nERROR: $($_.Exception.Message)" -ForegroundColor Red
    Stop-StartedServices
    exit 1
}
finally {
    Stop-StartedServices
}
