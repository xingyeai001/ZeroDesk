import ctypes, sys, time
from ctypes import wintypes
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # 物理像素，坐标才对得上
except Exception:
    pass
u = ctypes.windll.user32
g = ctypes.windll.gdi32

# 先把启动器窗口最小化，否则它会盖住右下角任务栏
hits = []
@ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
def cb(hwnd, lp):
    if not u.IsWindowVisible(hwnd):
        return True
    n = u.GetWindowTextLengthW(hwnd)
    if n == 0:
        return True
    buf = ctypes.create_unicode_buffer(n + 1)
    u.GetWindowTextW(hwnd, buf, n + 1)
    if "Zero Desk" in buf.value or "桌面分区" in buf.value:
        hits.append(hwnd)
    return True
u.EnumWindows(cb, 0)
for h in hits:
    u.ShowWindow(h, 6)  # SW_MINIMIZE
print("minimized", len(hits))
time.sleep(1.2)

SW, SH = u.GetSystemMetrics(0), u.GetSystemMetrics(1)
w, hh = 420, 64
x, y = SW - w, SH - hh
out = sys.argv[1]
print("screen", SW, SH)

hdc = u.GetDC(0)
mem = g.CreateCompatibleDC(hdc)
bmp = g.CreateCompatibleBitmap(hdc, w, hh)
g.SelectObject(mem, bmp)
g.BitBlt(mem, 0, 0, w, hh, hdc, x, y, 0x00CC0020)

class BIH(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", ctypes.c_long),
                ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]

bi = BIH(); bi.biSize = ctypes.sizeof(BIH); bi.biWidth = w; bi.biHeight = -hh
bi.biPlanes = 1; bi.biBitCount = 32; bi.biCompression = 0; bi.biSizeImage = w * hh * 4
buf = ctypes.create_string_buffer(w * hh * 4)
g.GetDIBits(mem, bmp, 0, hh, buf, ctypes.byref(bi), 0)
open(out, "wb").write(buf.raw)
print("RAW", w, hh)
