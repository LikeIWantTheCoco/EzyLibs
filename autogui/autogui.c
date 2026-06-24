/* ═══════════════════════════════════════════════════════════════
   autogui — keyboard & mouse automation for Ezy.

   Cross-platform: the desktop backend is chosen at compile time.
       Linux   → X11 (Xlib + XTEST)        X11 headers
       Windows → Win32 API                 windows.h
       macOS   → CoreGraphics / Quartz      ApplicationServices

   Every public agui_* function is platform-independent and delegates to
   a small set of per-OS `plat_*` primitives defined in the matching
   #ifdef block below. Screenshot encoders (BMP + PNG) are shared and
   operate on a plain RGB888 buffer produced by plat_grab().

       import "autogui"
       fn main():
       {
           agui_move(400, 300)
           agui_click(1)
           agui_type("hola")
           agui_screenshot_full_png("shot.png")
       }

   Mouse buttons: 1 left, 2 middle, 3 right, 4 wheel-up, 5 wheel-down.
   Coordinates are absolute screen pixels (top-left = 0,0).

   Build:
     Linux:   gcc -shared -fPIC autogui.c -o libautogui.so -lX11 -lXtst
     Windows: gcc -shared autogui.c -o autogui.dll -lgdi32 -luser32
     macOS:   clang -shared autogui.c -o libautogui.dylib \
                    -framework ApplicationServices -framework CoreFoundation
   ═══════════════════════════════════════════════════════════════ */
#include <string.h>
#include <strings.h>
#include <ctype.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdint.h>
#include <time.h>
#include <math.h>

#if defined(_WIN32)
  #define AGUI_WINDOWS 1
  #include <windows.h>
#elif defined(__APPLE__)
  #define AGUI_MACOS 1
  #include <ApplicationServices/ApplicationServices.h>
#else
  #define AGUI_LINUX 1
  #include <X11/Xlib.h>
  #include <X11/Xutil.h>
  #include <X11/Xatom.h>
  #include <X11/keysym.h>
  #include <X11/extensions/XTest.h>
#endif

/* portable millisecond sleep */
static void agui_msleep(long long ms) {
    if (ms <= 0) return;
#if AGUI_WINDOWS
    Sleep((DWORD)ms);
#else
    struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
    nanosleep(&ts, NULL);
#endif
}

/* ════════════════════════════════════════════════════════════════
   Platform primitives (static). Each backend implements:
     int  plat_move(int x,int y)        int  plat_move_rel(int dx,int dy)
     int  plat_mouse_pos(int*x,int*y)   int  plat_button(int btn,int down)
     int  plat_scroll(int n)            int  plat_key(const char*name,int down)
     int  plat_type_char(long cp)       int  plat_screen(int*w,int*h)
     long plat_pixel(int x,int y)       unsigned char* plat_grab(x,y,w,h,*ow,*oh)
     char* plat_active_window(void)
   plat_pixel returns 0xRRGGBB or -1. plat_grab returns a malloc'd RGB888
   buffer (row-major, top-down) of *ow x *oh, or NULL.
   ════════════════════════════════════════════════════════════════ */

/* ────────────────────────── LINUX / X11 ────────────────────────── */
#if AGUI_LINUX
static Display *g_dpy = NULL;
static Display *xdpy(void) { if (!g_dpy) g_dpy = XOpenDisplay(NULL); return g_dpy; }

static KeySym name_keysym(const char *name) {
    if (!name || !*name) return NoSymbol;
    static const struct { const char *a; const char *r; } map[] = {
        {"enter","Return"},{"return","Return"},{"esc","Escape"},{"escape","Escape"},
        {"tab","Tab"},{"space","space"},{"spacebar","space"},{"backspace","BackSpace"},
        {"bksp","BackSpace"},{"del","Delete"},{"delete","Delete"},{"ins","Insert"},
        {"home","Home"},{"end","End"},{"pgup","Prior"},{"pageup","Prior"},
        {"pgdn","Next"},{"pagedown","Next"},{"up","Up"},{"down","Down"},
        {"left","Left"},{"right","Right"},{"ctrl","Control_L"},{"control","Control_L"},
        {"alt","Alt_L"},{"shift","Shift_L"},{"super","Super_L"},{"win","Super_L"},
        {"cmd","Super_L"},{"meta","Meta_L"},{"capslock","Caps_Lock"},{"caps","Caps_Lock"},
        {NULL,NULL} };
    for (int i = 0; map[i].a; i++)
        if (strcasecmp(name, map[i].a) == 0) return XStringToKeysym(map[i].r);
    if (name[1] == '\0') return (KeySym)(unsigned char)name[0];
    return XStringToKeysym(name);
}

