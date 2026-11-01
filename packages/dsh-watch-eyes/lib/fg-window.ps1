# Report the foreground window's process, title and rectangle.
#
# The face/screen sampler needs to know WHAT is in front, not just which windows
# exist: reading every window would be expensive and mostly irrelevant. This is
# the same oracle a person uses when glancing at their own monitor.
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$h = [FgWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][FgWin]::GetWindowText($h, $sb, 512)
$procId = 0
[void][FgWin]::GetWindowThreadProcessId($h, [ref]$procId)
$r = New-Object FgWin+RECT
[void][FgWin]::GetWindowRect($h, [ref]$r)
$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
$obj = [ordered]@{
  handle = [int64]$h
  pid = $procId
  process = if ($proc) { $proc.ProcessName } else { '' }
  title = $sb.ToString()
  x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top
}
# The title is CJK; PowerShell's default stdout encoding mangles it, so the
# JSON must be written as UTF-8 explicitly.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
ConvertTo-Json -InputObject $obj -Compress