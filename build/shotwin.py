import ctypes, sys
from ctypes import wintypes
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass
u = ctypes.windll.user32
g = ctypes.windll.gdi32

part = sys.argv[1]
out = sys.argv[2]
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
    if part in buf.value:
        hits.append((hwnd, buf.value))
    return True
u.EnumWindows(cb, 0)
if not hits:
    print("NOT-FOUND")
    sys.exit(2)
hwnd, title = hits[-1]
r = wintypes.RECT()
u.GetWindowRect(hwnd, ctypes.byref(r))
x, y, w, h = r.left, r.top, r.right - r.left, r.bottom - r.top
print("TITLE", title, "RECT", x, y, w, h)

# 全屏 DC 截图再裁：窗口是透明/亚克力，GetWindowDC 会全黑
hdc = u.GetDC(0)
mem = g.CreateCompatibleDC(hdc)
bmp = g.CreateCompatibleBitmap(hdc, w, h)
g.SelectObject(mem, bmp)
g.BitBlt(mem, 0, 0, w, h, hdc, x, y, 0x00CC0020)

class BIH(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", ctypes.c_long),
                ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]
bi = BIH(); bi.biSize = ctypes.sizeof(BIH); bi.biWidth = w; bi.biHeight = -h
bi.biPlanes = 1; bi.biBitCount = 32; bi.biCompression = 0; bi.biSizeImage = w * h * 4
buf = ctypes.create_string_buffer(w * h * 4)
g.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), 0)
open(out, "wb").write(buf.raw)
print("SIZE", w, h)
