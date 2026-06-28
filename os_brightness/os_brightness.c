/* ═══════════════════════════════════════════════════════════════
   os_brightness — screen backlight brightness (extension of `os`).

     linux  → /sys/class/backlight (read always; set via brightnessctl,
              else a direct sysfs write which usually needs root)
     macos  → reserved (needs a private API / the `brightness` tool)
     windows→ reserved (WMI WmiMonitorBrightness)
   Mobile (android/ios) reserved.
   Build: extends "os".
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
  #define BR_WINDOWS 1
#elif defined(__ANDROID__)
  #define BR_ANDROID 1
#elif defined(__APPLE__)
  #include <TargetConditionals.h>
  #if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
    #define BR_IOS 1
  #else
    #define BR_MACOS 1
  #endif
#else
  #define BR_LINUX 1
#endif

#if defined(BR_LINUX)
#include <dirent.h>
static int read_ll(const char *path, long long *out) {
    FILE *f = fopen(path, "r"); if (!f) return 0;
    int ok = fscanf(f, "%lld", out) == 1; fclose(f); return ok;
}
/* dir of the first backlight device, or 0 if none */
static int backlight_dir(char *dir, size_t cap) {
    DIR *d = opendir("/sys/class/backlight"); if (!d) return 0;
    struct dirent *e; int found = 0;
    while ((e = readdir(d))) {
        if (e->d_name[0] == '.') continue;
        snprintf(dir, cap, "/sys/class/backlight/%s", e->d_name); found = 1; break;
    }
    closedir(d); return found;
}
static int have(const char *bin) {
    char c[128]; snprintf(c, sizeof c, "command -v %s >/dev/null 2>&1", bin); return system(c) == 0;
}
#endif

/* current brightness 0-100, or -1 if unavailable */
long long os_brightness_get(void) {
#if defined(BR_LINUX)
    char dir[256], p[320]; long long cur, max;
    if (!backlight_dir(dir, sizeof dir)) return -1;
    snprintf(p, sizeof p, "%s/brightness", dir);     if (!read_ll(p, &cur)) return -1;
    snprintf(p, sizeof p, "%s/max_brightness", dir);  if (!read_ll(p, &max) || max <= 0) return -1;
    return (cur * 100 + max / 2) / max;
#else
    return -1;   /* macos/windows/mobile: reserved */
#endif
}

/* set brightness 0-100; 1 on success (sysfs write usually needs root) */
long long os_brightness_set(long long pct) {
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
#if defined(BR_LINUX)
    if (have("brightnessctl")) {
        char cmd[128]; snprintf(cmd, sizeof cmd, "brightnessctl set %lld%% >/dev/null 2>&1", pct);
        return system(cmd) == 0 ? 1 : 0;
    }
    char dir[256], p[320]; long long max;
    if (!backlight_dir(dir, sizeof dir)) return 0;
    snprintf(p, sizeof p, "%s/max_brightness", dir);
    if (!read_ll(p, &max) || max <= 0) return 0;
    long long val = pct * max / 100;
    snprintf(p, sizeof p, "%s/brightness", dir);
    FILE *f = fopen(p, "w"); if (!f) return 0;          /* needs root without brightnessctl */
    fprintf(f, "%lld", val); int ok = fclose(f) == 0;
    return ok ? 1 : 0;
#else
    (void)pct; return 0;
#endif
}

char *os_brightness_version(void) { return strdup("os_brightness 1.0.0"); }
