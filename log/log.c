/* ═══════════════════════════════════════════════════════════════
   log — leveled logging for Ezy.

   Timestamped messages at four levels (debug/info/warn/error), with a
   minimum-level filter, optional ANSI colors, and output to stderr or a
   file. Thread-safe (a mutex guards the output).

   Build: gcc -shared -fPIC log.c -o liblog.so -lpthread
   ═══════════════════════════════════════════════════════════════ */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <pthread.h>

enum { L_DEBUG, L_INFO, L_WARN, L_ERROR };

static int   g_min    = L_INFO;          /* drop messages below this level */
static FILE *g_out    = NULL;            /* NULL → stderr */
static int   g_colors = 1;
static pthread_mutex_t g_mx = PTHREAD_MUTEX_INITIALIZER;

static const char *level_name(int l) {
    switch (l) { case L_DEBUG: return "DEBUG"; case L_INFO: return "INFO";
                 case L_WARN: return "WARN"; default: return "ERROR"; }
}
static const char *level_color(int l) {
    switch (l) { case L_DEBUG: return "\x1b[2;37m";   /* dim grey  */
                 case L_INFO:  return "\x1b[36m";      /* cyan      */
                 case L_WARN:  return "\x1b[33m";      /* yellow    */
                 default:      return "\x1b[1;31m"; }  /* bold red  */
}

static void emit(int level, const char *msg) {
    if (level < g_min) return;
    FILE *out = g_out ? g_out : stderr;
    pthread_mutex_lock(&g_mx);
    time_t t = time(NULL); struct tm tm; localtime_r(&t, &tm);
    char ts[24];
    strftime(ts, sizeof ts, "%Y-%m-%d %H:%M:%S", &tm);
    int color = g_colors && !g_out;      /* color only on stderr */
    if (color)
        fprintf(out, "\x1b[90m%s\x1b[0m %s%-5s\x1b[0m %s\n",
                ts, level_color(level), level_name(level), msg ? msg : "");
    else
        fprintf(out, "%s %-5s %s\n", ts, level_name(level), msg ? msg : "");
    fflush(out);
    pthread_mutex_unlock(&g_mx);
}

/* ── public API ── */
long long log_debug(const char *m) { emit(L_DEBUG, m); return 0; }
long long log_info(const char *m)  { emit(L_INFO,  m); return 0; }
long long log_warn(const char *m)  { emit(L_WARN,  m); return 0; }
long long log_error(const char *m) { emit(L_ERROR, m); return 0; }

/* minimum level: 0=debug 1=info 2=warn 3=error */
long long log_set_level(long long level) {
    if (level < L_DEBUG) level = L_DEBUG;
    if (level > L_ERROR) level = L_ERROR;
    g_min = (int)level; return 0;
}
long long log_get_level(void) { return g_min; }

/* redirect output to a file (append). Returns 1 on success. */
long long log_to_file(const char *path) {
    if (!path) return 0;
    FILE *f = fopen(path, "a");
    if (!f) return 0;
    pthread_mutex_lock(&g_mx);
    if (g_out) fclose(g_out);
    g_out = f;
    pthread_mutex_unlock(&g_mx);
    return 1;
}
long long log_to_stderr(void) {
    pthread_mutex_lock(&g_mx);
    if (g_out) fclose(g_out);
    g_out = NULL;
    pthread_mutex_unlock(&g_mx);
    return 0;
}
long long log_set_colors(long long on) { g_colors = on ? 1 : 0; return 0; }
