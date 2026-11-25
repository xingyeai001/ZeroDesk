# 开发期排障：把屏幕或某个窗口截成标准 BMP（不依赖 Add-Type / tkinter）
#
#   python build/screen_bmp.py out.bmp              # 全屏
#   python build/screen_bmp.py out.bmp "Zero Desk"  # 只截标题含该字符串的窗口
#
# 背景：本机安全策略拦 Add-Type，PIL 也没装；窗口是 frameless/acrylic，
# GetWindowDC 会截出全黑，所以统一"全屏 BitBlt 再裁剪"。
import ctypes, sys, struct
from ctypes import wintypes

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass

u = ctypes.windll.user32
g = ctypes.windll.gdi32

out = sys.argv[1] if len(sys.argv) > 1 else 'out.bmp'
want = sys.argv[2] if len(sys.argv) > 2 else ''

x, y, w, h = 0, 0, 0, 0
title_seen = ''
if want:
    hits = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, lp):
        if not u.IsWindowVisible(hwnd):
            return True
        n = u.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        u.GetWindowTextW(hwnd, buf, n + 1)
        if want in buf.value:
            hits.append((hwnd, buf.value))
        return True

    u.EnumWindows(cb, 0)
    if not hits:
        print('NOT-FOUND')
        sys.exit(2)
    hwnd, title_seen = hits[-1]
    r = wintypes.RECT()
    u.GetWindowRect(hwnd, ctypes.byref(r))
    x, y, w, h = r.left, r.top, r.right - r.left, r.bottom - r.top
else:
    x, y = u.GetSystemMetrics(76), u.GetSystemMetrics(77)      # SM_XVIRTUALSCREEN / SM_YVIRTUALSCREEN
    w, h = u.GetSystemMetrics(78), u.GetSystemMetrics(79)      # 虚拟屏幕宽高

if w <= 0 or h <= 0:
    print('BAD-RECT', x, y, w, h)
    sys.exit(3)

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


bi = BIH()
bi.biSize = ctypes.sizeof(BIH)
bi.biWidth = w
bi.biHeight = -h          # 负数 = top-down，省得再翻转
bi.biPlanes = 1
bi.biBitCount = 32
bi.biCompression = 0
bi.biSizeImage = w * h * 4
buf = ctypes.create_string_buffer(w * h * 4)
g.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), 0)
g.DeleteObject(bmp)
g.DeleteDC(mem)
u.ReleaseDC(0, hdc)

# 32bpp BI_RGB 的 BMP 文件头（14 字节）+ 信息头（40 字节）
info = struct.pack('<IiiHHIIiiII', 40, w, -h, 1, 32, 0, w * h * 4, 0, 0, 0, 0)
with open(out, 'wb') as f:
    f.write(b'BM' + struct.pack('<IHHI', 14 + 40 + len(buf.raw), 0, 0, 14 + 40))
    f.write(info)
    f.write(buf.raw)

print('OK', out, w, h, ('title=' + title_seen) if title_seen else 'fullscreen')
