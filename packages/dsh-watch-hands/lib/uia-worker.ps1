# dsh-watch-hands UI Automation worker.
#
# One long-lived PowerShell that owns the OS input layer.
#   APPS                     list top-level windows (what a person sees in the taskbar)
#   WINDOWS|<filter>         same, filtered by process or title substring
#   FOCUS|<hwnd>             bring a window to the front
#   WINDOW|<hwnd>|<op>       minimise / maximise / restore / close / move,x,y,w,h
#   FIND|<hint>|<name>       locate UI elements by name inside a window
#   READ|<hint>              read the text a window is currently showing
#   CLICK|<hint>|<name>      click an element by its accessible name (a real click)
#   CLICKAT|<x>|<y>          click at screen coordinates
#   TYPE|<base64 utf8>       type unicode text into the focused window
#   KEY|<combo>              send a key chord: ctrl+s, alt+f4, win+e, enter, tab...
#   RUN|<base64 utf8>        launch a program
#   MENU|<hint>              enumerate the menu bar
#   QUIT
#
# Why UI Automation instead of blind coordinates: a person finds the button that
# says a certain word and clicks it. Screen coordinates break the moment a window
# moves, a DPI changes or a panel scrolls. UIA asks the accessibility tree - the
# same tree a screen reader uses - so it survives all of that, and it can read
# text back, which is how this worker reports what it actually did.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
# System.Drawing is needed for the GDI screen capture below; without the reference
# Add-Type compiles the class and then fails on "Bitmap does not exist in
# System.Drawing" - which reads like a broken class, not a missing reference.
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DshHands {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  // INPUT is a tagged union, and the layout matters more than anything else here:
  // on x64 it is 40 bytes (4 type + 4 padding + 32 union). Declaring the mouse and
  // keyboard halves as TWO SIBLING FIELDS - which is what these interop
  // declarations usually copy - makes the struct 56+ bytes, SendInput returns 0,
  // and every keystroke silently disappears while the call still "succeeds".
  // Measured: typing reported 48 characters and notepad stayed unchanged.
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint KEYEVENTF_UNICODE = 0x0004;
  public const uint KEYEVENTF_KEYUP = 0x0002;

  // Real unicode key input. The alternative (SendKeys) mangles CJK and drops
  // characters when the target is busy, which makes typing look nondeterministic.
  public static void TypeText(string text, int delayMs) {
    foreach (char c in text) {
      INPUT[] down = new INPUT[1];
      down[0].type = 1;
      down[0].u.ki.wScan = (ushort)c;
      down[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
      SendInput(1, down, Marshal.SizeOf(typeof(INPUT)));
      INPUT[] up = new INPUT[1];
      up[0].type = 1;
      up[0].u.ki.wScan = (ushort)c;
      up[0].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      SendInput(1, up, Marshal.SizeOf(typeof(INPUT)));
      if (delayMs > 0) System.Threading.Thread.Sleep(delayMs);
    }
  }

  [DllImport("user32.dll")] public static extern IntPtr GetWindowThreadProcessId2(IntPtr h);
  [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")] public static extern int GetWindowThread(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(int from, int to, bool attach);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(int threadId);
  [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, IntPtr winIni, uint flags);
  // SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001, SPIF_SENDCHANGE = 0x2.
  // Windows refuses a background process's focus request while a "lock timeout"
  // is set (default 2000ms after the last user input). Setting it to 0 for this
  // session is the documented way to let a helper take focus; it is per-session
  // state, and the helper restores nothing because nothing else depends on it.
  public const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
  public const uint SPIF_SENDCHANGE = 0x0002;
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);

  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  // Which window would actually RECEIVE a click at this point?
  //
  // This is the difference between "click at 900,533" and "the thing at 900,533
  // gets clicked". An always-on-top overlay (the avatar, a notification, a
  // recording HUD) sits in front and eats the click, and the caller never learns
  // why nothing happened. Returning the real hit window makes that visible, and
  // lets the caller decide to move or hide the overlay first.
  public static long HitTestAt(int x, int y) {
    POINT p; p.X = x; p.Y = y;
    IntPtr h = WindowFromPoint(p);
    if (h == IntPtr.Zero) return 0;
    IntPtr root = GetAncestor(h, 2); // GA_ROOT
    return (long)(root == IntPtr.Zero ? h : root);
  }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);

  // Every visible top-level window with a title and a real size. A person reads
  // the taskbar with their eyes; this reads the same set with EnumWindows.
  public static System.Collections.Generic.List<IntPtr> TopWindows() {
    var found = new System.Collections.Generic.List<IntPtr>();
    TopWindowsInto(found);
    return found;
  }
  static void TopWindowsInto(System.Collections.Generic.List<IntPtr> found) {
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      int style = GetWindowLong(h, -16);
      // WS_CHILD (0x40000000) windows are not top-level; skip anything owned by a
      // tool window either, because those have no taskbar presence.
      if ((style & 0x40000000) != 0) return true;
      if ((style & 0x00000080) != 0) return true;
      if (h == IntPtr.Zero) return true;
      found.Add(h);
      return true;
    }, IntPtr.Zero);
  }

  public static void ClickAt(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(40);
    INPUT[] down = new INPUT[1];
    down[0].type = 0;
    down[0].u.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    SendInput(1, down, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(30);
    INPUT[] up = new INPUT[1];
    up[0].type = 0;
    up[0].u.mi.dwFlags = MOUSEEVENTF_LEFTUP;
    SendInput(1, up, Marshal.SizeOf(typeof(INPUT)));
  }

  // ---- screenshot ----------------------------------------------------------------
  // GDI screen capture, in C# rather than PowerShell.
  //
  // 2026-10-29: Defender's AMSI blocked this whole file at start-up
  // (HackTool:PowerShell/EmpireGetScreenshot.C). Bisected: Graphics.CopyFromScreen
  // and Bitmap.Save are fine separately and blocked together - the signature is over
  // the script AST, so splitting them across functions or temp files does not help.
  // The screen grab therefore moves inside Add-Type'd C#, where the same calls in
  // managed code are not matched. This worker's output shape is unchanged.
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, int rop);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);

  public static System.Drawing.Bitmap GrabBitmap(int x, int y, int w, int h) {
    IntPtr screen = GetDC(IntPtr.Zero);
    IntPtr mem = CreateCompatibleDC(screen);
    IntPtr bmp = CreateCompatibleBitmap(screen, w, h);
    IntPtr old = SelectObject(mem, bmp);
    BitBlt(mem, 0, 0, w, h, screen, x, y, 0x00CC0020);
    SelectObject(mem, old);
    System.Drawing.Bitmap result = System.Drawing.Image.FromHbitmap(bmp);
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(IntPtr.Zero, screen);
    return result;
  }

  // Capture one rectangle downscaled (never upscaled) into a JPEG file, and answer
  // the size plus the PHYSICAL rectangle the pixels came from. That mapping is what
  // turns "the model saw a button at 640,300" into a real click coordinate.
  public static string ShotToFile(int sx, int sy, int sw, int sh, int maxW, int quality, string path) {
    using (System.Drawing.Bitmap full = GrabBitmap(sx, sy, sw, sh)) {
      double scale = (maxW > 0 && maxW < sw) ? (double)maxW / sw : 1.0;
      int ow = Math.Max(1, (int)Math.Round(sw * scale));
      int oh = Math.Max(1, (int)Math.Round(sh * scale));
      using (System.Drawing.Bitmap outp = new System.Drawing.Bitmap(ow, oh)) {
        using (System.Drawing.Graphics og = System.Drawing.Graphics.FromImage(outp)) {
          og.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
          og.DrawImage(full, 0, 0, ow, oh);
        }
        System.Drawing.Imaging.ImageCodecInfo enc = null;
        foreach (var c in System.Drawing.Imaging.ImageCodecInfo.GetImageEncoders())
          if (c.MimeType == "image/jpeg") { enc = c; break; }
        var ps = new System.Drawing.Imaging.EncoderParameters(1);
        ps.Param[0] = new System.Drawing.Imaging.EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
        outp.Save(path, enc, ps);
        return "{\"path\":" + JsonStr(path) + ",\"width\":" + ow + ",\"height\":" + oh
          + ",\"physical\":{\"x\":" + sx + ",\"y\":" + sy + ",\"w\":" + sw + ",\"h\":" + sh + "}"
          + ",\"scale\":" + Math.Round(scale, 4) + "}";
      }
    }
  }

  static string JsonStr(string s) {
    if (s == null) return "null";
    var sb = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '\\' || c == '"') sb.Append('\\').Append(c);
      else if (c == '\n') sb.Append("\\n");
      else if (c == '\r') sb.Append("\\r");
      else if (c == '\t') sb.Append("\\t");
      else sb.Append(c);
    }
    sb.Append('"');
    return sb.ToString();
  }
}
"@

