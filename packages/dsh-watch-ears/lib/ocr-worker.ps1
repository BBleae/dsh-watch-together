# Resident Windows OCR worker.
#
# Starting PowerShell costs ~224ms and loading the WinRT types another ~180ms,
# so a one-shot call spends 400ms of its 527ms on startup. This process loads
# once and then answers each request in ~120ms.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  # Wait() rethrows as a bare "发生一个或多个错误" when the completion is posted
  # to a context that is not pumping (it did under node's piped stdin but not
  # under ProcessStartInfo). GetAwaiter().GetResult() blocks correctly in both
  # and surfaces the real inner exception.
  $task.GetAwaiter().GetResult()
}
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
$lang = New-Object Windows.Globalization.Language 'zh-Hans-CN'
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { [Console]::Out.WriteLine('ERR|no engine'); exit 1 }

# Chinese OCR inserts spaces between glyphs; the subtitle is one sentence.
# Windows OCR separates every CJK glyph with a space; a subtitle is one
# sentence, so drop spaces that sit between two CJK characters. Written with
# regex escapes and character codes because PowerShell 5.1 reads this file as
# GBK - literal Chinese inside a pattern broke it with an invalid-regex error.
function Join-Cjk([string]$t) {
  $out = $t -replace '(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])', ''
  $out = $out -replace '\s+(?=[\u3001\u3002\uff0c\uff01\uff1f\uff1b\uff1a])', ''
  return $out.Trim()
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
  if (-not $line.StartsWith('OCR|')) { [Console]::Out.WriteLine('ERR|unknown'); [Console]::Out.Flush(); continue }
  $path = $line.Substring(4)
  try {
    $sf = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($sf.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $txt = Join-Cjk ([string]$res.Text)
    [Console]::Out.WriteLine('TEXT|' + $txt.Replace('|', ' '))
  } catch {
    [Console]::Out.WriteLine('ERR|' + $_.Exception.Message.Replace('|',' '))
  }
  [Console]::Out.Flush()
  try { $stream.Dispose() } catch { }
}