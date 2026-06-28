/* ═══════════════════════════════════════════════════════════════
   os_open — open a file/URL/folder with the default app (extends `os`).

   Backends: xdg-open (linux), open (macos), ShellExecute (windows),
   `am start` (android, best-effort). iOS reserved.
   Build: extends "os".
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
  #define OP_WINDOWS 1
  #include <windows.h>
  #include <shellapi.h>
#elif defined(__ANDROID__)
  #define OP_ANDROID 1
#elif defined(__APPLE__)
  #include <TargetConditionals.h>
  #if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
    #define OP_IOS 1
  #else
    #define OP_MACOS 1
  #endif
#else
  #define OP_LINUX 1
#endif

#if !defined(OP_WINDOWS)
static void sh_quote(char *out, size_t cap, const char *in) {
    size_t o = strlen(out);
    if (o + 1 < cap) out[o++] = '\'';
    for (const char *p = in ? in : ""; *p && o + 4 < cap; p++) {
        if (*p == '\'') { memcpy(out + o, "'\\''", 4); o += 4; }
        else out[o++] = *p;
    }
    if (o + 1 < cap) out[o++] = '\'';
    out[o] = 0;
}
#endif

/* open a path or URL with the system default application; 1 on success */
long long os_open(const char *target) {
    if (!target || !*target) return 0;
#if defined(OP_LINUX)
    char cmd[2048] = "xdg-open "; sh_quote(cmd, sizeof cmd, target);
    strncat(cmd, " >/dev/null 2>&1", sizeof cmd - strlen(cmd) - 1);
    return system(cmd) == 0 ? 1 : 0;
#elif defined(OP_MACOS)
    char cmd[2048] = "open "; sh_quote(cmd, sizeof cmd, target);
    strncat(cmd, " >/dev/null 2>&1", sizeof cmd - strlen(cmd) - 1);
    return system(cmd) == 0 ? 1 : 0;
#elif defined(OP_ANDROID)
    char cmd[2048] = "am start -a android.intent.action.VIEW -d "; sh_quote(cmd, sizeof cmd, target);
    strncat(cmd, " >/dev/null 2>&1", sizeof cmd - strlen(cmd) - 1);
    return system(cmd) == 0 ? 1 : 0;
#elif defined(OP_WINDOWS)
    HINSTANCE r = ShellExecute(NULL, "open", target, NULL, NULL, SW_SHOWNORMAL);
    return ((INT_PTR)r > 32) ? 1 : 0;
#else
    return 0;   /* ios reserved */
#endif
}

/* open `target` with a specific application; 1 on success */
long long os_open_with(const char *app, const char *target) {
    if (!app || !*app) return 0;
#if defined(OP_LINUX)
    char cmd[2048] = ""; sh_quote(cmd, sizeof cmd, app);
    strncat(cmd, " ", sizeof cmd - strlen(cmd) - 1); sh_quote(cmd, sizeof cmd, target ? target : "");
    strncat(cmd, " >/dev/null 2>&1 &", sizeof cmd - strlen(cmd) - 1);
    return system(cmd) == 0 ? 1 : 0;
#elif defined(OP_MACOS)
    char cmd[2048] = "open -a "; sh_quote(cmd, sizeof cmd, app);
    strncat(cmd, " ", sizeof cmd - strlen(cmd) - 1); sh_quote(cmd, sizeof cmd, target ? target : "");
    strncat(cmd, " >/dev/null 2>&1", sizeof cmd - strlen(cmd) - 1);
    return system(cmd) == 0 ? 1 : 0;
#elif defined(OP_WINDOWS)
    HINSTANCE r = ShellExecute(NULL, "open", app, target, NULL, SW_SHOWNORMAL);
    return ((INT_PTR)r > 32) ? 1 : 0;
#else
    (void)target; return 0;
#endif
}

char *os_open_version(void) { return strdup("os_open 1.0.0"); }
