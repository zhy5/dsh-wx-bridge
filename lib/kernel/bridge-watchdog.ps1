$ErrorActionPreference = 'Continue'
$root = 'D:\DSH\.scratch\weixin-bridge'
$log = Join-Path $root 'watchdog.log'
$lock = Join-Path $root 'bridge.lock'
$hb = Join-Path $root 'heartbeat.txt'
$out = Join-Path $root 'stdout.log'

function Log($m) {
  try { Add-Content -Path $log -Value ((Get-Date).ToString('s') + ' ' + $m) } catch {}
}

# 1) collect live bridge processes (command line must mention weixin-bridge)
$live = @()
try {
  $live = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*bridge.mjs*' })
} catch {}

# 2) heartbeat freshness
$fresh = $false
$ageMin = -1
if (Test-Path $hb) {
  $ageMin = [math]::Round((New-TimeSpan -Start (Get-Item $hb).LastWriteTime -End (Get-Date)).TotalMinutes, 2)
  if ($ageMin -lt 5) { $fresh = $true }
}

$count = $live.Count

if ($count -eq 1 -and $fresh) {
  Log ("OK pid=" + $live[0].ProcessId + " age=" + $ageMin + "m")
  exit 0
}

Log ("UNHEALTHY procs=" + $count + " fresh=" + $fresh + " age=" + $ageMin + "m")

# 3) clean up: kill every bridge process, then remove the lock
foreach ($p in $live) {
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Log ("killed pid=" + $p.ProcessId) } catch {}
}
Start-Sleep -Seconds 2
try { Remove-Item $lock -ErrorAction SilentlyContinue } catch {}

# 4) restart detached (escapes this process tree so it survives)
$cmd = 'cmd.exe /c "cd /d D:\DSH && node .scratch\weixin-bridge\bridge.mjs >> .scratch\weixin-bridge\stdout.log 2>&1"'
try {
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
  Log ("restart rc=" + $r.ReturnValue + " pid=" + $r.ProcessId)
} catch {
  Log ("restart FAILED: " + $_.Exception.Message)
  try { Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'cd /d D:\DSH && node .scratch\weixin-bridge\bridge.mjs >> .scratch\weixin-bridge\stdout.log 2>&1' -WindowStyle Hidden } catch {}
}

# 5) verify
Start-Sleep -Seconds 12
$after = @()
try {
  $after = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*bridge.mjs*' })
} catch {}
$hbAfter = Test-Path $hb
Log ("verify procs=" + $after.Count + " heartbeatFile=" + $hbAfter)