static int plat_move(int x, int y) {
    Display *d = xdpy(); if (!d) return -1;
    XTestFakeMotionEvent(d, DefaultScreen(d), x, y, CurrentTime); XFlush(d); return 0;
}
static int plat_move_rel(int dx, int dy) {
    Display *d = xdpy(); if (!d) return -1;
    XTestFakeRelativeMotionEvent(d, dx, dy, CurrentTime); XFlush(d); return 0;
}
static int plat_mouse_pos(int *x, int *y) {
    Display *d = xdpy(); if (!d) return -1;
    Window r = DefaultRootWindow(d), rr, cr; int rx, ry, wx, wy; unsigned int m;
    if (!XQueryPointer(d, r, &rr, &cr, &rx, &ry, &wx, &wy, &m)) return -1;
    *x = rx; *y = ry; return 0;
}
static int plat_button(int btn, int down) {
    Display *d = xdpy(); if (!d) return -1;
    XTestFakeButtonEvent(d, (unsigned)btn, down ? True : False, CurrentTime);
    XFlush(d); return 0;
}
static int plat_scroll(int n) {
    int btn = n >= 0 ? 4 : 5, steps = n >= 0 ? n : -n;
    for (int i = 0; i < steps; i++) {
        if (plat_button(btn, 1) < 0) return -1;
        plat_button(btn, 0);
    }
    return 0;
}
static int plat_key(const char *name, int down) {
    Display *d = xdpy(); if (!d) return -1;
    KeySym ks = name_keysym(name); if (ks == NoSymbol) return -1;
    KeyCode kc = XKeysymToKeycode(d, ks); if (kc == 0) return -1;
    XTestFakeKeyEvent(d, kc, down ? True : False, CurrentTime); XFlush(d); return 0;
}
static int x_needs_shift(long cp) {
    if (cp < 128 && isupper((int)cp)) return 1;
    return cp < 128 && strchr("~!@#$%^&*()_+{}|:\"<>?", (int)cp) != NULL;
}
static int plat_type_char(long cp) {
    Display *d = xdpy(); if (!d) return -1;
    KeySym ks = (KeySym)cp;
    KeyCode kc = XKeysymToKeycode(d, ks); if (kc == 0) return -1;
    int sh = x_needs_shift(cp);
    KeyCode shc = XKeysymToKeycode(d, XK_Shift_L);
    if (sh) XTestFakeKeyEvent(d, shc, True, CurrentTime);
    XTestFakeKeyEvent(d, kc, True, CurrentTime);
    XTestFakeKeyEvent(d, kc, False, CurrentTime);
    if (sh) XTestFakeKeyEvent(d, shc, False, CurrentTime);
    XFlush(d); return 0;
}
static int plat_screen(int *w, int *h) {
    Display *d = xdpy(); if (!d) return -1;
    *w = DisplayWidth(d, DefaultScreen(d));
    *h = DisplayHeight(d, DefaultScreen(d)); return 0;
}
static long plat_pixel(int x, int y) {
    Display *d = xdpy(); if (!d) return -1;
    XImage *img = XGetImage(d, DefaultRootWindow(d), x, y, 1, 1, AllPlanes, ZPixmap);
    if (!img) return -1;
    unsigned long p = XGetPixel(img, 0, 0); XDestroyImage(img);
    return ((p >> 16) & 0xff) << 16 | ((p >> 8) & 0xff) << 8 | (p & 0xff);
}
static unsigned char *plat_grab(int x, int y, int w, int h, int *ow, int *oh) {
    Display *d = xdpy(); if (!d) return NULL;
    XImage *img = XGetImage(d, DefaultRootWindow(d), x, y, w, h, AllPlanes, ZPixmap);
    if (!img) return NULL;
    unsigned char *buf = malloc((size_t)w * h * 3);
    if (!buf) { XDestroyImage(img); return NULL; }
    for (int j = 0; j < h; j++)
        for (int i = 0; i < w; i++) {
            unsigned long p = XGetPixel(img, i, j);
            unsigned char *o = buf + ((size_t)j * w + i) * 3;
            o[0] = (p >> 16) & 0xff; o[1] = (p >> 8) & 0xff; o[2] = p & 0xff;
        }
    XDestroyImage(img);
    *ow = w; *oh = h; return buf;
}
static char *plat_active_window(void) {
    Display *d = xdpy();
    if (!d) { char *e = malloc(1); e[0] = 0; return e; }
    Window root = DefaultRootWindow(d), win = 0;
    Atom na = XInternAtom(d, "_NET_ACTIVE_WINDOW", True);
    if (na != None) {
        Atom t; int f; unsigned long n, after; unsigned char *data = NULL;
        if (XGetWindowProperty(d, root, na, 0, 1, False, XA_WINDOW, &t, &f, &n, &after, &data)
            == Success && data) { win = *(Window *)data; XFree(data); }
    }
    if (!win) { int rev; XGetInputFocus(d, &win, &rev); }
    if (!win || win == None || win == PointerRoot) { char *e = malloc(1); e[0] = 0; return e; }
    Atom nn = XInternAtom(d, "_NET_WM_NAME", True), u8 = XInternAtom(d, "UTF8_STRING", True);
    if (nn != None && u8 != None) {
        Atom t; int f; unsigned long n, after; unsigned char *data = NULL;
        if (XGetWindowProperty(d, win, nn, 0, 1024, False, u8, &t, &f, &n, &after, &data)
            == Success && data) { char *o = strdup((char *)data); XFree(data); return o; }
    }
    char *legacy = NULL;
    if (XFetchName(d, win, &legacy) && legacy) {
        char *o = strdup(legacy); XFree(legacy); return o;
    }
    char *e = malloc(1); e[0] = 0; return e;
}

