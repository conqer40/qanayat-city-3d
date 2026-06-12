$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$job = Start-Job -ScriptBlock {
  Set-Location $using:PSScriptRoot
  node server.js
}

try {
  while ($true) {
    Receive-Job $job
    if ($job.State -ne 'Running') {
      Receive-Job $job
      Write-Host ''
      Write-Host 'Server stopped. Press any key to close this window.'
      $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
      exit 1
    }
    Start-Sleep -Milliseconds 500
  }
}
finally {
  if ($job.State -eq 'Running') {
    Stop-Job $job
  }
  Remove-Job $job -Force
}
