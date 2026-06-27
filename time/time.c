/* ═══════════════════════════════════════════════════════════════
   time — date / clock / sleep for Ezy.

   These were once baked into the Ezy runtime; they now live here so the
   runtime stays minimal. Thin wrappers over <time.h> / POSIX. All clock
   readings are local time; strings are heap-allocated (the Ezy arena
   owns them). The OOP `Time` class in time.ez wraps these.

   Build: gcc -shared -fPIC time.c -o libtime.so
   ═══════════════════════════════════════════════════════════════ */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* epoch seconds */
long long time_unix(void) { return (long long)time(NULL); }

/* epoch milliseconds */
long long time_now_ms(void) {
    struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* monotonic clock in seconds (for measuring elapsed time) */
double time_mono(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

/* sleep for the given number of milliseconds */
void time_sleep_ms(long long ms) {
    if (ms <= 0) return;
    struct timespec ts = { (time_t)(ms / 1000), (long)((ms % 1000) * 1000000L) };
    nanosleep(&ts, NULL);
}

/* "YYYY-MM-DD" for today (local) */
char *time_date(void) {
    time_t t = time(NULL); struct tm tm; localtime_r(&t, &tm);
    char b[16]; strftime(b, sizeof b, "%Y-%m-%d", &tm); return strdup(b);
}

/* "YYYY-MM-DD HH:MM:SS" for now (local) */
char *time_datetime(void) {
    time_t t = time(NULL); struct tm tm; localtime_r(&t, &tm);
    char b[32]; strftime(b, sizeof b, "%Y-%m-%d %H:%M:%S", &tm); return strdup(b);
}

/* format an epoch-seconds timestamp with a strftime pattern (local) */
char *time_strftime(const char *fmt, long long ts) {
    time_t t = (time_t)ts; struct tm tm; localtime_r(&t, &tm);
    char b[256]; strftime(b, sizeof b, fmt ? fmt : "", &tm); return strdup(b);
}

/* components of the current local time */
long long time_year(void)    { time_t t=time(NULL); struct tm tm; localtime_r(&t,&tm); return tm.tm_year+1900; }
long long time_month(void)   { time_t t=time(NULL); struct tm tm; localtime_r(&t,&tm); return tm.tm_mon+1; }
long long time_day(void)     { time_t t=time(NULL); struct tm tm; localtime_r(&t,&tm); return tm.tm_mday; }
long long time_hour(void)    { time_t t=time(NULL); struct tm tm; localtime_r(&t,&tm); return tm.tm_hour; }
long long time_minute(void)  { time_t t=time(NULL); struct tm tm; localtime_r(&t,&tm); return tm.tm_min; }
long long time_second(void)  { time_t t=time(NULL); struct tm tm; localtime_r(&t,&tm); return tm.tm_sec; }
long long time_weekday(void) { time_t t=time(NULL); struct tm tm; localtime_r(&t,&tm); return tm.tm_wday; }

char *time_version(void) { return strdup("time 1.0.0"); }
