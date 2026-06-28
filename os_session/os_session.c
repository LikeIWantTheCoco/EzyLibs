/* ═══════════════════════════════════════════════════════════════
   os_session — user-session info: idle time and screen lock (extends `os`).

     linux  → idle: xprintidle or gnome Mutter IdleMonitor (gdbus);
              lock: loginctl / xdg-screensaver / gnome-screensaver
     macos  → idle: ioreg HIDIdleTime; lock: CGSession -suspend
     windows→ idle: GetLastInputInfo; lock: LockWorkStation
   Mobile (android/ios) reserved.
   Build: extends "os".
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
  #define SE_WINDOWS 1
  #include <windows.h>
#elif defined(__ANDROID__)
  #define SE_ANDROID 1
#elif defined(__APPLE__)
  #include <TargetConditionals.h>
  #if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
    #define SE_IOS 1
  #else
    #define SE_MACOS 1
  #endif
#else
  #define SE_LINUX 1
#endif

#if defined(SE_LINUX) || defined(SE_MACOS)
static int have(const char *bin) {
    char c[128]; snprintf(c, sizeof c, "command -v %s >/dev/null 2>&1", bin); return system(c) == 0;
}
static char *run_capture(const char *cmd) {
    FILE *p = popen(cmd, "r"); if (!p) return strdup("");
    size_t cap = 512, len = 0; char *b = malloc(cap); size_t n; char t[512];
    while ((n = fread(t, 1, sizeof t, p)) > 0) { if (len+n+1>cap){while(len+n+1>cap)cap*=2;b=realloc(b,cap);} memcpy(b+len,t,n); len+=n; }
    pclose(p); b[len] = 0; return b;
}
#endif

/* milliseconds since the last user input, or -1 if unknown */
long long os_idle_ms(void) {
#if defined(SE_LINUX)
    if (have("xprintidle")) { char *s = run_capture("xprintidle 2>/dev/null"); long long v = s[0]?atoll(s):-1; free(s); return v; }
    /* GNOME/Mutter fallback over the session bus */
    char *s = run_capture("gdbus call --session --dest org.gnome.Mutter.IdleMonitor "
                          "--object-path /org/gnome/Mutter/IdleMonitor/Core "
                          "--method org.gnome.Mutter.IdleMonitor.GetIdletime 2>/dev/null");
    long long v = -1; char *digit = s; while (*digit && (*digit < '0' || *digit > '9')) digit++;
    if (*digit) v = atoll(digit);   /* "(uint64 12345,)" */
    free(s); return v;
#elif defined(SE_MACOS)
    char *s = run_capture("ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/{print $NF; exit}'");
    long long v = s[0] ? atoll(s) / 1000000 : -1;   /* ns -> ms */
    free(s); return v;
#elif defined(SE_WINDOWS)
    LASTINPUTINFO li; li.cbSize = sizeof li;
    if (!GetLastInputInfo(&li)) return -1;
    return (long long)(GetTickCount() - li.dwTime);
#else
    return -1;
#endif
}

/* lock the screen / session; 1 on success */
long long os_lock(void) {
#if defined(SE_LINUX)
    if (have("loginctl") && system("loginctl lock-session >/dev/null 2>&1") == 0) return 1;
    if (have("xdg-screensaver") && system("xdg-screensaver lock >/dev/null 2>&1") == 0) return 1;
    if (have("gnome-screensaver-command") && system("gnome-screensaver-command -l >/dev/null 2>&1") == 0) return 1;
    return 0;
#elif defined(SE_MACOS)
    return system("/System/Library/CoreServices/Menu\\ Extras/User.menu/Contents/Resources/CGSession -suspend >/dev/null 2>&1") == 0 ? 1 : 0;
#elif defined(SE_WINDOWS)
    return LockWorkStation() ? 1 : 0;
#else
    return 0;
#endif
}

char *os_session_version(void) { return strdup("os_session 1.0.0"); }
