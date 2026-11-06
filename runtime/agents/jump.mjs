import { execFile } from 'node:child_process';

// Brings the user to a session: the Ghostty tab whose terminal sits in the
// session's folder, or the thread in the Codex app. macOS asks once whether
// the pet may control Ghostty.
const GHOSTTY_ID = 'com.mitchellh.ghostty';
const CODEX_APP_ID = 'com.openai.codex';
// argv: the folder, then words the terminal's title may hold for this tool,
// to choose between tabs open in the same folder.
export const GHOSTTY_SCRIPT = `on run argv
  set target to item 1 of argv
  set hints to rest of argv
  if not (application id "${GHOSTTY_ID}" is running) then return "none"
  tell application id "${GHOSTTY_ID}"
    set exact to {}
    set inside to {}
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in terminals of t
          try
            set d to working directory of s
            if d is target or d is (target & "/") then
              set end of exact to {t, s}
            else if d starts with (target & "/") then
              set end of inside to {t, s}
            end if
          end try
        end repeat
      end repeat
    end repeat
    set found to exact
    if found is {} then set found to inside
    if found is {} then
      activate
      return "app"
    end if
    set pick to item 1 of found
    set matched to false
    repeat with candidate in found
      if matched then exit repeat
      try
        set tabTitle to name of (item 2 of candidate)
        repeat with h in hints
          if tabTitle contains (h as text) then
            set pick to candidate
            set matched to true
            exit repeat
          end if
        end repeat
      end try
    end repeat
    select tab (item 1 of pick)
    focus (item 2 of pick)
    activate
    return "tab"
  end tell
end run`;
const TITLE_HINTS = { claude: ['Claude', '✳'], codex: ['codex', 'Codex'] };

function psQuote(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
const FOCUS_CS = [
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public static class WhaleFocus {',
  '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
  '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);',
  '  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);',
  '  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }',
  '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
  '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
  '  public static IntPtr FindWindow(uint wanted) {',
  '    IntPtr found = IntPtr.Zero; long best = 0;',
  '    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == wanted) { var sb = new StringBuilder(512); GetWindowText(h, sb, sb.Capacity); var title = sb.ToString(); if (title.Length > 0 && !title.Contains("DDE Server") && !title.Contains("Default IME") && !title.Contains("MSCTFIME") && !title.Contains("GDI+")) { RECT r; GetWindowRect(h, out r); long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top); if (area > best) { best = area; found = h; } } } return true; }, IntPtr.Zero);',
  '    return found;',
  '  }',
  '}',
  '"@',
].join('\n');
function focusPlan({ names, hide = [] }) {
  const namesText = names.map(psQuote).join(',');
  const hideText = hide.map(psQuote).join(',');
  const script = [
    FOCUS_CS,
    '$target = $null; $targetH = [IntPtr]::Zero',
    'foreach ($name in @(' + namesText + ')) { foreach ($proc in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) { if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { $target = $proc; $targetH = $proc.MainWindowHandle; break } }; if ($target) { break } }',
    'if (-not $target) { foreach ($name in @(' + namesText + ')) { foreach ($proc in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) { $h = [WhaleFocus]::FindWindow([uint32]$proc.Id); if ($h -ne [IntPtr]::Zero) { $target = $proc; $targetH = $h; break } }; if ($target) { break } } }',
    'if (-not $target) { Write-Output "none"; return }',
    'foreach ($name in @(' + hideText + ')) { foreach ($proc in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) { $h = $proc.MainWindowHandle; if ($h -eq [IntPtr]::Zero) { $h = [WhaleFocus]::FindWindow([uint32]$proc.Id) }; if ($h -ne [IntPtr]::Zero) { [void][WhaleFocus]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x13); [void][WhaleFocus]::ShowWindowAsync($h, 0); break } } }',
    '$fg = [WhaleFocus]::GetForegroundWindow(); [uint32]$fgPid = 0',
    '$fgThread = [WhaleFocus]::GetWindowThreadProcessId($fg, [ref]$fgPid); $cur = [WhaleFocus]::GetCurrentThreadId()',
    '[void][WhaleFocus]::AttachThreadInput($cur, $fgThread, $true)',
    '[void][WhaleFocus]::ShowWindowAsync($targetH, 9)',
    'Start-Sleep -Milliseconds 200',
    '[void][WhaleFocus]::SetWindowPos($targetH, [IntPtr](-1), 0, 0, 0, 0, 0x43)',
    '[void][WhaleFocus]::BringWindowToTop($targetH)',
    '[void][WhaleFocus]::SetForegroundWindow($targetH)',
    '[void][WhaleFocus]::SetActiveWindow($targetH)',
    '[void][WhaleFocus]::SetFocus($targetH)',
    '[WhaleFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [WhaleFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)',
    '[void][WhaleFocus]::SetForegroundWindow($targetH)',
    '[void][WhaleFocus]::SwitchToThisWindow($targetH, $true)',
    'Start-Sleep -Milliseconds 700',
    '$fgAfter = [WhaleFocus]::GetForegroundWindow()',
    '[void][WhaleFocus]::SetWindowPos($targetH, [IntPtr](-2), 0, 0, 0, 0, 0x13)',
    '[void][WhaleFocus]::AttachThreadInput($cur, $fgThread, $false)',
    '$pt = New-Object WhaleFocus+POINT; $pt.X = [WhaleFocus]::GetSystemMetrics(0) / 2; $pt.Y = [WhaleFocus]::GetSystemMetrics(1) / 2',
    '$top = [WhaleFocus]::WindowFromPoint($pt); [uint32]$topPid = 0',
    '[void][WhaleFocus]::GetWindowThreadProcessId($top, [ref]$topPid)',
    'if ($fgAfter -eq $targetH -or $top -eq $targetH -or $topPid -eq $target.Id) { Write-Output "focused" } else { Write-Output "not-focused" }',
  ].join('\n');
  return { kind: 'focus', command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-NonInteractive', '-Command', script] };
}
function dshFocusPlan() { return focusPlan({ names: ['DeepSeek Harness'] }); }
function codexFocusPlan() { return focusPlan({ names: ['ChatGPT', 'Codex'] }); }

export function jumpPlan(row, platform = process.platform) {
  if (!row) return null;
  // DSH has one desktop window; dsh://open focuses it. There is no public
  // per-session deep link, so the workbench detail is the precise view.
  if (row.tool === 'dsh') {
    if (platform === 'darwin') return { kind: 'dsh-open', command: 'open', args: ['dsh://open'] };
    if (platform === 'win32') return { kind: 'dsh-open', command: 'cmd.exe', args: ['/d', '/s', '/c', 'start "" "dsh://open"'], verbatim: true };
    return { kind: 'dsh-open', command: 'xdg-open', args: ['dsh://open'] };
  }
  if (row.tool === 'codex') {
    const thread = row.sessionId || (String(row.id).startsWith('codex:') ? String(row.id).slice(6) : '');
    if ((row.app || row.source === 'dispatched') && thread) {
      const url = 'codex://threads/' + encodeURIComponent(thread);
      if (platform === 'darwin') return { kind: 'codex-app', command: 'open', args: [url] };
      if (platform === 'win32') return { kind: 'codex-app', command: 'cmd.exe', args: ['/d', '/s', '/c', 'start "" "' + url + '"'], verbatim: true };
    }
  }
  if (platform !== 'darwin') return null;
  if (!row.cwd) return null;
  return { kind: 'ghostty', command: 'osascript', args: ['-e', GHOSTTY_SCRIPT, row.cwd, ...(TITLE_HINTS[row.tool] || [])] };
}

const runFile = (command, args, { timeout = 30000, windowsVerbatimArguments = false } = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout, encoding: 'utf8', windowsVerbatimArguments, windowsHide: true }, (error, stdout, stderr) => {
    if (error) { error.stderr = stderr; reject(error); } else resolve(stdout);
  });
});