/* ───────────────────────────── WINDOWS ──────────────────────────── */
#elif AGUI_WINDOWS
static int name_vk(const char *name) {
    if (!name || !*name) return 0;
    struct { const char *a; int vk; } map[] = {
        {"enter",VK_RETURN},{"return",VK_RETURN},{"esc",VK_ESCAPE},{"escape",VK_ESCAPE},
        {"tab",VK_TAB},{"space",VK_SPACE},{"spacebar",VK_SPACE},{"backspace",VK_BACK},
        {"bksp",VK_BACK},{"del",VK_DELETE},{"delete",VK_DELETE},{"ins",VK_INSERT},
        {"home",VK_HOME},{"end",VK_END},{"pgup",VK_PRIOR},{"pageup",VK_PRIOR},
        {"pgdn",VK_NEXT},{"pagedown",VK_NEXT},{"up",VK_UP},{"down",VK_DOWN},
        {"left",VK_LEFT},{"right",VK_RIGHT},{"ctrl",VK_CONTROL},{"control",VK_CONTROL},
        {"alt",VK_MENU},{"shift",VK_SHIFT},{"super",VK_LWIN},{"win",VK_LWIN},
        {"cmd",VK_LWIN},{"capslock",VK_CAPITAL},{"caps",VK_CAPITAL},
        {"f1",VK_F1},{"f2",VK_F2},{"f3",VK_F3},{"f4",VK_F4},{"f5",VK_F5},{"f6",VK_F6},
        {"f7",VK_F7},{"f8",VK_F8},{"f9",VK_F9},{"f10",VK_F10},{"f11",VK_F11},{"f12",VK_F12},
        {NULL,0} };
    for (int i = 0; map[i].a; i++)
        if (_stricmp(name, map[i].a) == 0) return map[i].vk;
    if (name[1] == '\0') {
        char c = name[0];
        if (c >= 'a' && c <= 'z') return c - 'a' + 'A';
        if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
    }
    return 0;
}

static int plat_move(int x, int y) { return SetCursorPos(x, y) ? 0 : -1; }
static int plat_move_rel(int dx, int dy) {
    POINT p; if (!GetCursorPos(&p)) return -1; return SetCursorPos(p.x + dx, p.y + dy) ? 0 : -1;
}
static int plat_mouse_pos(int *x, int *y) {
    POINT p; if (!GetCursorPos(&p)) return -1; *x = p.x; *y = p.y; return 0;
}
static int plat_button(int btn, int down) {
    INPUT in = {0}; in.type = INPUT_MOUSE;
    DWORD f = 0;
    if (btn == 1) f = down ? MOUSEEVENTF_LEFTDOWN   : MOUSEEVENTF_LEFTUP;
    else if (btn == 2) f = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
    else if (btn == 3) f = down ? MOUSEEVENTF_RIGHTDOWN  : MOUSEEVENTF_RIGHTUP;
    else return -1;
    in.mi.dwFlags = f;
    return SendInput(1, &in, sizeof in) ? 0 : -1;
}
static int plat_scroll(int n) {
    INPUT in = {0}; in.type = INPUT_MOUSE;
    in.mi.dwFlags = MOUSEEVENTF_WHEEL;
    in.mi.mouseData = (DWORD)(n * WHEEL_DELTA);
    return SendInput(1, &in, sizeof in) ? 0 : -1;
}
static int plat_key(const char *name, int down) {
    int vk = name_vk(name); if (!vk) return -1;
    INPUT in = {0}; in.type = INPUT_KEYBOARD;
    in.ki.wVk = (WORD)vk;
    if (!down) in.ki.dwFlags = KEYEVENTF_KEYUP;
    return SendInput(1, &in, sizeof in) ? 0 : -1;
}
static int plat_type_char(long cp) {
    /* Unicode injection — layout-independent (BMP only) */
    INPUT in[2] = {0};
    in[0].type = INPUT_KEYBOARD;
    in[0].ki.wScan = (WORD)cp; in[0].ki.dwFlags = KEYEVENTF_UNICODE;
    in[1] = in[0];
    in[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    return SendInput(2, in, sizeof(INPUT)) ? 0 : -1;
}
static int plat_screen(int *w, int *h) {
    *w = GetSystemMetrics(SM_CXSCREEN); *h = GetSystemMetrics(SM_CYSCREEN); return 0;
}
static long plat_pixel(int x, int y) {
    HDC dc = GetDC(NULL); if (!dc) return -1;
    COLORREF c = GetPixel(dc, x, y); ReleaseDC(NULL, dc);
    if (c == CLR_INVALID) return -1;
    return ((long)GetRValue(c) << 16) | ((long)GetGValue(c) << 8) | GetBValue(c);
}
static unsigned char *plat_grab(int x, int y, int w, int h, int *ow, int *oh) {
    HDC screen = GetDC(NULL); if (!screen) return NULL;
    HDC mem = CreateCompatibleDC(screen);
    HBITMAP bmp = CreateCompatibleBitmap(screen, w, h);
    HGDIOBJ old = SelectObject(mem, bmp);
    BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY);

    BITMAPINFO bi = {0};
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;            /* top-down */
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;

    unsigned char *bgra = malloc((size_t)w * h * 4);
    unsigned char *rgb = malloc((size_t)w * h * 3);
    if (bgra && rgb)
        GetDIBits(mem, bmp, 0, h, bgra, &bi, DIB_RGB_COLORS);
    if (bgra && rgb)
        for (size_t i = 0; i < (size_t)w * h; i++) {
            rgb[i*3+0] = bgra[i*4+2]; /* R */
            rgb[i*3+1] = bgra[i*4+1]; /* G */
            rgb[i*3+2] = bgra[i*4+0]; /* B */
        }
    free(bgra);
    SelectObject(mem, old); DeleteObject(bmp); DeleteDC(mem); ReleaseDC(NULL, screen);
    if (!rgb) return NULL;
    *ow = w; *oh = h; return rgb;
}
static char *plat_active_window(void) {
    HWND h = GetForegroundWindow();
    char buf[1024]; buf[0] = 0;
    if (h) GetWindowTextA(h, buf, sizeof buf);
    return strdup(buf);
}

