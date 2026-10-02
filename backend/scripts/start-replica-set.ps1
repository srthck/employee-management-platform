<#
.SYNOPSIS
  Start a single-node MongoDB replica set for local development and tests.

.DESCRIPTION
  Payroll finalization is atomic only when MongoDB supports transactions,
  which requires a replica set. This starts a SEPARATE mongod (default port
  27018) with its own data directory, so an existing MongoDB service on
  27017 is left untouched. Safe to run repeatedly.

  Connection string printed at the end:
    mongodb://127.0.0.1:27018/employee_management?replicaSet=rs0

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/start-replica-set.ps1
  npm run test:replset
#>
param(
  [int]$Port = 27018,
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'PayGuard\mongo-rs'),
  [string]$MongodPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $MongodPath) {
  $command = Get-Command mongod -ErrorAction SilentlyContinue
  if ($command) {
    $MongodPath = $command.Source
  } else {
    $MongodPath = Get-ChildItem 'C:\Program Files\MongoDB\Server\*\bin\mongod.exe' -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
  }
}
if (-not $MongodPath -or -not (Test-Path $MongodPath)) {
  throw 'mongod.exe not found. Install MongoDB Server or pass -MongodPath.'
}

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $logPath = Join-Path $DataDir 'mongod.log'
  Start-Process -FilePath $MongodPath -WindowStyle Hidden -ArgumentList @(
    '--replSet', 'rs0', '--port', $Port, '--bind_ip', '127.0.0.1',
    '--dbpath', "`"$DataDir`"", '--logpath', "`"$logPath`"", '--logappend'
  )
  Write-Host "Started mongod on port $Port (data: $DataDir)"
} else {
  Write-Host "mongod already listening on port $Port"
}

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $state = mongosh --port $Port --quiet --eval "try { rs.status().ok } catch (e) { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:$Port' }] }).ok; 'initiated' }; db.hello().isWritablePrimary"
    if ($state -match 'true') { $ready = $true; break }
  } catch { }
  Start-Sleep -Seconds 1
}

if (-not $ready) { throw "Replica set on port $Port did not become primary. See $DataDir\mongod.log" }

Write-Host "Replica set ready: mongodb://127.0.0.1:$Port/employee_management?replicaSet=rs0"