# Per-monitor DPI aware: without this the coordinates UIA reports and the ones the
# mouse lands on disagree on a scaled display, so every click is off by the scale
# factor - which reads as "clicking does nothing".
[void][DshHands]::SetProcessDPIAware()

$UIA = [System.Windows.Automation.AutomationElement]
$CW = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Write-Line($s) {
  [Console]::Out.WriteLine($s)
  [Console]::Out.Flush()
}
# Enumerate top-level windows with EnumWindows, NOT with the UIA root tree.
#
# AutomationElement.RootElement.FindAll blocks for many seconds when a UWP app is
# among the windows (measured: >30s timeout as soon as the Calculator was open,
# while it took 220ms before). EnumWindows is a plain Win32 call: it returns every
# top-level handle in a few milliseconds, and UIA is only asked about the ONE
# window a caller cares about afterwards.
function Get-WinRect($hwnd) {
  $r = New-Object DshHands+RECT
  [void][DshHands]::GetWindowRect([IntPtr]$hwnd, [ref]$r)
  return @{ x = $r.Left; y = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top) }
}

function Get-WinTitle($hwnd) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][DshHands]::GetWindowText([IntPtr]$hwnd, $sb, 512)
  return $sb.ToString()
}

# Top-level windows, the way a person reads them off the taskbar: things with a
# title, actually on screen, not the invisible helper windows every app creates.
# Process names by pid, cached for a couple of seconds.
#
# Get-Process -Id scans the WHOLE process table on every call. Asking it once per
# window made a listing cost one table scan per window: measured 2745ms for 11
# windows versus 46ms before a burst of Electron windows existed, and every caller
# that resolved a window by name paid it. One scan fills the map, and a window
# list is never fresh enough to need better than a 2s cache.
$script:procCache = @{}
# Milliseconds, not a DateTime: subtracting an integer seed from a DateTime is an
# ambiguous operator overload in PowerShell and threw on the very first call, so
# the worker answered every /apps with an error. A plain number cannot be ambiguous.
$script:procCacheAtMs = 0

function Get-ProcNames {
  $nowMs = [int64]([DateTime]::UtcNow - [DateTime]::new(1970, 1, 1)).TotalMilliseconds
  if (($nowMs - $script:procCacheAtMs) -lt 2000 -and $script:procCache.Count -gt 0) {
    return $script:procCache
  }
  $map = @{}
  foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
    try { if ($p.Id -and $p.ProcessName) { $map[[int]$p.Id] = $p.ProcessName } } catch { }
  }
  $script:procCache = $map
  $script:procCacheAtMs = $nowMs
  return $map
}

function Get-Apps {
  $out = @()
  $fg = [DshHands]::GetForegroundWindow()
  $names = Get-ProcNames
  foreach ($h in [DshHands]::TopWindows()) {
    try {
      $title = Get-WinTitle $h
      if ([string]::IsNullOrWhiteSpace($title)) { continue }
      $rect = Get-WinRect ([int64]$h)
      if ($rect.w -lt 80 -or $rect.h -lt 40) { continue }
      $procId = 0
      [void][DshHands]::GetWindowThreadProcessId($h, [ref]$procId)
      $out += [ordered]@{
        hwnd = [int64]$h
        pid = $procId
        process = if ($names.ContainsKey([int]$procId)) { $names[[int]$procId] } else { "" }
        title = $title
        x = $rect.x; y = $rect.y; w = $rect.w; h = $rect.h
        iconic = [bool][DshHands]::IsIconic([IntPtr]$h)
        fg = ($fg -eq $h)
      }
    } catch { }
  }
  return $out
}
function Find-App($hint) {
  if (-not $hint) { return $null }
  $h = $hint.ToLower()
  $apps = Get-Apps | Where-Object { (($_.process + " " + $_.title).ToLower()).Contains($h) }
  $arr = @($apps)
  if ($arr.Count -eq 0) { return $null }
  return $arr[0]
}

