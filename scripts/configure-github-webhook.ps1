param(
  [Parameter(Mandatory = $true)]
  [string]$Repo,

  [Parameter(Mandatory = $false)]
  [string]$CallbackUrl = "",

  [Parameter(Mandatory = $false)]
  [string[]]$Events = @("push"),

  [Parameter(Mandatory = $false)]
  [string]$EnvFile = "RepoCop/.env"
)

$ErrorActionPreference = "Stop"

function Load-EnvFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  Get-Content $Path | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    $parts = $_.Split('=', 2)
    if ($parts.Count -ne 2) { return }
    $key = $parts[0].Trim()
    $val = $parts[1].Trim()
    [Environment]::SetEnvironmentVariable($key, $val)
  }
}

Load-EnvFile -Path $EnvFile

$token = [Environment]::GetEnvironmentVariable("GITHUB_TOKEN")
if ([string]::IsNullOrWhiteSpace($token)) {
  throw "GITHUB_TOKEN is missing. Set it in $EnvFile or the shell environment."
}

if ([string]::IsNullOrWhiteSpace($CallbackUrl)) {
  $base = [Environment]::GetEnvironmentVariable("N8N_WEBHOOK_BASE_URL")
  if (-not [string]::IsNullOrWhiteSpace($base)) {
    $base = $base.TrimEnd("/")
    $CallbackUrl = "$base/webhook/github-repo-review-auto"
  } else {
    $CallbackUrl = "http://localhost:5678/webhook/github-repo-review-auto"
  }
}

$headers = @{
  Authorization         = "Bearer $token"
  Accept                = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent"          = "codex-n8n-setup"
}

$secret = [Environment]::GetEnvironmentVariable("GITHUB_WEBHOOK_SECRET")
$config = @{
  url          = $CallbackUrl
  content_type = "json"
  insecure_ssl = "1"
}
if (-not [string]::IsNullOrWhiteSpace($secret)) {
  $config.secret = $secret
}

$events = $Events

try {
  $hooks = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/hooks?per_page=100" -Headers $headers -Method GET -TimeoutSec 30
} catch {
  throw "Cannot read hooks for $Repo. Token likely lacks webhook admin permissions on this repo. Error: $($_.Exception.Message)"
}

$existing = $hooks | Where-Object { $_.config.url -eq $CallbackUrl } | Select-Object -First 1

if ($existing) {
  $payload = @{
    config = $config
    events = $events
    active = $true
  }
  $updated = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/hooks/$($existing.id)" -Headers $headers -Method PATCH -Body ($payload | ConvertTo-Json -Depth 10) -ContentType "application/json" -TimeoutSec 30
  Write-Output "Updated webhook id=$($updated.id) repo=$Repo"
  Write-Output "URL=$($updated.config.url)"
  Write-Output "Events=$([string]::Join(',', $updated.events))"
  Write-Output "Active=$($updated.active)"
} else {
  $payload = @{
    name   = "web"
    config = $config
    events = $events
    active = $true
  }
  $created = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/hooks" -Headers $headers -Method POST -Body ($payload | ConvertTo-Json -Depth 10) -ContentType "application/json" -TimeoutSec 30
  Write-Output "Created webhook id=$($created.id) repo=$Repo"
  Write-Output "URL=$($created.config.url)"
  Write-Output "Events=$([string]::Join(',', $created.events))"
  Write-Output "Active=$($created.active)"
}
