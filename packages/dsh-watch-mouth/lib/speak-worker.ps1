# dsh-watch-mouth speech worker (moved out of dsh-watch-eyes on 2026-10-26).
# One long-lived PowerShell process hosts both playback paths:
#   SAY|<file>            finished MP3/WAV, MediaPlayer. Opens and plays at once
#                         (polling NaturalDuration used to cost ~200ms a line).
#   PCMOPEN|rate|bits|ch  raw PCM arriving while the model is still synthesising.
#   CHUNK|<base64>        base64 PCM. Text end to end: mixing a buffered
#                         ReadLine reader with raw stream reads silently eats
#                         bytes, so the audio payload rides inside the line too.
#   PCMCLOSE
# The PCM path is the low-latency one: sound starts on the first chunk instead
# of the last, so a long sentence no longer has to finish synthesising first.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName PresentationCore

# NAudio ships with the ears plugin (the same DLL set the recorder uses).
# Prefer a copy sitting next to this file, then fall back to the ears one, so
# moving either plugin does not silently take the voice down.
$net = Join-Path (Split-Path -Parent $PSCommandPath) 'net'
# The mouth ships its own copy of the NAudio DLLs. Reaching into the ears plugin
# for them made the two packages silently depend on each other's install path.
if (-not (Test-Path (Join-Path $net 'NAudio.dll'))) { [Console]::Out.WriteLine('WARN|naudio missing next to speak-worker.ps1'); $net = Join-Path (Split-Path -Parent $PSCommandPath) 'net' }
$script:haveNaudio = $false
try {
  Add-Type -Path (Join-Path $net 'NAudio.Core.dll')
  Add-Type -Path (Join-Path $net 'NAudio.dll')
  Add-Type -Path (Join-Path $net 'NAudio.WinMM.dll')
  $script:haveNaudio = $true
} catch {
  [Console]::Out.WriteLine('WARN|naudio unavailable')
}

$script:player = New-Object System.Windows.Media.MediaPlayer
$script:player.Volume = 1.0
$script:in = [Console]::OpenStandardInput()
$script:waveOut = $null
$script:waveBuf = $null
# -1 = system default output. Set by the DEVICE| command at daemon start so
# speech can be routed (e.g. into Voicemeeter) without touching the system default.
$script:outDevice = -1
$script:saidWarn = $false