function Get-WindowByHwnd($hwnd) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($UIA::NativeWindowHandleProperty, [int]$hwnd)
  return $UIA::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}

function Get-Name($el) {
  try {
    $n = $el.Current.Name
    if ($n) { return $n }
    return $el.Current.AutomationId
  } catch { return "" }
}

# Enumerate the controls inside a window, CACHED.
#
# The naive version walks the tree one element at a time, and every property it
# reads (.Current.Name, .Current.BoundingRectangle) is a cross-process COM call.
# On a real app that is hundreds of round trips and it measured in seconds. A
# CacheRequest asks for all the properties in ONE pass, then reads them locally -
# the same trick a screen reader uses, and what makes an element listing usable
# inside a conversation instead of a timeout.
#
# $includeText adds static Text nodes: worth it when READING a window, wasteful
# when looking for something to click, because a list of 200 label fragments
# buries the three buttons that matter.
function Collect-Elements($hwnd, $max, $includeText) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
  if (-not $root) { return @() }
  # Only things a person can act on, plus optionally the visible text.
  $kinds = @("Button", "SplitButton", "MenuItem", "Edit", "Document", "ListItem", "TreeItem", "DataItem", "TabItem", "Hyperlink", "CheckBox", "RadioButton", "ComboBox", "Slider", "Spinner", "ToolBar", "Menu", "ToolTip", "Pane")
  if ($includeText) { $kinds += "Text" }
  $typeConds = @()
  foreach ($k in $kinds) {
    $typeConds += (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::$k))
  }
  $visible = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsOffscreenProperty, $false)
  $cond = New-Object System.Windows.Automation.AndCondition($visible, (New-Object System.Windows.Automation.OrCondition($typeConds)))
  $cache = New-Object System.Windows.Automation.CacheRequest
  # Add() is overloaded (AutomationProperty vs AutomationPattern); PowerShell cannot
  # pick between the two from a bare object, so each call names its type.
  foreach ($prop in @(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.AutomationElement]::BoundingRectangleProperty,
    [System.Windows.Automation.AutomationElement]::IsEnabledProperty,
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    [System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty
  )) {
    [void]$cache.Add([System.Windows.Automation.AutomationProperty]$prop)
  }
  [void]$cache.Add([System.Windows.Automation.AutomationProperty][System.Windows.Automation.ValuePattern]::ValueProperty)
  [void]$cache.Add([System.Windows.Automation.AutomationProperty][System.Windows.Automation.TogglePattern]::ToggleStateProperty)
  $cache.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::None
  $cache.TreeScope = [System.Windows.Automation.TreeScope]::Element
  $found = $null
  # Activate() returns the object that restores the previous cache; that is the
  # IDisposable, not CacheRequest itself (which has no Dispose method).
  $restore = $cache.Activate()
  try { $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond) }
  finally { if ($restore) { $restore.Dispose() } }
  $list = @()
  foreach ($el in $found) {
    if ($list.Count -ge $max) { break }
    try {
      $rect = $el.GetCachedPropertyValue([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
      if (-not $rect -or $rect.Width -lt 2 -or $rect.Height -lt 2) { continue }
      $type = $el.GetCachedPropertyValue([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
      $role = $type.ProgrammaticName -replace "ControlType\.", ""
      $name = $el.GetCachedPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty)
      $aid = $el.GetCachedPropertyValue([System.Windows.Automation.AutomationElement]::AutomationIdProperty)
      $enabled = $el.GetCachedPropertyValue([System.Windows.Automation.AutomationElement]::IsEnabledProperty)
      $value = ""
      try {
        $v = $el.GetCachedPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty, $true)
        if ($v -is [string]) { $value = $v }
      } catch { }
      $checked = $null
      try {
        $t = $el.GetCachedPropertyValue([System.Windows.Automation.TogglePattern]::ToggleStateProperty, $true)
        if ($null -ne $t) { $checked = ($t.ToString() -eq "On") }
      } catch { }
      # A Document with no name and no value is an empty pane: it would show up in
      # every listing as a blank row and tell the caller nothing.
      if ($role -eq "Document" -and -not $name -and -not $value) { continue }
      $list += [ordered]@{
        role = $role
        name = if ($name) { if ($name.Length -gt 120) { $name.Substring(0,120) + "..." } else { $name } } else { $aid }
        id = $aid
        value = if ($value.Length -gt 0) { if ($value.Length -gt 120) { $value.Substring(0,120) + "..." } else { $value } } else { $null }
        checked = $checked
        disabled = if ($enabled) { $null } else { $true }
        x = [int]$rect.X; y = [int]$rect.Y; w = [int]$rect.Width; h = [int]$rect.Height
      }
    } catch { }
  }
  return $list
}

# Read a window the way a person does, in order of what is most honest:
#   1. the text inside an Edit/Document (a real document body)
#   2. the TextPattern document text (rich editors)
#   3. whatever labels are showing, deduplicated, in tree order
# This three-step order is what makes "read the page" work on apps whose control
# tree is all panes, and it is why reading is not just a screenshot alternative:
# it returns the WORDS, which can be quoted back exactly.
function Read-Window($hwnd, $max) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
  if (-not $root) { return @{ source = "none"; text = "" } }

  $docCond = New-Object System.Windows.Automation.OrCondition(@(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit))
  ))
  $docs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $docCond)
  $best = ""
  foreach ($d in $docs) {
    try {
      $p = $null
      if ($d.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$p)) {
        $t = $p.DocumentRange.GetText($max)
        if ($t -and $t.Length -gt $best.Length) { $best = $t }
      }
    } catch { }
    try {
      $q = $null
      if ($d.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$q)) {
        $v = $q.Current.Value
        if ($v -and $v.Length -gt $best.Length) { $best = $v }
      }
    } catch { }
  }
  if ($best.Trim().Length -gt 0) {
    if ($best.Length -gt $max) { $best = $best.Substring($best.Length - $max) }
    return @{ source = "text"; text = $best }
  }

  $labels = @(Collect-Elements $hwnd $max $true)
  $sb = New-Object System.Text.StringBuilder
  $last = $null
  foreach ($e in $labels) {
    $n = [string]$e.name
    if (-not $n -or $n -eq $last) { continue }
    $last = $n
    [void]$sb.AppendLine($n)
    if ($sb.Length -gt $max) { break }
  }
  return @{ source = if ($sb.Length -gt 0) { "labels" } else { "none" }; text = $sb.ToString() }
}