/* ───────────────────────────── macOS ────────────────────────────── */
#elif AGUI_MACOS
static CGPoint mac_pos(void) {
    CGEventRef e = CGEventCreate(NULL);
    CGPoint p = CGEventGetLocation(e);
    CFRelease(e); return p;
}
static int mac_keycode(const char *name) {
    if (!name || !*name) return -1;
    struct { const char *a; int k; } map[] = {
        {"a",0},{"s",1},{"d",2},{"f",3},{"h",4},{"g",5},{"z",6},{"x",7},{"c",8},{"v",9},
        {"b",11},{"q",12},{"w",13},{"e",14},{"r",15},{"y",16},{"t",17},{"o",31},{"u",32},
        {"i",34},{"p",35},{"l",37},{"j",38},{"k",40},{"n",45},{"m",46},
        {"1",18},{"2",19},{"3",20},{"4",21},{"6",22},{"5",23},{"9",25},{"7",26},
        {"8",28},{"0",29},
        {"enter",36},{"return",36},{"tab",48},{"space",49},{"backspace",51},{"bksp",51},
        {"esc",53},{"escape",53},{"del",117},{"delete",117},
        {"home",115},{"end",119},{"pgup",116},{"pageup",116},{"pgdn",121},{"pagedown",121},
        {"left",123},{"right",124},{"down",125},{"up",126},
        {"ctrl",59},{"control",59},{"alt",58},{"shift",56},{"cmd",55},{"super",55},
        {"win",55},{"capslock",57},{"caps",57},
        {"f1",122},{"f2",120},{"f3",99},{"f4",118},{"f5",96},{"f6",97},{"f7",98},
        {"f8",100},{"f9",101},{"f10",109},{"f11",103},{"f12",111},
        {NULL,0} };
    for (int i = 0; map[i].a; i++)
        if (strcasecmp(name, map[i].a) == 0) return map[i].k;
    return -1;
}
static void mac_post_mouse(CGEventType t, CGMouseButton b) {
    CGEventRef e = CGEventCreateMouseEvent(NULL, t, mac_pos(), b);
    CGEventPost(kCGHIDEventTap, e); CFRelease(e);
}
static int plat_move(int x, int y) {
    CGPoint p = CGPointMake(x, y);
    CGEventRef e = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, p, 0);
    CGEventPost(kCGHIDEventTap, e); CFRelease(e); return 0;
}
static int plat_move_rel(int dx, int dy) {
    CGPoint p = mac_pos(); return plat_move((int)p.x + dx, (int)p.y + dy);
}
static int plat_mouse_pos(int *x, int *y) {
    CGPoint p = mac_pos(); *x = (int)p.x; *y = (int)p.y; return 0;
}
static int plat_button(int btn, int down) {
    CGMouseButton b; CGEventType t;
    if (btn == 1)      { b = kCGMouseButtonLeft;   t = down ? kCGEventLeftMouseDown   : kCGEventLeftMouseUp; }
    else if (btn == 2) { b = kCGMouseButtonCenter; t = down ? kCGEventOtherMouseDown  : kCGEventOtherMouseUp; }
    else if (btn == 3) { b = kCGMouseButtonRight;  t = down ? kCGEventRightMouseDown  : kCGEventRightMouseUp; }
    else return -1;
    mac_post_mouse(t, b); return 0;
}
static int plat_scroll(int n) {
    CGEventRef e = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1, n);
    CGEventPost(kCGHIDEventTap, e); CFRelease(e); return 0;
}
static int plat_key(const char *name, int down) {
    int kc = mac_keycode(name); if (kc < 0) return -1;
    CGEventRef e = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)kc, down ? true : false);
    CGEventPost(kCGHIDEventTap, e); CFRelease(e); return 0;
}
static int plat_type_char(long cp) {
    UniChar ch = (UniChar)cp;
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
    CGEventKeyboardSetUnicodeString(down, 1, &ch);
    CGEventPost(kCGHIDEventTap, down); CFRelease(down);
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
    CGEventKeyboardSetUnicodeString(up, 1, &ch);
    CGEventPost(kCGHIDEventTap, up); CFRelease(up);
    return 0;
}
static int plat_screen(int *w, int *h) {
    CGDirectDisplayID id = CGMainDisplayID();
    *w = (int)CGDisplayPixelsWide(id); *h = (int)CGDisplayPixelsHigh(id); return 0;
}
static unsigned char *mac_image_rgb(CGImageRef img, int *ow, int *oh) {
    if (!img) return NULL;
    int w = (int)CGImageGetWidth(img), h = (int)CGImageGetHeight(img);
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    unsigned char *rgba = calloc((size_t)w * h, 4);
    if (!rgba) { CGColorSpaceRelease(cs); return NULL; }
    CGContextRef ctx = CGBitmapContextCreate(rgba, w, h, 8, (size_t)w * 4, cs,
                            kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), img);
    CGContextRelease(ctx); CGColorSpaceRelease(cs);
    unsigned char *rgb = malloc((size_t)w * h * 3);
    if (!rgb) { free(rgba); return NULL; }
    for (size_t i = 0; i < (size_t)w * h; i++) {
        rgb[i*3+0] = rgba[i*4+0]; rgb[i*3+1] = rgba[i*4+1]; rgb[i*3+2] = rgba[i*4+2];
    }
    free(rgba); *ow = w; *oh = h; return rgb;
}
static long plat_pixel(int x, int y) {
    CGImageRef img = CGDisplayCreateImageForRect(CGMainDisplayID(), CGRectMake(x, y, 1, 1));
    int w, h; unsigned char *rgb = mac_image_rgb(img, &w, &h);
    if (img) CFRelease(img);
    if (!rgb) return -1;
    long r = rgb[0], g = rgb[1], b = rgb[2]; free(rgb);
    return (r << 16) | (g << 8) | b;
}
static unsigned char *plat_grab(int x, int y, int w, int h, int *ow, int *oh) {
    CGImageRef img = CGDisplayCreateImageForRect(CGMainDisplayID(), CGRectMake(x, y, w, h));
    unsigned char *rgb = mac_image_rgb(img, ow, oh);
    if (img) CFRelease(img);
    return rgb;
}
static char *plat_active_window(void) {
    char *out = NULL;
    CFArrayRef list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (list) {
        CFIndex n = CFArrayGetCount(list);
        for (CFIndex i = 0; i < n && !out; i++) {
            CFDictionaryRef d = CFArrayGetValueAtIndex(list, i);
            CFNumberRef layer = CFDictionaryGetValue(d, kCGWindowLayer);
            int lv = -1; if (layer) CFNumberGetValue(layer, kCFNumberIntType, &lv);
            if (lv != 0) continue;
            CFStringRef name = CFDictionaryGetValue(d, kCGWindowName);
            if (!name || CFStringGetLength(name) == 0)
                name = CFDictionaryGetValue(d, kCGWindowOwnerName);
            if (name) {
                CFIndex len = CFStringGetMaximumSizeForEncoding(
                    CFStringGetLength(name), kCFStringEncodingUTF8) + 1;
                out = malloc(len); out[0] = 0;
                CFStringGetCString(name, out, len, kCFStringEncodingUTF8);
            }
        }
        CFRelease(list);
    }
    if (!out) { out = malloc(1); out[0] = 0; }
    return out;
}
#endif  /* platform */

