/* ═══════════════════════════════════════════════════════════════
   os_notify — system notifications for Ezy (extension of `os`).

   Desktop backends:
     linux  → notify-send (libnotify)   [must be on PATH]
     macos  → osascript "display notification"
     windows→ TODO (WinRT toast); returns 0 for now
   Mobile (android/ios) is reserved — needs a Java/ObjC bridge.

   Build: extends "os", so os.c is compiled in alongside this file.
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
  #define NT_WINDOWS 1
#elif defined(__ANDROID__)
  #define NT_ANDROID 1
#elif defined(__APPLE__)
  #include <TargetConditionals.h>
  #if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
    #define NT_IOS 1
  #else
    #define NT_MACOS 1
  #endif
#else
  #define NT_LINUX 1
#endif

#if defined(NT_LINUX) || defined(NT_MACOS)
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

/* show a system notification; returns 1 on success, 0 otherwise.
   `urgency` (linux only): "low" | "normal" | "critical" ("" = normal). */
long long os_notify_full(const char *title, const char *body, const char *urgency) {
#if defined(NT_LINUX)
    char cmd[2048] = "notify-send";
    if (urgency && *urgency) { strncat(cmd, " -u ", sizeof cmd - strlen(cmd) - 1); strncat(cmd, urgency, sizeof cmd - strlen(cmd) - 1); }
    strncat(cmd, " ", sizeof cmd - strlen(cmd) - 1); sh_quote(cmd, sizeof cmd, title && *title ? title : "Notification");
    strncat(cmd, " ", sizeof cmd - strlen(cmd) - 1); sh_quote(cmd, sizeof cmd, body ? body : "");
    strncat(cmd, " >/dev/null 2>&1", sizeof cmd - strlen(cmd) - 1);
    return system(cmd) == 0 ? 1 : 0;
#elif defined(NT_MACOS)
    (void)urgency;
    char cmd[2048];
    snprintf(cmd, sizeof cmd, "osascript -e 'display notification \"%s\" with title \"%s\"' >/dev/null 2>&1",
             body ? body : "", title && *title ? title : "Notification");
    return system(cmd) == 0 ? 1 : 0;
#else
    (void)title; (void)body; (void)urgency; return 0;   /* windows/mobile: reserved */
#endif
}

/* show a basic notification (title + body) */
long long os_notify(const char *title, const char *body) {
    return os_notify_full(title, body, "");
}

char *os_notify_version(void) { return strdup("os_notify 1.0.0"); }