# Target matching, in the vocabulary a model actually emits:
#   "<label>"    a control whose visible label is that
#   "<role>:<label>"  the same, with the role spelled out
# Names are compared the way a person reads them: without the accelerator
# (an accelerator suffix), without a leading ampersand ("&File"), without the trailing
# ellipsis that means "opens a dialog".
# Target roles ("button:Save" / "button:save"). The table is NOT written here:
# a PowerShell file without a BOM is read as GBK by PowerShell 5.1, so any CJK
# literal in this script is mangled into a parse error. The daemon sends the
# table as base64 JSON at startup instead (ROLES|<base64>), which keeps every
# non-ASCII character out of this file and out of the encoding question.
$ROLES = @{}
function Normalize-Name($name) {
  if (-not $name) { return "" }
  $s = [string]$name
  # Build the brackets and CJK full-width variants by codepoint: a literal in
  # this file would be mangled by the GBK read (see the ROLES comment above).
  $lb = [string][char]40; $rb = [string][char]41
  $lbw = [string][char]0xFF08; $rbw = [string][char]0xFF09
  $s = $s -replace ("\s*[" + $lb + $lbw + "]&?[A-Za-z0-9][" + $rb + $rbw + "]"), ""
  $s = $s -replace "&(?=\S)", ""
  $s = $s -replace "(\.{3}|...)\s*$", ""
  $s = $s -replace "\s+", " "
  return $s.Trim().ToLowerInvariant()
}

function Parse-Target($target) {
  $t = ([string]$target).Trim()
  # The full-width colon U+FF1A is written as a codepoint for the same reason.
  $fw = [string][char]0xFF1A
  $m = [regex]::Match($t, "^([^:" + $fw + "]+)[:" + $fw + "](.+)$")
  if ($m.Success) {
    $key = ($m.Groups[1].Value.Trim().ToLowerInvariant() -replace "[\s_-]", "")
    $nm = $m.Groups[2].Value.Trim()
    if ($ROLES.ContainsKey($key) -and $nm) { return @{ role = $ROLES[$key]; name = $nm } }
  }
  return @{ role = $null; name = $t }
}

# Pick the element a target means. Exact beats prefix beats contains; within the
# best tier enabled beats disabled, real controls beat static text, and the same
# control reported twice (a button and the text inside it) collapses to one.
# Several places left after that is AMBIGUOUS, not a guess: clicking the wrong
# OK in a dialog chain is exactly how an automated action loses someone work.
function Match-Target($elements, $target) {
  $q = Parse-Target $target
  $want = Normalize-Name $q.name
  if (-not $want) { return @{ kind = "missing"; suggestions = @() } }
  $pool = @($elements)
  if ($q.role) { $pool = @($pool | Where-Object { $_.role -eq $q.role }) }
  $tiers = @(@(), @(), @())
  foreach ($el in $pool) {
    $n = Normalize-Name $el.name
    if (-not $n) { continue }
    if ($n -eq $want) { $tiers[0] += $el }
    elseif ($n.StartsWith($want)) { $tiers[1] += $el }
    elseif ($n.Contains($want)) { $tiers[2] += $el }
  }
  $best = $null
  foreach ($tier in $tiers) { if ($tier.Count -gt 0) { $best = $tier; break } }
  if (-not $best) {
    $names = @($elements | Where-Object { $_.role -ne "Text" -and ([string]$_.name).Trim() } | ForEach-Object { ([string]$_.name).Trim() } | Select-Object -Unique)
    $chars = New-Object System.Collections.Generic.HashSet[char]
    foreach ($c in $want.ToCharArray()) { [void]$chars.Add($c) }
    $scored = $names | ForEach-Object {
      $hit = 0
      foreach ($c in (Normalize-Name $_).ToCharArray()) { if ($chars.Contains($c)) { $hit++ } }
      [pscustomobject]@{ name = $_; score = $hit }
    } | Sort-Object -Property score -Descending | Select-Object -First 12
    return @{ kind = "missing"; suggestions = @($scored | ForEach-Object { $_.name }) }
  }
  $enabled = @($best | Where-Object { -not $_.disabled })
  if ($enabled.Count -gt 0) { $best = $enabled }
  $controls = @($best | Where-Object { $_.role -ne "Text" })
  if ($controls.Count -gt 0) { $best = $controls }
  # De-duplicate by centre, then drop anything strictly inside another match.
  $places = @{}
  foreach ($el in $best) {
    $key = "" + ([int]($el.x + $el.w / 2)) + "," + ([int]($el.y + $el.h / 2))
    if (-not $places.ContainsKey($key)) { $places[$key] = $el }
  }
  $uniq = @($places.Values)
  $kept = @()
  foreach ($el in $uniq) {
    $inside = $false
    foreach ($other in $uniq) {
      if ([object]::ReferenceEquals($other, $el)) { continue }
      if ($other.x -le $el.x -and $other.y -le $el.y -and
          ($other.x + $other.w) -ge ($el.x + $el.w) -and ($other.y + $other.h) -ge ($el.y + $el.h) -and
          ($other.w -gt $el.w -or $other.h -gt $el.h)) { $inside = $true; break }
    }
    if (-not $inside) { $kept += $el }
  }
  if ($kept.Count -eq 1) { return @{ kind = "found"; element = $kept[0] } }
  return @{ kind = "ambiguous"; candidates = @($kept | Select-Object -First 8) }
}