/* ════════════════════════════════════════════════════════════════
   Shared image encoders — operate on RGB888 (top-down, row-major).
   ════════════════════════════════════════════════════════════════ */

static int write_bmp(const char *path, const unsigned char *rgb, int w, int h) {
    FILE *f = fopen(path, "wb"); if (!f) return -1;
    int row = w * 3, pad = (4 - (row % 4)) % 4;
    int datasz = (row + pad) * h, filesz = 54 + datasz;
    unsigned char hdr[54] = {0};
    hdr[0]='B'; hdr[1]='M';
    hdr[2]=filesz; hdr[3]=filesz>>8; hdr[4]=filesz>>16; hdr[5]=filesz>>24;
    hdr[10]=54; hdr[14]=40;
    hdr[18]=w; hdr[19]=w>>8; hdr[20]=w>>16; hdr[21]=w>>24;
    hdr[22]=h; hdr[23]=h>>8; hdr[24]=h>>16; hdr[25]=h>>24;
    hdr[26]=1; hdr[28]=24;
    fwrite(hdr, 1, 54, f);
    unsigned char *line = calloc(row + pad, 1);
    if (!line) { fclose(f); return -1; }
    for (int y = h - 1; y >= 0; y--) {          /* BMP rows bottom-up, BGR */
        const unsigned char *src = rgb + (size_t)y * w * 3;
        for (int x = 0; x < w; x++) {
            line[x*3+0] = src[x*3+2]; line[x*3+1] = src[x*3+1]; line[x*3+2] = src[x*3+0];
        }
        fwrite(line, 1, row + pad, f);
    }
    free(line); fclose(f); return 0;
}

/* ── self-contained PNG encoder (zlib stored blocks; no libpng/zlib) ── */
static uint32_t crc_tab[256];
static int crc_ready = 0;
static void crc_init(void) {
    for (uint32_t n = 0; n < 256; n++) {
        uint32_t c = n;
        for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
        crc_tab[n] = c;
    }
    crc_ready = 1;
}
static void put32(unsigned char *b, uint32_t v) {
    b[0]=v>>24; b[1]=v>>16; b[2]=v>>8; b[3]=v;
}
/* CRC32 over the chunk type followed by its data, in one pass */
static void write_chunk(FILE *f, const char *type, const unsigned char *data, size_t len) {
    unsigned char tmp[4]; put32(tmp, (uint32_t)len); fwrite(tmp, 1, 4, f);
    fwrite(type, 1, 4, f);
    if (len) fwrite(data, 1, len, f);
    if (!crc_ready) crc_init();
    uint32_t c = 0xffffffffu;
    for (int i = 0; i < 4; i++) c = crc_tab[(c ^ (unsigned char)type[i]) & 0xff] ^ (c >> 8);
    for (size_t i = 0; i < len; i++) c = crc_tab[(c ^ data[i]) & 0xff] ^ (c >> 8);
    put32(tmp, c ^ 0xffffffffu); fwrite(tmp, 1, 4, f);
}
static uint32_t adler32_buf(const unsigned char *p, size_t n) {
    uint32_t a = 1, b = 0;
    for (size_t i = 0; i < n; i++) { a = (a + p[i]) % 65521; b = (b + a) % 65521; }
    return (b << 16) | a;
}
static int write_png(const char *path, const unsigned char *rgb, int w, int h) {
    FILE *f = fopen(path, "wb"); if (!f) return -1;
    static const unsigned char sig[8] = {137,80,78,71,13,10,26,10};
    fwrite(sig, 1, 8, f);

    unsigned char ihdr[13];
    put32(ihdr, w); put32(ihdr + 4, h);
    ihdr[8]=8; ihdr[9]=2; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;  /* 8-bit truecolor */
    write_chunk(f, "IHDR", ihdr, 13);

    /* raw = per row: filter byte 0 + RGB scanline */
    size_t rawlen = (size_t)h * (1 + (size_t)w * 3);
    unsigned char *raw = malloc(rawlen);
    if (!raw) { fclose(f); return -1; }
    for (int y = 0; y < h; y++) {
        unsigned char *d = raw + (size_t)y * (1 + (size_t)w * 3);
        *d++ = 0;
        memcpy(d, rgb + (size_t)y * w * 3, (size_t)w * 3);
    }

    /* zlib stream: header + stored deflate blocks + adler32 */
    size_t cap = rawlen + (rawlen / 65535 + 1) * 5 + 6 + 16;
    unsigned char *z = malloc(cap);
    if (!z) { free(raw); fclose(f); return -1; }
    size_t zi = 0;
    z[zi++] = 0x78; z[zi++] = 0x01;             /* zlib header (no compression) */
    size_t off = 0;
    while (off < rawlen) {
        size_t blk = rawlen - off; if (blk > 65535) blk = 65535;
        int final = (off + blk >= rawlen);
        z[zi++] = final ? 1 : 0;                /* BFINAL, BTYPE=00 (stored) */
        z[zi++] = blk & 0xff; z[zi++] = (blk >> 8) & 0xff;
        unsigned nlen = ~(unsigned)blk;
        z[zi++] = nlen & 0xff; z[zi++] = (nlen >> 8) & 0xff;
        memcpy(z + zi, raw + off, blk); zi += blk; off += blk;
    }
    uint32_t ad = adler32_buf(raw, rawlen);
    z[zi++] = ad>>24; z[zi++] = ad>>16; z[zi++] = ad>>8; z[zi++] = ad;

    write_chunk(f, "IDAT", z, zi);
    write_chunk(f, "IEND", NULL, 0);
    free(raw); free(z); fclose(f); return 0;
}