export async function jumpTo(row, { run = runFile, platform = process.platform } = {}) {
  if (platform === 'win32' && row?.tool === 'dsh') {
    const focus = dshFocusPlan();
    try {
      const output = String(await run(focus.command, focus.args, { timeout: 10000 })).trim();
      if (output === 'focused') {
        return { ok: true, target: 'dsh', message: row.source === 'dispatched' || row.taskId
          ? '已切到 DSH 窗口；headless 任务不会出现在它的侧边栏，详情以工作台为准'
          : '已切到 DSH 窗口' };
      }
    } catch {}
    // Do not fall back to dsh://open here: it can change/close the session the
    // user is currently looking at. If the existing window cannot be focused,
    // report it and leave DSH alone.
    return { ok: false, error: '没能切到 DSH 窗口：请确认 DSH 还开着，并让工作台保持在前台' };
  }
  if (platform === 'win32' && row?.tool === 'codex') {
    // App-level switch only: current Codex pages live in the ChatGPT window.
    // Do not interpret codex:// or open a new terminal; that is a different
    // semantic and is not reliable on this install.
    try {
      const focus = codexFocusPlan();
      const output = String(await run(focus.command, focus.args, { timeout: 10000 })).trim();
      if (output === 'focused') return { ok: true, target: 'codex-app', message: '已切到 Codex 窗口' };
    } catch {}
    return { ok: false, error: '没能切到 Codex 窗口：请确认 ChatGPT/Codex 窗口还开着，并让工作台保持在前台' };
  }
  const plan = jumpPlan(row, platform);
  if (!plan) return { ok: false, error: platform === 'darwin' ? '不知道这个会话在哪个文件夹' : '跳转目前只支持 macOS' };
  try {
    const output = String(await run(plan.command, plan.args, { timeout: 30000, windowsVerbatimArguments: plan.verbatim === true })).trim();
    if (plan.kind === 'dsh-open') return { ok: true, target: 'dsh' };
    if (plan.kind === 'codex-app') return { ok: true, target: 'codex-app' };
    if (output === 'tab') return { ok: true, target: 'tab' };
    if (output === 'app') return { ok: true, target: 'app', message: '没找到这个文件夹的标签，已切到 Ghostty' };
    return { ok: false, error: 'Ghostty 没有在运行' };
  } catch (error) {
    if (plan.kind === 'dsh-open') return { ok: false, error: '没能打开 DSH' };
    if (plan.kind === 'codex-app') {
      try { await run('open', ['-b', CODEX_APP_ID], { timeout: 10000 }); return { ok: true, target: 'codex-app' }; } catch {}
      return { ok: false, error: '没能打开 Codex 应用' };
    }
    if (/-1743|not authori[sz]ed|不允许/i.test(String(error?.stderr || '') + String(error?.message || ''))) {
      return { ok: false, error: '需要允许大肥鱼控制 Ghostty：系统设置 › 隐私与安全性 › 自动化' };
    }
    return { ok: false, error: '没能切到 Ghostty' };
  }
}