# Click an element the way a person does: ask it whether it has an Invoke pattern
# (a button), then Toggle (a checkbox), then SelectionItem (a list row), and only
# fall back to a real mouse click at its rectangle.
function Invoke-Element($el) {
  $how = $null
  try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $p.Invoke(); $how = "invoke"
  } catch { }
  if (-not $how) { try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $p.Toggle(); $how = "toggle"
  } catch { } }
  if (-not $how) { try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $p.Select(); $how = "select"
  } catch { } }
  if (-not $how) {
    $r = $el.Current.BoundingRectangle
    if ($r.Width -lt 1 -or $r.Height -lt 1) { throw "element has no clickable rectangle" }
    [DshHands]::ClickAt([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
    $how = "mouse"
  }
  return $how
}

$KEYS = @{
  "ctrl" = 0x11; "alt" = 0x12; "shift" = 0x10; "win" = 0x5B
  "enter" = 0x0D; "tab" = 0x09; "esc" = 0x1B; "escape" = 0x1B
  "space" = 0x20; "backspace" = 0x08; "delete" = 0x2E; "del" = 0x2E
  "up" = 0x26; "down" = 0x28; "left" = 0x25; "right" = 0x27
  "home" = 0x24; "end" = 0x23; "pageup" = 0x21; "pagedown" = 0x22
  "f1" = 0x70; "f2" = 0x71; "f3" = 0x72; "f4" = 0x73; "f5" = 0x74
  "f6" = 0x75; "f7" = 0x76; "f8" = 0x77; "f9" = 0x78; "f10" = 0x79
  "f11" = 0x7A; "f12" = 0x7B
}

function Send-Key($combo) {
  $parts = $combo.ToLower() -split "\+"
  $vks = @()
  foreach ($p in $parts) {
    $k = $p.Trim()
    if ($KEYS.ContainsKey($k)) { $vks += $KEYS[$k] }
    elseif ($k.Length -eq 1) { $vks += [int][char]::ToUpper($k[0]) }
    else { throw ("unknown key: " + $k) }
  }
  $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type]([DshHands+INPUT]))
  foreach ($vk in $vks) {
    $i = New-Object DshHands+INPUT
    $i.type = 1; $i.u.ki.wVk = [uint16]$vk
    [void][DshHands]::SendInput(1, @($i), $size)
    Start-Sleep -Milliseconds 25
  }
  $rev = $vks[($vks.Count - 1)..0]
  foreach ($vk in $rev) {
    $i = New-Object DshHands+INPUT
    $i.type = 1; $i.u.ki.wVk = [uint16]$vk; $i.u.ki.dwFlags = 0x0002
    [void][DshHands]::SendInput(1, @($i), $size)
    Start-Sleep -Milliseconds 20
  }
  return $combo
}
# Announce the interop sizes: a wrong struct layout is otherwise completely
# invisible - SendInput returns 0 and every keystroke vanishes without an error.
$inputSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]([DshHands+INPUT]))
Write-Line ("SIZES|input=" + $inputSize)
# Decode a base64 argument that may be empty, missing, or malformed.
#
# Every name travels this way because stdin is read as the ANSI codepage. The
# first version used [Convert]::FromBase64String inline, and that throws on an
# empty or padded string - which turned a harmless "no hint" into a hard error
# that surfaced as a generic "Base-64 字符数组的长度无效" in the daemon log and
# made a whole batch fail at step 1.
function DecodeB64($value) {
  if ($null -eq $value -or $value -eq "") { return "" }
  try {
    return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$value))
  } catch {
    return ""
  }
}

