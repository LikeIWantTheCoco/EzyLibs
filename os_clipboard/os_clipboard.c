/* ═══════════════════════════════════════════════════════════════
   os_clipboard — read/write the system clipboard (extension of `os`).

   Backends:
     linux  → wl-copy/wl-paste (Wayland) or xclip / xsel (X11)
     macos  → pbcopy / pbpaste
     windows→ Win32 clipboard API
   Mobile (android/ios) reserved.

   Build: extends "os" (os.c compiled in alongside this file).
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
  #define CB_WINDOWS 1
  #include <windows.h>
#elif defined(__ANDROID__)
  #define CB_ANDROID 1
#elif defined(__APPLE__)
  #include <TargetConditionals.h>
  #if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
    #define CB_IOS 1
  #else
    #define CB_MACOS 1
  #endif
#else
  #define CB_LINUX 1
#endif

#if defined(CB_LINUX) || defined(CB_MACOS)
static int have(const char *bin) {
    char c[128]; snprintf(c, sizeof c, "command -v %s >/dev/null 2>&1", bin);
    return system(c) == 0;
}
/* the command that reads stdin into the clipboard, or NULL if none available */
static const char *clip_set_cmd(void) {
#if defined(CB_MACOS)
    return "pbcopy";
#else
    if (getenv("WAYLAND_DISPLAY") && have("wl-copy")) return "wl-copy";
    if (have("xclip")) return "xclip -selection clipboard";
    if (have("xsel"))  return "xsel --clipboard --input";
    return NULL;
#endif
}
/* the command that prints the clipboard to stdout, or NULL */
static const char *clip_get_cmd(void) {
#if defined(CB_MACOS)
    return "pbpaste";
#else
    if (getenv("WAYLAND_DISPLAY") && have("wl-paste")) return "wl-paste --no-newline";
    if (have("xclip")) return "xclip -selection clipboard -o";
    if (have("xsel"))  return "xsel --clipboard --output";
    return NULL;
#endif
}
#endif

/* put text on the clipboard; returns 1 on success */
long long os_clip_set(const char *text) {
#if defined(CB_LINUX) || defined(CB_MACOS)
    const char *cmd = clip_set_cmd();
    if (!cmd) return 0;
    char full[256]; snprintf(full, sizeof full, "%s >/dev/null 2>&1", cmd);
    FILE *p = popen(full, "w");
    if (!p) return 0;
    if (text) fwrite(text, 1, strlen(text), p);
    return pclose(p) == 0 ? 1 : 0;
#elif defined(CB_WINDOWS)
    if (!text) text = "";
    if (!OpenClipboard(NULL)) return 0;
    EmptyClipboard();
    size_t n = strlen(text) + 1;
    HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE, n);
    if (!h) { CloseClipboard(); return 0; }
    memcpy(GlobalLock(h), text, n);
    GlobalUnlock(h);
    SetClipboardData(CF_TEXT, h);
    CloseClipboard();
    return 1;
#else
    (void)text; return 0;   /* android/ios reserved */
#endif
}

/* get the clipboard text ("" if empty/unavailable) */
char *os_clip_get(void) {
#if defined(CB_LINUX) || defined(CB_MACOS)
    const char *cmd = clip_get_cmd();
    if (!cmd) return strdup("");
    char full[256]; snprintf(full, sizeof full, "%s 2>/dev/null", cmd);
    FILE *p = popen(full, "r");
    if (!p) return strdup("");
    size_t cap = 4096, len = 0; char *buf = malloc(cap); size_t n; char tmp[4096];
    while ((n = fread(tmp, 1, sizeof tmp, p)) > 0) {
        if (len + n + 1 > cap) { while (len + n + 1 > cap) cap *= 2; buf = realloc(buf, cap); }
        memcpy(buf + len, tmp, n); len += n;
    }
    pclose(p);
    buf[len] = 0;
    return buf;
#elif defined(CB_WINDOWS)
    if (!OpenClipboard(NULL)) return strdup("");
    HANDLE h = GetClipboardData(CF_TEXT);
    if (!h) { CloseClipboard(); return strdup(""); }
    const char *s = (const char *)GlobalLock(h);
    char *r = strdup(s ? s : "");
    GlobalUnlock(h);
    CloseClipboard();
    return r;
#else
    return strdup("");
#endif
}

char *os_clip_version(void) { return strdup("os_clipboard 1.0.0"); }
