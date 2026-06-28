/* ═══════════════════════════════════════════════════════════════
   os_background — run app work off the main thread (extension of `os`).

   A cross-platform background task runner built on the one primitive that
   exists everywhere: threads (POSIX pthreads on linux/macos/android/ios,
   Win32 threads on windows). Tasks are Ezy `fn()` callbacks.

     os_bg_run(cb)            run cb once on a background thread
     os_bg_every(ms, cb)      run cb every `ms` ms -> task id (>=0)
     os_bg_stop(id)           stop a periodic task
     os_bg_stop_all()

   NOTE on true OS background (running while the app is *suspended*): that is
   OS-managed — Android needs a foreground Service + the "background"
   permission (FOREGROUND_SERVICE), iOS needs Background Modes / BGTaskScheduler
   in Info.plist. Threads keep running while the app is alive/foregrounded and
   briefly after; for long-lived suspended work, request "background" via
   os_permissions and have the host (swiss) declare the platform background
   capability. The thread API below is identical on all five targets.
   Build: extends "os".
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
  #define BG_WINDOWS 1
  #include <windows.h>
#else
  #define BG_POSIX 1
  #include <pthread.h>
  #include <unistd.h>
  #include <time.h>
#endif

typedef void (*bg_cb)(void);
#define BG_MAX 64

typedef struct {
    int       used;
    int       periodic;
    long long interval_ms;
    bg_cb     cb;
    volatile int stop;
#if defined(BG_WINDOWS)
    HANDLE    th;
#else
    pthread_t th;
#endif
} bg_task;

static bg_task g_tasks[BG_MAX];

static void bg_sleep_ms(long long ms) {
    if (ms <= 0) return;
#if defined(BG_WINDOWS)
    Sleep((DWORD)ms);
#else
    struct timespec ts = { (time_t)(ms / 1000), (long)((ms % 1000) * 1000000L) };
    nanosleep(&ts, NULL);
#endif
}

/* the thread body: run once, or loop until stopped */
static void bg_body(bg_task *t) {
    if (!t->periodic) { if (t->cb) t->cb(); return; }
    while (!t->stop) {
        if (t->cb) t->cb();
        /* sleep in small slices so stop is responsive */
        long long left = t->interval_ms;
        while (left > 0 && !t->stop) { long long s = left > 100 ? 100 : left; bg_sleep_ms(s); left -= s; }
    }
}
#if defined(BG_WINDOWS)
static DWORD WINAPI bg_thunk(LPVOID p) { bg_body((bg_task *)p); return 0; }
#else
static void *bg_thunk(void *p) { bg_body((bg_task *)p); return NULL; }
#endif

static int bg_alloc(void) {
    for (int i = 0; i < BG_MAX; i++) if (!g_tasks[i].used) { memset(&g_tasks[i], 0, sizeof(bg_task)); g_tasks[i].used = 1; return i; }
    return -1;
}
static int bg_spawn(int i) {
#if defined(BG_WINDOWS)
    g_tasks[i].th = CreateThread(NULL, 0, bg_thunk, &g_tasks[i], 0, NULL);
    return g_tasks[i].th ? 0 : -1;
#else
    return pthread_create(&g_tasks[i].th, NULL, bg_thunk, &g_tasks[i]) == 0 ? 0 : -1;
#endif
}

/* run a callback once on a background thread; 1 on success */
long long os_bg_run(bg_cb cb) {
    if (!cb) return 0;
    int i = bg_alloc(); if (i < 0) return 0;
    g_tasks[i].periodic = 0; g_tasks[i].cb = cb;
    if (bg_spawn(i) != 0) { g_tasks[i].used = 0; return 0; }
    return 1;
}

/* run a callback every `ms` milliseconds; returns a task id (>=0) or -1 */
long long os_bg_every(long long ms, bg_cb cb) {
    if (!cb || ms <= 0) return -1;
    int i = bg_alloc(); if (i < 0) return -1;
    g_tasks[i].periodic = 1; g_tasks[i].interval_ms = ms; g_tasks[i].cb = cb;
    if (bg_spawn(i) != 0) { g_tasks[i].used = 0; return -1; }
    return i;
}

/* stop a periodic task by id; 1 on success */
long long os_bg_stop(long long id) {
    if (id < 0 || id >= BG_MAX || !g_tasks[id].used) return 0;
    g_tasks[id].stop = 1;
#if defined(BG_WINDOWS)
    if (g_tasks[id].th) { WaitForSingleObject(g_tasks[id].th, 2000); CloseHandle(g_tasks[id].th); }
#else
    pthread_join(g_tasks[id].th, NULL);
#endif
    g_tasks[id].used = 0;
    return 1;
}

/* stop every periodic task */
long long os_bg_stop_all(void) {
    long long n = 0;
    for (int i = 0; i < BG_MAX; i++) if (g_tasks[i].used && g_tasks[i].periodic) n += os_bg_stop(i);
    return n;
}

char *os_background_version(void) { return strdup("os_background 1.0.0"); }
