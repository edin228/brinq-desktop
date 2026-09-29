# Installs the built Windows installer on a CI runner and checks that Brinq
# never owns the .msg/.eml defaults or mailto:, which Outlook and AMS360 rely
# on. The upgrade starts from 1.2.8, the last release that took the defaults.
param(
  [Parameter(Mandatory)] [string] $Installer,
  [Parameter(Mandatory)] [string] $PreviousInstaller
)
$ErrorActionPreference = 'Stop'

$Classes = 'HKLM:\Software\Classes'
$AppDir = 'C:\Program Files\Brinq'
$AppExe = Join-Path $AppDir 'Brinq.exe'
$BrinqCommand = "`"$AppExe`" `"%1`""
$OutlookClass = @{ msg = 'Outlook.File.msg.15'; eml = 'Outlook.File.eml.15' }
$OldBrinqClass = @{ msg = 'Outlook Message'; eml = 'Email Message' }
$MailtoCommand = 'HKCU:\Software\Classes\mailto\shell\open\command'

function Fail($message) { throw "Installer registry check failed: $message" }

function Get-Default($path) {
  if (-not (Test-Path $path)) { return $null }
  (Get-Item $path).GetValue('')
}

function Set-Default($path, $value) {
  if (-not (Test-Path $path)) { New-Item $path -Force | Out-Null }
  Set-Item $path -Value $value
}

function Install($exe) {
  $process = Start-Process (Resolve-Path $exe) -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) { Fail "$exe exited with code $($process.ExitCode)" }
}

function Stop-Brinq {
  Get-Process Brinq -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
}

function Wait-Until($seconds, [scriptblock] $condition) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $condition) { return $true }
    Start-Sleep -Seconds 1
  }
  return [bool](& $condition)
}

function Assert-OutlookDefaults($stage) {
  foreach ($ext in 'msg', 'eml') {
    $key = "$Classes\.$ext"
    $actual = Get-Default $key
    if ($actual -ne $OutlookClass[$ext]) { Fail "${stage}: .$ext default is '$actual', expected '$($OutlookClass[$ext])'" }
    if ($null -ne (Get-Item $key).GetValue("$($OldBrinqClass[$ext])_backup")) { Fail "${stage}: .$ext still has the 1.2.8 backup value" }
    if (Test-Path "$Classes\$($OldBrinqClass[$ext])") { Fail "${stage}: the 1.2.8 '$($OldBrinqClass[$ext])' class still exists" }
  }
}

function Assert-OpenWith($stage) {
  $command = Get-Default "$Classes\Brinq.EmailFile\shell\open\command"
  if ($command -ne $BrinqCommand) { Fail "${stage}: Brinq.EmailFile command is '$command', expected '$BrinqCommand'" }
  foreach ($ext in 'msg', 'eml') {
    $openWith = Get-Item "$Classes\.$ext\OpenWithProgids" -ErrorAction SilentlyContinue
    if ($null -eq $openWith -or $openWith.GetValueNames() -notcontains 'Brinq.EmailFile') { Fail "${stage}: Brinq is not listed under Open with for .$ext" }
  }
}

# Baseline: Outlook owns both types, then 1.2.8 takes them over.
foreach ($ext in 'msg', 'eml') { Set-Default "$Classes\.$ext" $OutlookClass[$ext] }
Install $PreviousInstaller
if ((Get-Default "$Classes\.msg") -ne 'Outlook Message') { Fail 'baseline: 1.2.8 did not take the .msg default, so the upgrade check would prove nothing' }
Write-Host 'Baseline: 1.2.8 made Brinq the .msg default.'

# Upgrade: the old uninstaller restores Outlook and the new build only adds Open with.
Install $Installer
Assert-OutlookDefaults 'upgrade from 1.2.8'
Assert-OpenWith 'upgrade from 1.2.8'
Write-Host 'Upgrade: Outlook owns .msg/.eml and Brinq is listed under Open with.'

# Repair: a machine where the 1.2.8 takeover survived without its uninstaller.
foreach ($ext in 'msg', 'eml') {
  $old = $OldBrinqClass[$ext]
  Set-Default "$Classes\.$ext" $old
  Set-ItemProperty "$Classes\.$ext" -Name "${old}_backup" -Value $OutlookClass[$ext]
  Set-Default "$Classes\$old\shell\open" 'Open with Brinq'
}
Install $Installer
Assert-OutlookDefaults 'repair of a leftover 1.2.8 takeover'
Assert-OpenWith 'repair of a leftover 1.2.8 takeover'
Write-Host 'Repair: leftover 1.2.8 defaults were restored to Outlook.'

# mailto cleanup: a pre-1.2.4 claim is removed when Brinq starts.
Stop-Brinq
Set-Default $MailtoCommand $BrinqCommand
Start-Process $AppExe
$removed = Wait-Until 60 { -not (Test-Path $MailtoCommand) }
Stop-Brinq
if (-not $removed) { Fail "mailto: Brinq did not remove its own mailto handler within 60 seconds" }
Write-Host 'mailto: a leftover Brinq handler was removed on startup.'

# mailto cleanup must leave another handler alone. This can only miss a change,
# never report a false one, so a fixed wait is enough.
$outlookMailto = '"C:\Program Files\Microsoft Office\Root\Office16\OUTLOOK.EXE" -c IPM.Note /mailto "%1"'
Set-Default $MailtoCommand $outlookMailto
Start-Process $AppExe
Start-Sleep -Seconds 20
Stop-Brinq
if ((Get-Default $MailtoCommand) -ne $outlookMailto) { Fail 'mailto: Brinq changed a mailto handler that was not its own' }
Write-Host 'mailto: an Outlook handler was left unchanged.'

# Uninstall removes only Brinq's Open with registration.
Start-Process "$AppDir\Uninstall Brinq.exe" -ArgumentList '/S' -Wait
if (-not (Wait-Until 120 { -not (Test-Path "$Classes\Brinq.EmailFile") })) { Fail 'uninstall: Brinq.EmailFile was not removed within 120 seconds' }
foreach ($ext in 'msg', 'eml') {
  $openWith = Get-Item "$Classes\.$ext\OpenWithProgids" -ErrorAction SilentlyContinue
  if ($null -ne $openWith -and $openWith.GetValueNames() -contains 'Brinq.EmailFile') { Fail "uninstall: .$ext still lists Brinq under Open with" }
}
Assert-OutlookDefaults 'uninstall'
Write-Host 'Uninstall: Brinq registration removed and Outlook defaults kept.'
