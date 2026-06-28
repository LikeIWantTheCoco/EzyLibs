/* ═══════════════════════════════════════════════════════════════
   os_screen — screen size and screenshots (extension of `os`).

   Backends:
     linux  → xrandr/xdpyinfo for size; grim/maim/scrot/import to capture
     macos  → AppleScript for size; screencapture to capture
     windows→ GetSystemMetrics for size; GDI BitBlt → .bmp to capture
   Mobile (android/ios) reserved.

   os_screenshot writes a PNG on linux/macos; on Windows it writes a BMP
   (extension is left as given). Build: extends "os".
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
  #define SC_WINDOWS 1
  #include <windows.h>
#elif defined(__ANDROID__)
  #define SC_ANDROID 1
#elif defined(__APPLE__)
  #include <TargetConditionals.h>
  #if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
    #define SC_IOS 1
  #else
    #define SC_MACOS 1
  #endif
#else
  #define SC_LINUX 1
#endif

#if defined(SC_LINUX) || defined(SC_MACOS)
static int have(const char *bin) {
    char c[128]; snprintf(c, sizeof c, "command -v %s >/dev/null 2>&1", bin);
    return system(c) == 0;
}
static char *run_capture(const char *cmd) {
    FILE *p = popen(cmd, "r"); if (!p) return strdup("");
    size_t cap = 1024, len = 0; char *b = malloc(cap); size_t n; char t[1024];
    while ((n = fread(t, 1, sizeof t, p)) > 0) {
        if (len + n + 1 > cap) { while (len + n + 1 > cap) cap *= 2; b = realloc(b, cap); }
        memcpy(b + len, t, n); len += n;
    }
    pclose(p); b[len] = 0; return b;
}
static void sh_quote(char *out, size_t cap, const char *in) {
    size_t o = strlen(out); if (o + 1 < cap) out[o++] = '\'';
    for (const char *p = in ? in : ""; *p && o + 4 < cap; p++) {
        if (*p == '\'') { memcpy(out + o, "'\\''", 4); o += 4; } else out[o++] = *p;
    }
    if (o + 1 < cap) out[o++] = '\'';
    out[o] = 0;
}
#endif

/* primary screen dimensions in pixels (0 on failure) */
static void screen_size(long long *w, long long *h) {
    *w = 0; *h = 0;
#if defined(SC_LINUX)
    char *s = NULL;
    if (have("xdpyinfo")) s = run_capture("xdpyinfo 2>/dev/null | awk '/dimensions:/{print $2}'");
    else if (have("xrandr")) s = run_capture("xrandr 2>/dev/null | awk '/\\*/{print $1; exit}'");
    if (s) {
        long ww = 0, hh = 0;
        if (sscanf(s, "%ldx%ld", &ww, &hh) == 2) { *w = ww; *h = hh; }
        free(s);
    }
#elif defined(SC_MACOS)
    char *s = run_capture("osascript -e 'tell application \"Finder\" to get bounds of window of desktop' 2>/dev/null");
    if (s) { int a,b,c,d; if (sscanf(s, "%d, %d, %d, %d", &a,&b,&c,&d) == 4) { *w = c; *h = d; } free(s); }
#elif defined(SC_WINDOWS)
    *w = GetSystemMetrics(SM_CXSCREEN);
    *h = GetSystemMetrics(SM_CYSCREEN);
#endif
}

long long os_screen_width(void)  { long long w, h; screen_size(&w, &h); return w; }
long long os_screen_height(void) { long long w, h; screen_size(&w, &h); return h; }

/* capture the whole screen to `path`; returns 1 on success */
long long os_screenshot(const char *path) {
    if (!path || !*path) return 0;
#if defined(SC_LINUX)
    const char *tool = NULL;
    if (getenv("WAYLAND_DISPLAY") && have("grim")) {
        char cmd[2048] = "grim "; sh_quote(cmd, sizeof cmd, path);
        strncat(cmd, " >/dev/null 2>&1", sizeof cmd - strlen(cmd) - 1);
        return system(cmd) == 0 ? 1 : 0;
    }
    if (have("maim")) tool = "maim";
    else if (have("scrot")) tool = "scrot";
    else if (have("import")) tool = "import -window root";
    if (!tool) return 0;
    char cmd[2048]; snprintf(cmd, sizeof cmd, "%s ", tool);
    sh_quote(cmd, sizeof cmd, path);
    strncat(cmd, " >/dev/null 2>&1", sizeof cmd - strlen(cmd) - 1);
    return system(cmd) == 0 ? 1 : 0;
#elif defined(SC_MACOS)
    char cmd[2048] = "screencapture -x "; sh_quote(cmd, sizeof cmd, path);
    strncat(cmd, " >/dev/null 2>&1", sizeof cmd - strlen(cmd) - 1);
    return system(cmd) == 0 ? 1 : 0;
#elif defined(SC_WINDOWS)
    int w = GetSystemMetrics(SM_CXSCREEN), h = GetSystemMetrics(SM_CYSCREEN);
    HDC dc = GetDC(NULL), mem = CreateCompatibleDC(dc);
    HBITMAP bmp = CreateCompatibleBitmap(dc, w, h);
    HGDIOBJ old = SelectObject(mem, bmp);
    BitBlt(mem, 0, 0, w, h, dc, 0, 0, SRCCOPY);
    SelectObject(mem, old);
    BITMAPINFOHEADER bi = {0};
    bi.biSize = sizeof bi; bi.biWidth = w; bi.biHeight = -h; bi.biPlanes = 1;
    bi.biBitCount = 24; bi.biCompression = BI_RGB;
    int stride = ((w * 3 + 3) & ~3), imgsize = stride * h;
    unsigned char *pix = malloc(imgsize);
    GetDIBits(mem, bmp, 0, h, pix, (BITMAPINFO *)&bi, DIB_RGB_COLORS);
    BITMAPFILEHEADER fh = {0};
    fh.bfType = 0x4D42; fh.bfOffBits = sizeof fh + sizeof bi;
    fh.bfSize = fh.bfOffBits + imgsize;
    FILE *f = fopen(path, "wb"); int ok = 0;
    if (f) { fwrite(&fh, sizeof fh, 1, f); fwrite(&bi, sizeof bi, 1, f); fwrite(pix, imgsize, 1, f); fclose(f); ok = 1; }
    free(pix); DeleteObject(bmp); DeleteDC(mem); ReleaseDC(NULL, dc);
    return ok;
#else
    (void)path; return 0;   /* android/ios reserved */
#endif
}

char *os_screen_version(void) { return strdup("os_screen 1.0.0"); }
