<#
dsh-watch-together installer.

Two ways to install, both without editing DSH itself:

  -FromNpm     install the published packages as profile dependencies
  -FromFolder  link this local checkout into the profile (development)

Both modes register the packages with the profile and let each package's own
cordis.patch.yml mount itself on the next start. Nothing here writes into the
DSH installation.

  powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File install.ps1 -FromFolder
#>
param(
  [switch]$FromFolder,
  [switch]$FromNpm,
  [switch]$DryRun,
  [string]$Profile = 'desktop',
  [string]$Registry = 'https://registry.npmjs.org'
)

$ErrorActionPreference = 'Stop'
# The meta package is deliberately NOT in this list: its dependencies are
# "workspace:*", which only resolves inside the monorepo (pnpm publish rewrites
# them). Linked from a checkout it would send the package manager to the
# registry for six packages that are not there yet. Install the six directly.
$PACKAGES = @(
  'dsh-watch-eyes',
  'dsh-watch-ears',
  'dsh-watch-mouth',
  'dsh-watch-browser',
  'dsh-watch-hands',
  'dsh-watch-panel'
)
$HERE = Split-Path -Parent $PSCommandPath
$DSH_HOME = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$PROFILE_DIR = Join-Path (Join-Path $DSH_HOME 'profiles') $Profile

function Say($m) { Write-Host "[install] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[warn] $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "[error] $m" -ForegroundColor Red; exit 1 }

if (-not (Test-Path $PROFILE_DIR)) { Die "profile not found: $PROFILE_DIR (use -Profile web/desktop)" }
Say "profile: $PROFILE_DIR"

if (-not ($FromFolder -or $FromNpm)) { $FromFolder = $true }
if ($DryRun) { Say 'dry run: nothing will be written' }

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) { Warn 'dsh CLI not on PATH; falling back to node + pnpm inside the runtime' }

foreach ($p in $PACKAGES) {
  if ($FromNpm) {
    $spec = $p
    Say "npm install $spec"
    if (-not $DryRun) {
      & dsh plugin --profile $Profile add $spec
      if ($LASTEXITCODE -ne 0) { Die "failed: $p" }
    }
  } else {
    $src = Join-Path $HERE "packages\$p"
    if (-not (Test-Path $src)) { Die "missing local package: $src" }
    Say "link $src"
    if (-not $DryRun) {
      & dsh plugin --profile $Profile add "link:$src"
      if ($LASTEXITCODE -ne 0) { Die "failed: $p" }
    }
  }
}

Say 'done. restart DSH so the patches mount.'
