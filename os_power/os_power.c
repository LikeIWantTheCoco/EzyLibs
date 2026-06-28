/* ═══════════════════════════════════════════════════════════════
   os_power — battery / AC power info (extension of `os`).

   Backends:
     linux  → /sys/class/power_supply
     macos  → pmset -g batt
     windows→ GetSystemPowerStatus
   Mobile (android/ios) reserved.
   Build: extends "os".
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
  #define PW_WINDOWS 1
  #include <windows.h>
#elif defined(__ANDROID__)
  #define PW_ANDROID 1
#elif defined(__APPLE__)
  #include <TargetConditionals.h>
  #if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
    #define PW_IOS 1
  #else
    #define PW_MACOS 1
  #endif
#else
  #define PW_LINUX 1
#endif

#if defined(PW_LINUX)
#include <dirent.h>
/* read the first line of a file into out (trimmed); 1 on success */
static int read_line(const char *path, char *out, size_t cap) {
    FILE *f = fopen(path, "r"); if (!f) return 0;
    if (!fgets(out, (int)cap, f)) { fclose(f); return 0; }
    fclose(f);
    out[strcspn(out, "\r\n")] = 0;
    return 1;
}
/* find the sysfs dir of the first power supply whose type matches; 1 if found */
static int find_supply(const char *want_type, char *dir, size_t cap) {
    DIR *d = opendir("/sys/class/power_supply"); if (!d) return 0;
    struct dirent *e; int found = 0;
    while ((e = readdir(d))) {
        if (e->d_name[0] == '.') continue;
        char tp[512], val[64];
        snprintf(tp, sizeof tp, "/sys/class/power_supply/%s/type", e->d_name);
        if (read_line(tp, val, sizeof val) && !strcmp(val, want_type)) {
            snprintf(dir, cap, "/sys/class/power_supply/%s", e->d_name);
            found = 1; break;
        }
    }
    closedir(d);
    return found;
}
#endif
#if defined(PW_MACOS)
static char *pmset(void) {
    FILE *p = popen("pmset -g batt 2>/dev/null", "r"); if (!p) return strdup("");
    size_t cap = 2048, len = 0; char *b = malloc(cap); size_t n; char t[1024];
    while ((n = fread(t, 1, sizeof t, p)) > 0) { if (len+n+1>cap){while(len+n+1>cap)cap*=2;b=realloc(b,cap);} memcpy(b+len,t,n); len+=n; }
    pclose(p); b[len] = 0; return b;
}
#endif

/* battery charge 0-100, or -1 if no battery / unknown */
long long os_battery_percent(void) {
#if defined(PW_LINUX)
    char dir[512], path[600], val[64];
    if (!find_supply("Battery", dir, sizeof dir)) return -1;
    snprintf(path, sizeof path, "%s/capacity", dir);
    if (!read_line(path, val, sizeof val)) return -1;
    return atoll(val);
#elif defined(PW_MACOS)
    char *s = pmset(); long long pct = -1;
    char *pc = strchr(s, '%');
    if (pc) { char *q = pc; while (q > s && q[-1] >= '0' && q[-1] <= '9') q--; pct = atoll(q); }
    free(s); return pct;
#elif defined(PW_WINDOWS)
    SYSTEM_POWER_STATUS st;
    if (!GetSystemPowerStatus(&st) || st.BatteryLifePercent == 255) return -1;
    return st.BatteryLifePercent;
#else
    return -1;
#endif
}

/* 1 if on AC/mains, 0 if on battery, -1 if unknown */
long long os_on_ac(void) {
#if defined(PW_LINUX)
    char dir[512], path[600], val[64];
    if (find_supply("Mains", dir, sizeof dir)) {
        snprintf(path, sizeof path, "%s/online", dir);
        if (read_line(path, val, sizeof val)) return atoll(val) ? 1 : 0;
    }
    return -1;
#elif defined(PW_MACOS)
    char *s = pmset(); int ac = strstr(s, "AC Power") ? 1 : (strstr(s, "Battery Power") ? 0 : -1);
    free(s); return ac;
#elif defined(PW_WINDOWS)
    SYSTEM_POWER_STATUS st;
    if (!GetSystemPowerStatus(&st) || st.ACLineStatus == 255) return -1;
    return st.ACLineStatus ? 1 : 0;
#else
    return -1;
#endif
}

/* battery status string: "Charging" / "Discharging" / "Full" / "Unknown" */
char *os_battery_status(void) {
#if defined(PW_LINUX)
    char dir[512], path[600], val[64];
    if (find_supply("Battery", dir, sizeof dir)) {
        snprintf(path, sizeof path, "%s/status", dir);
        if (read_line(path, val, sizeof val)) return strdup(val);
    }
    return strdup("Unknown");
#elif defined(PW_MACOS)
    char *s = pmset();
    const char *r = strstr(s, "charging") ? "Charging" : strstr(s, "discharging") ? "Discharging"
                  : strstr(s, "charged") ? "Full" : "Unknown";
    char *out = strdup(r); free(s); return out;
#elif defined(PW_WINDOWS)
    SYSTEM_POWER_STATUS st;
    if (GetSystemPowerStatus(&st)) {
        if (st.BatteryFlag & 8) return strdup("Charging");
        if (st.ACLineStatus == 1) return strdup("Full");
        if (st.BatteryFlag != 255) return strdup("Discharging");
    }
    return strdup("Unknown");
#else
    return strdup("Unknown");
#endif
}

/* 1 if the battery is currently charging */
long long os_battery_charging(void) {
    char *s = os_battery_status();
    int c = !strcmp(s, "Charging");
    free(s);
    return c ? 1 : 0;
}

char *os_power_version(void) { return strdup("os_power 1.0.0"); }
