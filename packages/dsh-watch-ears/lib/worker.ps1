param([string]$Root = '')
if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $PSCommandPath) }
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$net = Join-Path $Root 'lib\net'
[System.Reflection.Assembly]::LoadFrom((Join-Path $net 'NAudio.Core.dll')) | Out-Null
[System.Reflection.Assembly]::LoadFrom((Join-Path $net 'NAudio.Wasapi.dll')) | Out-Null
[System.Reflection.Assembly]::LoadFrom((Join-Path $net 'NAudio.WinMM.dll')) | Out-Null
[System.Reflection.Assembly]::LoadFrom((Join-Path $net 'NAudio.dll')) | Out-Null
[System.Reflection.Assembly]::LoadFrom((Join-Path $net 'Ears.dll')) | Out-Null
[Console]::Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  if ($line -eq 'QUIT') { break }
  if ($line -eq 'PING') { [Console]::Out.WriteLine('PONG'); continue }
  if ($line -eq 'DEVICES') { [Console]::Out.WriteLine('DEVICES|' + [Ears]::Describe()); continue }
  if ($line.StartsWith('REC|')) {
    $p = $line.Split('|')
    try {
      $sil = 0.0; $thr = 0.0
      if ($p.Count -gt 4) { $sil = [double]$p[4] }
      if ($p.Count -gt 5) { $thr = [double]$p[5] }
      $r = [Ears]::RecordSegment($p[1], [double]$p[2], $p[3], 16000, $sil, $thr)
      $inv = [System.Globalization.CultureInfo]::InvariantCulture
      [Console]::Out.WriteLine('OK|' + $r.Bytes + '|' + $r.Peak.ToString('0.00000', $inv) + '|' + $r.Rms.ToString('0.00000', $inv) + '|' + $r.Milliseconds + '|' + $r.Format + '|' + $r.SilenceCut + '|' + $r.SpeechMs + '|' + $r.NoiseFloor.ToString('0.00000', $inv) + '|' + $r.EffectiveThreshold.ToString('0.00000', $inv))
    } catch {
      [Console]::Out.WriteLine('ERR|' + $_.Exception.Message)
    }
    continue
  }
  [Console]::Out.WriteLine('ERR|unknown command')
}
