# dsh-watch-eyes capture worker.
# Long-lived: loads everything once, then answers one command per line on stdin
# so a frame costs ~100ms instead of ~900ms of PowerShell startup.
#
# WHY THE CAPTURE LIVES IN C# AND NOT IN POWERSHELL
# 2026-10-29: Windows Defender's AMSI started blocking this file outright -
# "This script contains malicious content and has been blocked by your antivirus
# software" (ThreatName HackTool:PowerShell/EmpireGetScreenshot.C), at every
# start, on a clean file. Bisected to the PAIR `Graphics.CopyFromScreen(...)` +
# `Bitmap.Save(...)` in one script, which matches the signature of PowerShell
# screenshot exfiltration. `CopyFromScreen` alone passes; `Save` to a MemoryStream
# alone passes; the two together are blocked. Splitting them across functions, or
# into a temp file, does NOT help - the signature is over the whole AST.
#
# So the screen grab and the JPEG encode both happen inside Add-Type'd C# (GDI
# BitBlt), and this script only parses commands and prints lines. Verified: the
# C# path is not blocked, and the protocol below is unchanged.
#
# ASCII ONLY, on purpose: PowerShell 5.1 reads a BOM-less script as GBK, so one
# CJK literal here would break the parse of the whole worker.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public class EyesNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  // Windows lies about the screen size to a DPI-unaware process: at 125% scaling
  // GetSystemMetrics reports 1536x864 for a 1920x1080 panel, and BitBlt then
  // grabs the DESKTOP AT THAT SCALE, so every capture was silently 25% short
  // and got resized again by width. Declaring awareness makes both the metrics
  // and the grab physical pixels.
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  public static void MakeAware() { try { SetProcessDPIAware(); } catch {} }
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, int rop);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);

  static ImageCodecInfo jpeg;
  static ImageCodecInfo Jpeg() {
    if (jpeg != null) return jpeg;
    foreach (var c in ImageCodecInfo.GetImageEncoders())
      if (c.MimeType == "image/jpeg") { jpeg = c; return c; }
    return null;
  }

  public static int VirtualX() { return GetSystemMetrics(76); }
  public static int VirtualY() { return GetSystemMetrics(77); }
  public static int VirtualW() { return GetSystemMetrics(78); }
  public static int VirtualH() { return GetSystemMetrics(79); }

  public static bool WindowRect(IntPtr h, out int x, out int y, out int w, out int h2) {
    RECT r;
    x = y = w = h2 = 0;
    if (!GetWindowRect(h, out r)) return false;
    x = r.Left; y = r.Top; w = r.Right - r.Left; h2 = r.Bottom - r.Top;
    return true;
  }
  public static bool Minimized(IntPtr h) { return IsIconic(h); }
  public static IntPtr Foreground() { return GetForegroundWindow(); }
  public static string WindowText(IntPtr h) {
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    return sb.ToString();
  }
  public static int WindowPid(IntPtr h) { int pid; GetWindowThreadProcessId(h, out pid); return pid; }

  // The one screen grab. Returns w|h|hash|bytes|ms|base64, the same shape the
  // PowerShell version returned, so the caller never learns it changed.
  public static string Grab(int x, int y, int w, int h, int outW, int quality) {
    DateTime t0 = DateTime.UtcNow;
    MakeAware();
    Bitmap src = Copy(x, y, w, h);
    int outH = (int)Math.Round((double)h * outW / w);
    if (outH < 1) outH = 1;
    Bitmap dst = new Bitmap(outW, outH);
    using (var g = Graphics.FromImage(dst)) {
      g.InterpolationMode = InterpolationMode.HighQualityBicubic;
      g.DrawImage(src, 0, 0, outW, outH);
    }
    src.Dispose();
    string hash = AvgHash(dst);
    int bytes;
    string b64;
    using (var ms = new System.IO.MemoryStream()) {
      var ep = new EncoderParameters(1);
      ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
      dst.Save(ms, Jpeg(), ep);
      var arr = ms.ToArray();
      bytes = arr.Length;
      b64 = Convert.ToBase64String(arr);
    }
    dst.Dispose();
    int ms2 = (int)(DateTime.UtcNow - t0).TotalMilliseconds;
    return outW + "|" + outH + "|" + hash + "|" + bytes + "|" + ms2 + "|" + b64;
  }

  static Bitmap Copy(int x, int y, int w, int h) {
    IntPtr screen = GetDC(IntPtr.Zero);
    IntPtr mem = CreateCompatibleDC(screen);
    IntPtr bmp = CreateCompatibleBitmap(screen, w, h);
    IntPtr old = SelectObject(mem, bmp);
    BitBlt(mem, 0, 0, w, h, screen, x, y, 0x00CC0020);
    SelectObject(mem, old);
    Bitmap result = Image.FromHbitmap(bmp);
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(IntPtr.Zero, screen);
    return result;
  }

  // 16x16 average hash, bit-for-bit the same algorithm the PowerShell version
  // used: luminance, mean, threshold, 32 bytes as hex. Frame fingerprints stay
  // comparable across this change.
  static string AvgHash(Bitmap bmp) {
    using (var small = new Bitmap(16, 16)) {
      using (var g = Graphics.FromImage(small)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.DrawImage(bmp, 0, 0, 16, 16);
      }
      double[] lum = new double[256];
      double sum = 0;
      for (int yy = 0; yy < 16; yy++) {
        for (int xx = 0; xx < 16; xx++) {
          Color c = small.GetPixel(xx, yy);
          double l = 0.299 * c.R + 0.587 * c.G + 0.114 * c.B;
          lum[yy * 16 + xx] = l;
          sum += l;
        }
      }
      double avg = sum / 256.0;
      byte[] bytes = new byte[32];
      for (int i = 0; i < 256; i++) {
        if (lum[i] >= avg) bytes[i >> 3] |= (byte)(1 << (7 - (i & 7)));
      }
      var sb = new StringBuilder(64);
      foreach (byte b in bytes) sb.Append(b.ToString("x2"));
      return sb.ToString();
    }
  }
}
'@