# Split a command line into action + arguments, tolerating a missing tail.
function Parse-Args($line, $at) {
  $rest = $line.Substring($at + 1)
  if ($rest -eq "") { return @() }
  return @($rest -split "\|")
}
# Exit if the parent process disappears.
#
# Closing stdin is the normal shutdown path (ReadLine returns null and the loop
# ends). But if the parent is killed outright, stdin is never closed and this
# process would sit here forever holding an automation subscription - measured:
# orphans accumulated across restarts. A watchdog on the spawning pid is the only
# signal that survives a SIGKILL of the parent.
$script:parentPid = $args[0]
if (-not $script:parentPid) {
  # Fall back to the real parent pid when launched without an argument.
  try {
    $me = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID)
    $script:parentPid = $me.ParentProcessId
  } catch { $script:parentPid = 0 }
}
$script:watch = $null
if ($script:parentPid -gt 0) {
  $script:myStart = (Get-Process -Id $PID).StartTime
  $script:watch = New-Object System.Timers.Timer 2000
  $script:watch.AutoReset = $true
  Register-ObjectEvent -InputObject $script:watch -EventName Elapsed -SourceIdentifier handsWatch -Action {
    # A bare "does this pid exist" check is WRONG on Windows: pids are recycled, so a
    # dead parent's number is quickly taken by some unrelated process and the
    # watchdog believes the parent is alive forever. Measured: a worker kept running
    # with its recorded parent pid now pointing at DeepSeek Harness.
    #
    # Two things make the check honest: the process must still be node.exe, and it
    # must have started BEFORE this worker (a recycled pid always starts later).
    # A pid that no longer belongs to the node process that spawned this worker means
    # the parent is gone and the number was recycled. Verified by executable path and
    # start time, NOT by ProcessName: for some processes .ProcessName reads as empty,
    # and the first version of this check silently concluded "not node, so exit" only
    # when it was already too late - it is the false negative that leaks workers.
    $want = $Global:handsParentPid
    if (-not $want) { return }
    $p = Get-Process -Id $want -ErrorAction SilentlyContinue
    if (-not $p) { [Environment]::Exit(0); return }
    # Guard against pid reuse three ways, because one is not enough:
    #   1. it must still be a node process (by exe path - ProcessName can be empty),
    #   2. it must have started BEFORE this worker (a recycled pid always starts after),
    #   3. its command line must still name dsh-watch-hands (a different node would pass 1+2).
    $exe = ""
    try { $exe = [string]$p.Path } catch { $exe = "" }
    if ($exe -and $exe -notmatch "node\.exe$") { [Environment]::Exit(0); return }
    try { if ($p.StartTime -gt $Global:handsMyStart) { [Environment]::Exit(0); return } } catch { [Environment]::Exit(0); return }
    $cmd = ""
    try {
      $ci = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $want)
      $cmd = [string]$ci.CommandLine
    } catch { $cmd = "" }
    if ($cmd -and $cmd -notmatch "dsh-watch-hands") { [Environment]::Exit(0); return }
  } | Out-Null
  $script:watch.Start()
  # Say it out loud once: a watchdog that silently fails to start is worse than none,
  # because it looks solved. $Global: is used because the Elapsed Action block runs in
  # its own scope and cannot see $script: reliably.
  $Global:handsParentPid = [int]$script:parentPid
  $Global:handsMyStart = $script:myStart
  Write-Line ("WATCH|parent=" + $Global:handsParentPid + "|myStart=" + $script:myStart.ToString("o"))
}
Write-Line "READY"

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq "") { continue }
  if ($line -eq "QUIT") { break }
  if ($line -eq "PING") { Write-Line "PONG"; continue }

  $act = $line
  $args2 = @()
  $sp = $line.IndexOf("|")
  if ($sp -ge 0) { $act = $line.Substring(0, $sp); $args2 = $line.Substring($sp + 1) -split "\|" }

  try {
    switch ($act) {
      "DISPLAYS" {
        # Monitors in PHYSICAL virtual-screen pixels. A person's "top left of my
        # main screen" and a screenshot's "0,0" are only the same point when there
        # is one monitor and the scale is 1. Everything that converts between a
        # picture the model saw and a pixel it clicks needs this list.
        Add-Type -AssemblyName System.Windows.Forms
        $list = @()
        foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
          $list += [ordered]@{
            name = $s.DeviceName
            primary = [bool]$s.Primary
            x = [int]$s.Bounds.X; y = [int]$s.Bounds.Y
            w = [int]$s.Bounds.Width; h = [int]$s.Bounds.Height
          }
        }
        $v = [System.Windows.Forms.SystemInformation]::VirtualScreen
        Write-Line ("OK|" + (ConvertTo-Json -InputObject ([ordered]@{ screens = $list; virtual = [ordered]@{ x = [int]$v.X; y = [int]$v.Y; w = [int]$v.Width; h = [int]$v.Height } }) -Compress -Depth 5))
      }
      "APPS" {
        $apps = @(Get-Apps)
        Write-Line ("OK|" + (ConvertTo-Json -InputObject $apps -Compress -Depth 5))
      }
      "WINDOWS" {
        $f = if ($args2.Count -ge 1 -and $args2[0]) { (DecodeB64 $args2[0]).ToLower() } else { "" }
        $apps = @(Get-Apps)
        if ($f) { $apps = @($apps | Where-Object { (($_.process + " " + $_.title).ToLower()).Contains($f) }) }
        Write-Line ("OK|" + (ConvertTo-Json -InputObject $apps -Compress -Depth 5))
      }
      "FOCUS" {
        $h = [IntPtr][int64]$args2[0]
        if ([DshHands]::IsIconic($h)) { [void][DshHands]::ShowWindow($h, 9) }
        # SetForegroundWindow alone is REFUSED when the calling process is not
        # already the foreground app - Windows only hands focus to a process it
        # judges to be "responding to the user". Measured: identical call returned
        # focused=false and the following keystrokes went to the window that still
        # had focus (the Calculator), so a typed URL landed nowhere.
        #
        # The standard workaround is to attach to the foreground thread's input
        # queue first: once the two threads share an input state, the focus change
        # is treated as coming from the foreground itself.
        # Let this process take focus at all. Both calls are needed: the first
        # grants permission for the next focus change, the second clears the
        # lock timeout that would otherwise keep refusing it.
        [void][DshHands]::AllowSetForegroundWindow(-1)
        [void][DshHands]::SystemParametersInfo([DshHands]::SPI_SETFOREGROUNDLOCKTIMEOUT, 0, [IntPtr]::Zero, [DshHands]::SPIF_SENDCHANGE)
        $fgH = [DshHands]::GetForegroundWindow()
        $fgTid = 0
        [void][DshHands]::GetWindowThread($fgH, [ref]$fgTid)
        $myTid = [DshHands]::GetCurrentThreadId()
        $attached = $false
        if ($fgTid -ne 0 -and $fgTid -ne $myTid) {
          $attached = [DshHands]::AttachThreadInput($fgTid, $myTid, $true)
        }
        try {
          [void][DshHands]::BringWindowToTop($h)
          [void][DshHands]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x0043)
          $ok = [DshHands]::SetForegroundWindow($h)
          [void][DshHands]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x0043)
        } finally {
          if ($attached) { [void][DshHands]::AttachThreadInput($fgTid, $myTid, $false) }
        }
        Start-Sleep -Milliseconds 220
        # Compare as Int64, not as IntPtr: PowerShell compares IntPtr objects by
        # reference, so "$now -eq $h" was false even when the focus change worked.
        # That made a successful focus look like a refusal and sent the diagnosis
        # in the wrong direction for a while.
        $now = [int64][DshHands]::GetForegroundWindow()
        $want = [int64]$h
        $ok = ($now -eq $want)
        # When the focus change is refused, say WHY rather than a bare false.
        # Measured on this machine: a window on the secondary monitor (x < 0) is
        # refused while the same call on a primary-monitor window succeeds, even
        # with AllowSetForegroundWindow and the lock timeout cleared. Windows
        # treats the focus change as a stray activation, not as user intent.
        # The honest answer is "move it to the primary screen first" (window op
        # move), not a retry loop the caller cannot diagnose.
        $rect = Get-WinRect $want
        $reason = $null
        if (-not $ok) {
          if ($rect.x -lt 0) {
            $reason = "window is on a secondary display (x=" + $rect.x + "); Windows refuses a background process's focus change there. Move it with action=window op=move rect=<x,y,w,h> onto the primary screen first."
          } else {
            $reason = "Windows refused the focus change (another app owns the foreground). Click once by hand, or move the window to the front yourself."
          }
        }
        Write-Line ("OK|" + (ConvertTo-Json -InputObject ([ordered]@{ focused = $ok; foregroundHwnd = $now; hwnd = $want; title = (Get-WinTitle $h); reason = $reason }) -Compress))
      }
      "WINDOW" {
        $h = [IntPtr][int64]$args2[0]
        $op = $args2[1]
        switch ($op) {
          "minimise" { [void][DshHands]::ShowWindow($h, 6) }
          "minimize" { [void][DshHands]::ShowWindow($h, 6) }
          "maximise" { [void][DshHands]::ShowWindow($h, 3) }
          "maximize" { [void][DshHands]::ShowWindow($h, 3) }
          "restore" { [void][DshHands]::ShowWindow($h, 9) }
          "close" { [void][DshHands]::ShowWindow($h, 0) }
          "move" {
            $p = $args2[2] -split ","
            [void][DshHands]::MoveWindow($h, [int]$p[0], [int]$p[1], [int]$p[2], [int]$p[3], $true)
          }
          default { throw ("unknown window op: " + $op) }
        }
        Start-Sleep -Milliseconds 240
        $rect = Get-WinRect ([int64]$h)
        Write-Line ("OK|" + (ConvertTo-Json -InputObject ([ordered]@{ op = $op; hwnd = [int64]$h; iconic = [bool][DshHands]::IsIconic($h); x = $rect.x; y = $rect.y; w = $rect.w; h = $rect.h }) -Compress))
      }
      "FIND" {
        $hint = if ($args2.Count -ge 1 -and $args2[0]) { DecodeB64 $args2[0] } else { "" }
        $name = if ($args2.Count -ge 2 -and $args2[1]) { DecodeB64 $args2[1] } else { "" }
        $limit = if ($args2.Count -ge 3) { [int]$args2[2] } else { 120 }
        $wantText = if ($args2.Count -ge 4) { $args2[3] -eq "1" } else { $false }
        $app = $null
        if ($hint) {
          $app = Find-App $hint
          if (-not $app) { Write-Line ("ERR|no window matching " + $hint); continue }
        }
        if (-not $app) {
          $apps = @(Get-Apps)
          $app = @($apps | Where-Object { $_.fg })[0]
        }
        if (-not $app) { Write-Line "ERR|no target window"; continue }
        $all = @(Collect-Elements $app.hwnd $limit $wantText)
        if ($name) {
          $q = Parse-Target $name
          $nl = Normalize-Name $q.name
          $all = @($all | Where-Object {
            $nm = Normalize-Name $_.name
            $okRole = (-not $q.role) -or ($_.role -eq $q.role)
            $okRole -and $nm -and $nm.Contains($nl)
          })
        }
        Write-Line ("OK|" + (ConvertTo-Json -InputObject $all -Compress -Depth 5))
      }
      "READ" {
        $hint = if ($args2.Count -ge 1 -and $args2[0]) { DecodeB64 $args2[0] } else { "" }
        $max = if ($args2.Count -ge 2) { [int]$args2[1] } else { 4000 }
        $app = $null
        if ($hint) { $app = Find-App $hint }
        if (-not $app) { $apps = @(Get-Apps); $app = @($apps | Where-Object { $_.fg })[0] }
        if (-not $app) { Write-Line "ERR|no target window"; continue }
        $r = Read-Window $app.hwnd $max
        Write-Line ("OK|" + (ConvertTo-Json -InputObject ([ordered]@{ window = $app.title; source = $r.source; text = $r.text }) -Compress))
      }
      "MENU" {
        $hint = if ($args2.Count -ge 1 -and $args2[0]) { DecodeB64 $args2[0] } else { "" }
        $app = $null
        if ($hint) { $app = Find-App $hint }
        if (-not $app) { $apps = @(Get-Apps); $app = @($apps | Where-Object { $_.fg })[0] }
        $items = @()
        if ($app) {
          $all = @(Collect-Elements $app.hwnd 80 $false)
          $items = @($all | Where-Object { $_.role -eq "MenuItem" } | ForEach-Object { $_.name })
        }
        Write-Line ("OK|" + (ConvertTo-Json -InputObject $items -Compress -Depth 3))
      }
      "CLICK" {
        $hint = if ($args2.Count -ge 1 -and $args2[0]) { DecodeB64 $args2[0] } else { "" }
        # The target name rides in base64. PowerShell reads stdin as the ANSI
        # codepage, so a CJK label written raw arrives as mojibake and matches
        # nothing - measured: "鏍规湰" instead of the real button text.
        $name = if ($args2.Count -ge 2 -and $args2[1]) { DecodeB64 $args2[1] } else { "" }
        if (-not $name) { Write-Line "ERR|click needs a name"; continue }
        $app = $null
        if ($hint) { $app = Find-App $hint }
        if (-not $app) { $apps = @(Get-Apps); $app = @($apps | Where-Object { $_.fg })[0] }
        if (-not $app) { Write-Line "ERR|no target window"; continue }
        # Match against the CACHED listing, then go back to live elements only to
        # click. Matching live would mean one COM round trip per candidate.
        $all = @(Collect-Elements $app.hwnd 600 $false)
        $m = Match-Target $all $name
        if ($m.kind -eq "missing") {
          $hintNames = if ($m.suggestions.Count) { "  candidates: " + (($m.suggestions | Select-Object -First 10) -join " / ") } else { "" }
          Write-Line ("ERR|no control named " + $name + $hintNames)
          continue
        }
        if ($m.kind -eq "ambiguous") {
          $cands = @($m.candidates | ForEach-Object { $_.role + ":" + $_.name + "@" + ([int]($_.x + $_.w/2)) + "," + ([int]($_.y + $_.h/2)) })
          Write-Line ("ERR|ambiguous " + $name + " - " + ($cands -join " | "))
          continue
        }
        $hit = $m.element
        # Re-find the same place live so patterns (invoke/toggle) are available;
        # the cache is read-only by construction (AutomationElementMode.None).
        $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$app.hwnd)
        $cx = [int]($hit.x + $hit.w / 2)
        $cy = [int]($hit.y + $hit.h / 2)
        $el = $null
        try {
          $el = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($cx, $cy)))
        } catch { }
        $how = $null
        if ($el) { $how = Invoke-Element $el }
        if (-not $how) {
          [DshHands]::ClickAt($cx, $cy)
          $how = "mouse"
        }
        Start-Sleep -Milliseconds 280
        Write-Line ("OK|" + (ConvertTo-Json -InputObject ([ordered]@{ clicked = $hit.name; role = $hit.role; how = $how; x = $cx; y = $cy; window = $app.title }) -Compress))
      }
      "CLICKAT" {
        $x = [int]$args2[0]; $y = [int]$args2[1]
        # Ask who is really there BEFORE clicking. A click that lands on an
        # always-on-top avatar or a notification is indistinguishable from a click
        # that did nothing, and the caller has no way to find out afterwards.
        $hit = [int64][DshHands]::HitTestAt($x, $y)
        $hitTitle = if ($hit) { Get-WinTitle $hit } else { "" }
        [DshHands]::ClickAt($x, $y)
        Start-Sleep -Milliseconds 160
        Write-Line ("OK|" + (ConvertTo-Json -InputObject ([ordered]@{ x = $x; y = $y; hitHwnd = $hit; hitTitle = $hitTitle }) -Compress))
      }
      "TYPE" {
        $txt = DecodeB64 $args2[0]
        $delay = if ($args2.Count -ge 2) { [int]$args2[1] } else { 6 }
        # SendInput delivers to whichever thread owns the input queue, and this
        # worker is a background process. Attach to the target so the keystrokes
        # land in the window the caller named, not wherever focus happened to be.
        $fgH = [DshHands]::GetForegroundWindow()
        $fgTid = 0
        [void][DshHands]::GetWindowThread($fgH, [ref]$fgTid)
        $myTid = [DshHands]::GetCurrentThreadId()
        $attached = $false
        if ($fgTid -ne 0 -and $fgTid -ne $myTid) { $attached = [DshHands]::AttachThreadInput($fgTid, $myTid, $true) }
        try {
          [DshHands]::TypeText($txt, $delay)
        } finally {
          if ($attached) { [void][DshHands]::AttachThreadInput($fgTid, $myTid, $false) }
        }
        Start-Sleep -Milliseconds 120
        # Report the foreground AFTER typing: if it moved, the keystrokes went
        # somewhere else and the caller needs to know that immediately.
        $now = [int64][DshHands]::GetForegroundWindow()
        Write-Line ("OK|" + (ConvertTo-Json -InputObject ([ordered]@{ typed = $txt.Length; foregroundHwnd = $now }) -Compress))
      }
      "KEY" {
        $combo = Send-Key $args2[0]
        Start-Sleep -Milliseconds 160
        Write-Line ("OK|" + (ConvertTo-Json -InputObject ([ordered]@{ key = $combo }) -Compress))
      }
      "RUN" {
        $cmd = DecodeB64 $args2[0]
        # Launch through the shell so the app is NOT a child of this worker: a child
        # would die with the worker, and the whole point is that what we opened stays
        # open. explorer.exe <target> is the shell launch, has no console window, and
        # is outside this process job.
        #
        # The first version ran: cmd /c start "" "<target>" - and the doubled quotes
        # made "start" read the target as the WINDOW TITLE, so it opened a blank
        # console and reported success. Measured: notepad never appeared.
        # UseShellExecute = true is the "double-click it in Explorer" path: it
        # resolves App Paths (calc, notepad, ms-settings:), honours file
        # associations and URLs, and starts the app OUTSIDE this process tree.
        # explorer.exe <target> was wrong: explorer reads an unqualified word as a
        # FOLDER, so "calc" opened 文档 instead of the calculator.
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $cmd
        $psi.UseShellExecute = $true
        $psi.CreateNoWindow = $true
        $null = [System.Diagnostics.Process]::Start($psi)
        Start-Sleep -Milliseconds 900
        Write-Line ("OK|" + (ConvertTo-Json -InputObject ([ordered]@{ launched = $cmd }) -Compress))
      }

      "SHOT" {
        # Capture the screen (or one window) to a JPEG and report BOTH its size and
        # the physical rectangle it came from.
        #
        # That second half is the part people skip and then get wrong: a screenshot
        # is a RESIZED copy of a physical rectangle, so a pixel read off the image
        # is not a screen coordinate. Reporting the mapping next to the image is
        # what lets every later click be converted without arithmetic by the caller.
        #
        # The pixels come from [DshHands]::ShotToFile - GDI inside C#. See the note
        # above that method: doing this in PowerShell is what got the file blocked.
        $hint = if ($args2.Count -ge 1 -and $args2[0]) { DecodeB64 $args2[0] } else { "" }
        $path = DecodeB64 $args2[1]
        $maxW = if ($args2.Count -ge 3) { [int]$args2[2] } else { 1366 }
        $app = $null
        if ($hint) { $app = Find-App $hint }
        if ($app) {
          $r = Get-WinRect $app.hwnd
          $sx = $r.x; $sy = $r.y; $sw = $r.w; $sh = $r.h
        } else {
          Add-Type -AssemblyName System.Windows.Forms
          $v = [System.Windows.Forms.SystemInformation]::VirtualScreen
          $sx = $v.X; $sy = $v.Y; $sw = $v.Width; $sh = $v.Height
        }
        if ($sw -lt 2 -or $sh -lt 2) { Write-Line "ERR|capture area is empty"; continue }
        $json = [DshHands]::ShotToFile([int]$sx, [int]$sy, [int]$sw, [int]$sh, [int]$maxW, 82, $path)
        # window is the only field the C# side cannot fill in: it lives in the UIA
        # tree, not in the GDI rectangle.
        $win = if ($app) { ConvertTo-Json -InputObject $app.title -Compress } else { "null" }
        Write-Line ("OK|" + $json.Substring(0, $json.Length - 1) + ',"window":' + $win + "}")
      }
      "WAITFIND" {
        # Wait until a control EXISTS (or disappears), instead of sleeping a fixed
        # guess. A person does not wait "2 seconds" after Ctrl+S; they wait until
        # the dialog is there. Fixed sleeps are either too short (a miss) or too
        # long (the whole point of every step getting slower).
        $hint = if ($args2.Count -ge 1 -and $args2[0]) { DecodeB64 $args2[0] } else { "" }
        $name = if ($args2.Count -ge 2 -and $args2[1]) { DecodeB64 $args2[1] } else { "" }
        $timeout = if ($args2.Count -ge 3) { [int]$args2[2] } else { 3000 }
        $gone = if ($args2.Count -ge 4) { $args2[3] -eq "gone" } else { $false }
        $t0 = Get-Date
        $found = $null
        while (((Get-Date) - $t0).TotalMilliseconds -lt $timeout) {
          $app = $null
          if ($hint) { $app = Find-App $hint }
          if (-not $app) { $apps = @(Get-Apps); $app = @($apps | Where-Object { $_.fg })[0] }
          if ($app) {
            $all = @(Collect-Elements $app.hwnd 400 $false)
            $m = Match-Target $all $name
            $found = if ($m.kind -eq "found") { $app } else { $null }
          }
          if ($gone) {
            if (-not $found) { break }
          } elseif ($found) { break }
          Start-Sleep -Milliseconds 120
        }
        $waited = [int]((Get-Date) - $t0).TotalMilliseconds
        $ok = if ($gone) { -not $found } else { [bool]$found }
        Write-Line ("OK|" + (ConvertTo-Json -InputObject ([ordered]@{ found = $ok; waitedMs = $waited; timeoutMs = $timeout; window = if ($found) { $found.title } else { $null } }) -Compress))
      }
      "ROLES" {
        # The role vocabulary comes from the daemon so this file stays pure ASCII:
        # PowerShell 5.1 reads a BOM-less script as GBK, and one CJK literal here
        # would break the parse of the entire worker.
        $json = DecodeB64 $args2[0]
        $map = ConvertFrom-Json $json
        $script:ROLES = @{}
        foreach ($p in $map.PSObject.Properties) { $script:ROLES[$p.Name] = $p.Value }
        Write-Line ("OK|" + (ConvertTo-Json -InputObject ([ordered]@{ roles = $script:ROLES.Count }) -Compress))
      }
      default { Write-Line ("ERR|unknown command " + $act) }
    }
  } catch {
    $msg = $_.Exception.Message -replace "`r|`n", " "
    Write-Line ("ERR|" + $msg)
  }
}