/* ════════════════════════════════════════════════════════════════
   Public API (platform-independent) — same names everywhere.
   Every fn returns 0 on success, -1 on error (unless noted).
   ════════════════════════════════════════════════════════════════ */

/* human-mode toggle: when on, the plain verbs (agui_move/click/type) route to
   their human-like variants. Off by default — explicit agui_human_* always
   act human regardless of this flag. Defined in the human block below. */
static int g_human = 0;
long long agui_human_move(long long x, long long y);
long long agui_human_click(long long button);
long long agui_human_type(const char *text);

/* enable (1) / disable (0) human-like mode for the plain verbs */
long long agui_human(long long on) { g_human = on ? 1 : 0; return 0; }

/* ── mouse ── */
long long agui_move(long long x, long long y) {
    if (g_human) return agui_human_move(x, y);
    return plat_move((int)x, (int)y);
}
long long agui_move_rel(long long dx, long long dy)  { return plat_move_rel((int)dx, (int)dy); }
long long agui_mouse_x(void) { int x, y; return plat_mouse_pos(&x, &y) < 0 ? -1 : x; }
long long agui_mouse_y(void) { int x, y; return plat_mouse_pos(&x, &y) < 0 ? -1 : y; }
long long agui_mouse_down(long long b) { return plat_button((int)b, 1); }
long long agui_mouse_up(long long b)   { return plat_button((int)b, 0); }
long long agui_click(long long b) {
    if (g_human) return agui_human_click(b);
    if (plat_button((int)b, 1) < 0) return -1;
    return plat_button((int)b, 0);
}
long long agui_double_click(long long b) { if (agui_click(b) < 0) return -1; return agui_click(b); }
long long agui_triple_click(long long b) { if (agui_click(b) < 0) return -1; if (agui_click(b) < 0) return -1; return agui_click(b); }
long long agui_scroll(long long n) { return plat_scroll((int)n); }

long long agui_click_at(long long x, long long y, long long b) {
    if (agui_move(x, y) < 0) return -1;
    return agui_click(b);
}
long long agui_drag(long long x1, long long y1, long long x2, long long y2, long long b) {
    if (agui_move(x1, y1) < 0) return -1;
    if (agui_mouse_down(b) < 0) return -1;
    agui_move(x2, y2);
    return agui_mouse_up(b);
}
long long agui_smooth_move(long long x, long long y, long long steps, long long ms) {
    if (steps < 1) steps = 1;
    int sxv, syv; if (plat_mouse_pos(&sxv, &syv) < 0) { sxv = (int)x; syv = (int)y; }
    long long sx = sxv, sy = syv, per = ms / steps;
    for (long long i = 1; i <= steps; i++) {
        agui_move(sx + (x - sx) * i / steps, sy + (y - sy) * i / steps);
        agui_msleep(per);
    }
    return 0;
}

/* ── keyboard ── */
long long agui_key_tap(const char *name) {
    if (plat_key(name, 1) < 0) return -1;
    return plat_key(name, 0);
}
long long agui_key_down(const char *name) { return plat_key(name, 1); }
long long agui_key_up(const char *name)   { return plat_key(name, 0); }
long long agui_key_press(const char *name, long long times) {
    for (long long i = 0; i < times; i++) if (agui_key_tap(name) < 0) return -1;
    return 0;
}
long long agui_hotkey(const char *modifier, const char *key) {
    if (plat_key(modifier, 1) < 0) return -1;
    long long r = agui_key_tap(key);
    plat_key(modifier, 0);
    return r;
}
long long agui_key_combo(const char *combo) {
    if (!combo) return -1;
    char buf[256]; strncpy(buf, combo, sizeof buf - 1); buf[sizeof buf - 1] = 0;
    char *parts[16]; int n = 0;
    for (char *t = strtok(buf, "+"); t && n < 16; t = strtok(NULL, "+")) parts[n++] = t;
    if (n == 0) return -1;
    for (int i = 0; i < n - 1; i++)
        if (plat_key(parts[i], 1) < 0) {
            for (int j = i - 1; j >= 0; j--) plat_key(parts[j], 0);
            return -1;
        }
    long long r = agui_key_tap(parts[n - 1]);
    for (int i = n - 2; i >= 0; i--) plat_key(parts[i], 0);
    return r;
}
long long agui_type(const char *text) {
    if (!text) return -1;
    if (g_human) return agui_human_type(text);
    for (const unsigned char *p = (const unsigned char *)text; *p; p++)
        plat_type_char((long)*p);
    return 0;
}
long long agui_type_delay(const char *text, long long ms) {
    if (!text) return -1;
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        plat_type_char((long)*p); agui_msleep(ms);
    }
    return 0;
}