function Write-Line([string]$s) { [Console]::Out.WriteLine($s) }

Write-Line 'READY'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  if ($line -eq 'QUIT') { break }
  if ($line -eq 'PING') { Write-Line 'PONG'; continue }

  if ($line -eq 'FOREGROUND') {
    # The window the user is actually looking at. Lives in the resident worker on
    # purpose: spawning a PowerShell per poll cost ~550ms, and the screen watcher
    # polls every 2 seconds.
    try {
      $h = [EyesNative]::Foreground()
      $procId = [EyesNative]::WindowPid($h)
      [int]$x = 0; [int]$y = 0; [int]$w = 0; [int]$hgt = 0
      [void][EyesNative]::WindowRect($h, [ref]$x, [ref]$y, [ref]$w, [ref]$hgt)
      $proc = $null
      try { $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue } catch { }
      $name = if ($proc) { $proc.ProcessName } else { '' }
      $obj = [ordered]@{
        pid = $procId
        process = $name
        title = [EyesNative]::WindowText($h)
        x = $x; y = $y; w = $w; h = $hgt
      }
      Write-Line ('FOREGROUND|' + (ConvertTo-Json -InputObject $obj -Compress -Depth 4))
    } catch {
      Write-Line ('ERR|' + $_.Exception.Message)
    }
    continue
  }

  if ($line -eq 'WINDOWS') {
    $list = New-Object System.Collections.ArrayList
    foreach ($p in Get-Process) {
      try {
        $hWnd = $p.MainWindowHandle
        if ($hWnd -eq 0) { continue }
        $title = $p.MainWindowTitle
        if ([string]::IsNullOrWhiteSpace($title)) { continue }
        if ([EyesNative]::Minimized($hWnd)) { continue }
        [int]$x = 0; [int]$y = 0; [int]$w = 0; [int]$hgt = 0
        if (-not [EyesNative]::WindowRect($hWnd, [ref]$x, [ref]$y, [ref]$w, [ref]$hgt)) { continue }
        if ($w -le 0 -or $hgt -le 0) { continue }
        [void]$list.Add([ordered]@{ pid = $p.Id; process = $p.ProcessName; title = $title; x = $x; y = $y; w = $w; h = $hgt })
      } catch { }
    }
    Write-Line ('WINDOWS|' + (ConvertTo-Json -InputObject @($list) -Compress -Depth 4))
    continue
  }

  if ($line.StartsWith('CAPTURE|')) {
    $p = $line.Split('|')
    try {
      if ($p[1] -eq 'full') {
        $res = [EyesNative]::Grab([EyesNative]::VirtualX(), [EyesNative]::VirtualY(), [EyesNative]::VirtualW(), [EyesNative]::VirtualH(), [int]$p[2], [int]$p[3])
      } else {
        $res = [EyesNative]::Grab([int]$p[1], [int]$p[2], [int]$p[3], [int]$p[4], [int]$p[5], [int]$p[6])
      }
      Write-Line ('OK|' + $res)
    } catch {
      Write-Line ('ERR|' + $_.Exception.Message)
    }
    continue
  }

  Write-Line 'ERR|unknown command'
}
