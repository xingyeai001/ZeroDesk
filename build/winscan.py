# 列出所有可见顶层窗口：句柄 / PID / 进程名 / 类名 / 标题 / 位置尺寸
import ctypes
import ctypes.wintypes as w

u = ctypes.windll.user32
k = ctypes.windll.kernel32
psapi = ctypes.windll.psapi

WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)


def proc_name(pid):
    h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return '?'
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = w.DWORD(1024)
        if k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value.split('\\')[-1]
        return '?'
    finally:
        k.CloseHandle(h)


def cls(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    u.GetClassNameW(hwnd, buf, 256)
    return buf.value


def title(hwnd):
    buf = ctypes.create_unicode_buffer(512)
    u.GetWindowTextW(hwnd, buf, 512)
    return buf.value


PR = ctypes.Structure
rows = []


def cb(hwnd, lparam):
    if not u.IsWindowVisible(hwnd):
        return True
    r = w.RECT()
    u.GetWindowRect(hwnd, ctypes.byref(r))
    wd, ht = r.right - r.left, r.bottom - r.top
    if wd < 40 or ht < 40:
        return True
    pid = w.DWORD()
    u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    rows.append((hwnd, pid.value, proc_name(pid.value), cls(hwnd), title(hwnd), r.left, r.top, wd, ht))
    return True


u.EnumWindows(WNDENUMPROC(cb), 0)
for hwnd, pid, proc, c, t, left, top, wd, ht in rows:
    print(f'hwnd={hwnd} pid={pid} proc={proc} class={c} rect=({left},{top}) {wd}x{ht} title={t!r}')
print('共 %d 个可见窗口' % len(rows))