/* ── screen / pixels ── */
long long agui_screen_width(void)  { int w, h; return plat_screen(&w, &h) < 0 ? -1 : w; }
long long agui_screen_height(void) { int w, h; return plat_screen(&w, &h) < 0 ? -1 : h; }
long long agui_pixel(long long x, long long y) { return plat_pixel((int)x, (int)y); }
long long agui_pixel_r(long long x, long long y) { long p = (long)agui_pixel(x, y); return p < 0 ? -1 : (p >> 16) & 0xff; }
long long agui_pixel_g(long long x, long long y) { long p = (long)agui_pixel(x, y); return p < 0 ? -1 : (p >> 8) & 0xff; }
long long agui_pixel_b(long long x, long long y) { long p = (long)agui_pixel(x, y); return p < 0 ? -1 : p & 0xff; }
long long agui_rgb(long long r, long long g, long long b) {
    return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}
long long agui_pixel_match(long long x, long long y, long long rgb, long long tol) {
    long long p = agui_pixel(x, y); if (p < 0) return 0;
    long long dr = ((p>>16)&0xff)-((rgb>>16)&0xff);
    long long dg = ((p>>8)&0xff)-((rgb>>8)&0xff);
    long long db = (p&0xff)-(rgb&0xff);
    if (dr < 0) dr = -dr;
    if (dg < 0) dg = -dg;
    if (db < 0) db = -db;
    return (dr <= tol && dg <= tol && db <= tol) ? 1 : 0;
}
long long agui_wait_pixel(long long x, long long y, long long rgb, long long tol, long long timeout_ms) {
    long long waited = 0, step = 20;
    for (;;) {
        if (agui_pixel_match(x, y, rgb, tol)) return 0;
        if (waited >= timeout_ms) return -1;
        agui_msleep(step); waited += step;
    }
}

/* ── screenshots ── */
static long long agui_capture(long long x, long long y, long long w, long long h,
                              const char *path, int png) {
    if (!path) return -1;
    int sw, sh; if (plat_screen(&sw, &sh) < 0) return -1;
    if (w <= 0) w = sw - x;
    if (h <= 0) h = sh - y;
    if (x < 0 || y < 0 || x + w > sw || y + h > sh || w <= 0 || h <= 0) return -1;
    int ow, oh;
    unsigned char *rgb = plat_grab((int)x, (int)y, (int)w, (int)h, &ow, &oh);
    if (!rgb) return -1;
    int r = png ? write_png(path, rgb, ow, oh) : write_bmp(path, rgb, ow, oh);
    free(rgb);
    return r;
}
long long agui_screenshot(long long x, long long y, long long w, long long h, const char *path) {
    return agui_capture(x, y, w, h, path, 0);
}
long long agui_screenshot_full(const char *path) { return agui_capture(0, 0, 0, 0, path, 0); }
long long agui_screenshot_png(long long x, long long y, long long w, long long h, const char *path) {
    return agui_capture(x, y, w, h, path, 1);
}
long long agui_screenshot_full_png(const char *path) { return agui_capture(0, 0, 0, 0, path, 1); }

/* ════════════════════════════════════════════════════════════════
   Human-like ("antidetect") input — curved cursor paths, eased speed,
   jitter, and randomized timing so automated actions don't look like
   instant teleports or perfectly straight lines. Tunable at runtime.
   ════════════════════════════════════════════════════════════════ */

/* path recorder — the last curved motion's points, for testing/introspection */
#define AGUI_PATH_MAX 2048
static int g_path_x[AGUI_PATH_MAX], g_path_y[AGUI_PATH_MAX];
static int g_path_n = 0;
static void path_reset(void) { g_path_n = 0; }
static void path_add(int x, int y) {
    if (g_path_n < AGUI_PATH_MAX) { g_path_x[g_path_n] = x; g_path_y[g_path_n] = y; g_path_n++; }
}
long long agui_path_len(void) { return g_path_n; }
long long agui_path_x(long long i) { return (i >= 0 && i < g_path_n) ? g_path_x[i] : -1; }
long long agui_path_y(long long i) { return (i >= 0 && i < g_path_n) ? g_path_y[i] : -1; }

static int    g_seeded   = 0;
static double g_curve    = 0.20;   /* arc strength, fraction of path length     */
static double g_jitter   = 1.5;    /* max per-step positional wobble, pixels     */
static double g_speed    = 1.0;    /* time multiplier (1 = normal, 2 = slower)   */
static int    g_overshoot = 1;     /* allow slight overshoot + settle on arrival */

static void agui_seed_rng(void) {
    if (g_seeded) return;
    srand((unsigned)(time(NULL) ^ (clock() << 1)));
    g_seeded = 1;
}
static double frand(void) { return rand() / (RAND_MAX + 1.0); }          /* [0,1) */
static double frange(double a, double b) { return a + frand() * (b - a); }
static long long irange(long long a, long long b) {
    if (b < a) { long long t = a; a = b; b = t; }
    return a + (long long)(frand() * (double)(b - a + 1));
}
static double smoothstep(double t) { return t * t * (3.0 - 2.0 * t); }   /* ease  */

/* sleep a random duration in [min_ms, max_ms]; returns the ms actually slept */
long long agui_human_delay(long long min_ms, long long max_ms) {
    agui_seed_rng();
    long long ms = irange(min_ms, max_ms);
    agui_msleep(ms);
    return ms;
}

