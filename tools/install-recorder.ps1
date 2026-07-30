# Registers the Option Clock OI recorder as a Windows scheduled task, so the PCR trend
# records itself without anyone starting the app.
#
# The task starts at logon and restarts itself if it ever exits, so the recorder is
# running whenever the machine is. It needs no administrator rights — it runs as you.
#
# The recorder idles outside 09:15-15:30 IST, Mon-Fri, so leaving it running costs
# nothing on evenings and weekends.
#
#   Install:    powershell -ExecutionPolicy Bypass -File .\tools\install-recorder.ps1
#   Start now:  Start-ScheduledTask   -TaskName 'TradeFinder OI Recorder'
#   Check:      Get-ScheduledTask     -TaskName 'TradeFinder OI Recorder'
#   Logs:       Get-Content .\recorder.log -Tail 20
#   Remove:     Unregister-ScheduledTask -TaskName 'TradeFinder OI Recorder' -Confirm:$false

$ErrorActionPreference = 'Stop'

$taskName = 'TradeFinder OI Recorder'
$apiDir = Split-Path -Parent $PSScriptRoot
$log = Join-Path $apiDir 'recorder.log'

if (-not (Test-Path (Join-Path $apiDir 'package.json'))) {
    throw "Expected the api package at $apiDir - run this script from api\tools."
}

# cmd.exe rather than npm directly: it gives us the working directory and the append
# redirect in one action, which a scheduled task can't express on its own.
$argument = "/c cd /d `"$apiDir`" && npm run record >> `"$log`" 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $argument

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# ExecutionTimeLimit zero = never time it out; this is meant to run all day. StartWhenAvailable
# catches the case where the machine was asleep at the trigger time.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Records NSE option-chain open interest every 5 minutes during market hours, for Option Clock''s PCR trend.' `
    -Force | Out-Null

Write-Host ""
Write-Host "Registered '$taskName' - starts at logon, logs to $log"
Write-Host ""
Write-Host "Start it now:  Start-ScheduledTask -TaskName '$taskName'"
Write-Host "Remove it:     Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
Write-Host ""
