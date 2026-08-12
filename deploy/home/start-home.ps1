# Start the OMR service for HOME hosting (deploy/home/README.md): loads home.env from this
# directory into the environment, then runs the service in the foreground. Pair it with the
# cloudflared tunnel (its own scheduled task) to serve omr.<your-domain>.
#
# The service's own retention discipline (15-minute job TTL + the boot orphan wipe) is what
# keeps the home machine clean — uploads live only for the job's lifetime.
$ErrorActionPreference = 'Stop'
$homeDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$environmentFile = Join-Path $homeDirectory 'home.env'
if (-not (Test-Path $environmentFile)) {
  Write-Error "Missing $environmentFile - copy home.env.example and fill in this machine's values."
}
Get-Content $environmentFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith('#')) {
    $name, $value = $line -split '=', 2
    [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), 'Process')
  }
}
Set-Location (Resolve-Path (Join-Path $homeDirectory '..\..'))
npm start