/* tuning setters (return 0) */
long long agui_set_curve(double amount)  { g_curve = amount < 0 ? 0 : amount; return 0; }
long long agui_set_jitter(double px)     { g_jitter = px < 0 ? 0 : px; return 0; }
long long agui_set_speed(double mult)    { g_speed = mult <= 0 ? 1.0 : mult; return 0; }
long long agui_set_overshoot(long long on){ g_overshoot = on ? 1 : 0; return 0; }
/* seed the RNG for reproducible motion (n = 0 → time-based) */
long long agui_human_seed(long long n) {
    if (n == 0) { g_seeded = 0; agui_seed_rng(); }
    else { srand((unsigned)n); g_seeded = 1; }
    return 0;
}

/* glide along a quadratic Bézier from (sx,sy) to (ex,ey) over total_ms,
   with eased speed, a randomized arc, and per-step jitter. */
static void agui_curved(double sx, double sy, double ex, double ey,
                        int steps, long long total_ms) {
    double dx = ex - sx, dy = ey - sy;
    double dist = sqrt(dx * dx + dy * dy);
    path_reset();
    if (dist < 1.0) { plat_move((int)ex, (int)ey); path_add((int)ex, (int)ey); return; }

    /* control point: path midpoint pushed along the perpendicular, random side */
    double px = -dy / dist, py = dx / dist;                  /* unit normal */
    double off = g_curve * dist * frange(0.4, 1.0) * (frand() < 0.5 ? -1 : 1);
    double cx = (sx + ex) / 2 + px * off;
    double cy = (sy + ey) / 2 + py * off;

    if (steps < 2) steps = 2;
    long long per = total_ms / steps; if (per < 1) per = 1;

    for (int i = 1; i <= steps; i++) {
        double t = smoothstep((double)i / steps);
        double u = 1 - t;
        double bx = u*u*sx + 2*u*t*cx + t*t*ex;
        double by = u*u*sy + 2*u*t*cy + t*t*ey;
        if (i < steps) {                                     /* jitter mid-path only */
            bx += frange(-g_jitter, g_jitter);
            by += frange(-g_jitter, g_jitter);
        }
        plat_move((int)(bx + 0.5), (int)(by + 0.5));
        path_add((int)(bx + 0.5), (int)(by + 0.5));
        agui_msleep((long long)(per * frange(0.7, 1.4)));    /* uneven cadence */
    }
}

/* move the cursor to (x,y) like a human: curved path, variable speed, jitter.
   Duration is derived from the distance (with a little randomness). */
long long agui_human_move(long long x, long long y) {
    agui_seed_rng();
    int sxv, syv;
    if (plat_mouse_pos(&sxv, &syv) < 0) { sxv = (int)x; syv = (int)y; }
    double dx = x - sxv, dy = y - syv;
    double dist = sqrt(dx * dx + dy * dy);
    int steps = (int)(dist / 6.0) + (int)irange(12, 24);
    if (steps > 120) steps = 120;
    long long dur = (long long)((dist * 1.4 + frange(120, 280)) * g_speed);

    if (g_overshoot && dist > 180 && frand() < 0.35) {       /* overshoot + settle */
        double ang = atan2(dy, dx);
        double ox = x + cos(ang) * frange(6, 16);
        double oy = y + sin(ang) * frange(6, 16);
        agui_curved(sxv, syv, ox, oy, steps, dur);
        agui_msleep(irange(20, 60));
        agui_curved(ox, oy, x, y, (int)irange(6, 12), irange(60, 140));
    } else {
        agui_curved(sxv, syv, x, y, steps, dur);
    }
    return 0;
}

/* curved move to (x,y) over an explicit duration in milliseconds */
long long agui_human_move_to(long long x, long long y, long long ms) {
    agui_seed_rng();
    int sxv, syv;
    if (plat_mouse_pos(&sxv, &syv) < 0) { sxv = (int)x; syv = (int)y; }
    double dx = x - sxv, dy = y - syv;
    int steps = (int)(sqrt(dx*dx + dy*dy) / 6.0) + (int)irange(12, 24);
    if (steps > 120) steps = 120;
    agui_curved(sxv, syv, x, y, steps, ms);
    return 0;
}

/* click with a randomized, human-length button hold and small surrounding pauses */
long long agui_human_click(long long button) {
    agui_seed_rng();
    agui_msleep(irange(40, 120));
    if (plat_button((int)button, 1) < 0) return -1;
    agui_msleep(irange(50, 110));            /* press-to-release dwell */
    long long r = plat_button((int)button, 0);
    agui_msleep(irange(30, 90));
    return r;
}

/* move to (x,y) the human way, then click */
long long agui_human_click_at(long long x, long long y, long long button) {
    if (agui_human_move(x, y) < 0) return -1;
    agui_msleep(irange(20, 80));
    return agui_human_click(button);
}

/* type text with a human rhythm: variable per-key delay, longer pauses after
   spaces/punctuation, occasional brief hesitations. */
long long agui_human_type(const char *text) {
    if (!text) return -1;
    agui_seed_rng();
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        plat_type_char((long)*p);
        long long d = irange(45, 140);
        if (*p == ' ') d += irange(20, 90);
        else if (strchr(".,!?;:", *p)) d += irange(80, 220);
        if (frand() < 0.04) d += irange(150, 450);   /* rare hesitation */
        agui_msleep(d);
    }
    return 0;
}

/* ── window ── */
char *agui_active_window(void) { return plat_active_window(); }

char *agui_version(void) {
#if AGUI_WINDOWS
    return (char *)"autogui 1.4.0 (Windows/Win32)";
#elif AGUI_MACOS
    return (char *)"autogui 1.4.0 (macOS/CoreGraphics)";
#else
    return (char *)"autogui 1.4.0 (Linux/X11 XTEST)";
#endif
}