function Stop-All {
  try { $script:player.Stop(); $script:player.Close() } catch { }
  if ($null -ne $script:waveOut) {
    try { $script:waveOut.Stop() } catch { }
    try { $script:waveOut.Dispose() } catch { }
    $script:waveOut = $null
    $script:waveBuf = $null
  }
}

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  if ($line -eq 'QUIT') { break }
  if ($line -eq 'PING') { [Console]::Out.WriteLine('PONG'); [Console]::Out.Flush(); continue }

  # List WinMM output devices: DEV|<index>|<name> ... DEVICES-END
  if ($line -eq 'DEVICES') {
    if (-not $script:haveNaudio) { [Console]::Out.WriteLine('ERR|no naudio'); [Console]::Out.Flush(); continue }
    try {
      $n = [NAudio.Wave.WaveInterop]::waveOutGetNumDevs()
      $sz = [System.Runtime.InteropServices.Marshal]::SizeOf([type]([NAudio.Wave.WaveOutCapabilities]))
      for ($i = 0; $i -lt $n; $i++) {
        $caps = New-Object NAudio.Wave.WaveOutCapabilities
        $mmr = [NAudio.Wave.WaveInterop]::waveOutGetDevCaps([IntPtr]$i, [ref]$caps, $sz)
        if ($mmr -eq 0) { [Console]::Out.WriteLine('DEV|' + $i + '|' + $caps.ProductName) }
      }
      [Console]::Out.WriteLine('DEVICES-END'); [Console]::Out.Flush()
    } catch {
      [Console]::Out.WriteLine('ERR|' + $_.Exception.Message); [Console]::Out.Flush()
    }
    continue
  }

  # Pin the playback device. -1 restores the system default.
  if ($line.StartsWith('DEVICE|')) {
    try {
      $script:outDevice = [int]$line.Substring(7)
      $script:saidWarn = $false
      [Console]::Out.WriteLine('DEVICE-OK|' + $script:outDevice); [Console]::Out.Flush()
    } catch {
      [Console]::Out.WriteLine('ERR|bad device number'); [Console]::Out.Flush()
    }
    continue
  }

  if ($line -eq 'STOP') {
    Stop-All
    [Console]::Out.WriteLine('STOPPED'); [Console]::Out.Flush()
    continue
  }

  if ($line.StartsWith('SAY|')) {
    $file = $line.Substring(4)
    try {
      Stop-All
      if ($script:outDevice -ge 0 -and -not $script:saidWarn) {
        $script:saidWarn = $true
        [Console]::Out.WriteLine('WARN|MediaPlayer ignores DEVICE, file playback goes to the system default')
      }
      $script:player.Open([uri]$file)
      $script:player.Play()
      [Console]::Out.WriteLine('PLAYING|0'); [Console]::Out.Flush()
    } catch {
      [Console]::Out.WriteLine('ERR|' + $_.Exception.Message); [Console]::Out.Flush()
    }
    continue
  }

  if ($line.StartsWith('PCMOPEN|')) {
    $parts = $line.Split('|')
    if (-not $script:haveNaudio) { [Console]::Out.WriteLine('ERR|no naudio'); [Console]::Out.Flush(); continue }
    # append=1: this utterance is a CONTINUATION of the one already playing.
    #
    # Every PCMOPEN used to call Stop-All, so a reply spoken in chunks cut its own
    # first chunk the moment the second arrived - measured as replaced:8 while
    # queue=1 was set, and heard as "only the last fragment plays". Chunked speech
    # is impossible without this flag: the chunks are one utterance, not several.
    $append = ($parts.Count -ge 5 -and $parts[4] -eq '1')
    try {
      if (-not ($append -and $null -ne $script:waveBuf)) {
        Stop-All
        $rate = [int]$parts[1]; $bits = [int]$parts[2]; $ch = [int]$parts[3]
        $script:pcmRate = $rate; $script:pcmBits = $bits; $script:pcmChannels = $ch
        $script:pcmBytes = 0
      $fmt = New-Object NAudio.Wave.WaveFormat($rate, $bits, $ch)
      $script:waveBuf = New-Object NAudio.Wave.BufferedWaveProvider($fmt)
      $script:waveBuf.DiscardOnBufferOverflow = $true
      $script:waveBuf.BufferDuration = [TimeSpan]::FromSeconds(30)
      $script:waveOut = New-Object NAudio.Wave.WaveOutEvent
      if ($script:outDevice -ge 0) { $script:waveOut.DeviceNumber = $script:outDevice }
      $script:waveOut.DesiredLatency = 120
      $script:waveOut.Init($script:waveBuf)
      $script:waveOut.Play()
      }
      [Console]::Out.WriteLine('PCMREADY'); [Console]::Out.Flush()
    } catch {
      [Console]::Out.WriteLine('ERR|' + $_.Exception.Message); [Console]::Out.Flush()
    }
    continue
  }

  if ($line.StartsWith('CHUNK64|')) {
    if ($null -eq $script:waveBuf) { continue }
    try {
      $tmp = [Convert]::FromBase64String($line.Substring(8))
      if ($tmp.Length -gt 0) {
        $script:waveBuf.AddSamples($tmp, 0, $tmp.Length)
        $script:pcmBytes = [int]$script:pcmBytes + $tmp.Length
      }
    } catch { }
    continue
  }

  if ($line -eq 'PCMCLOSE') {
    # Report the TOTAL audio of this utterance, not what is still queued.
    #
    # BufferedDuration is what has not played yet, so under chunked speech every
    # PCMCLOSE reported a shrinking remainder: the clock said ~1s while seven
    # seconds of audio had been handed over, and the avatar stopped animating.
    # Bytes written / bytes-per-second is the honest number and does not depend on
    # how far playback has got.
    $dur = 0
    if ($null -ne $script:waveBuf) {
      try {
        $rate = [int]$script:pcmRate
        $bits = [int]$script:pcmBits
        $ch = [int]$script:pcmChannels
        $bytesPerSec = ($rate * $bits * $ch) / 8
        if ($bytesPerSec -gt 0 -and $script:pcmBytes -gt 0) {
          $dur = [int](($script:pcmBytes / $bytesPerSec) * 1000)
        }
      } catch { }
    }
    [Console]::Out.WriteLine('PCMDONE|' + $dur); [Console]::Out.Flush()
    continue
  }

  [Console]::Out.WriteLine('ERR|unknown command'); [Console]::Out.Flush()
}
Stop-All