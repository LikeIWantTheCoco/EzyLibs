/* ═══════════════════════════════════════════════════════════════
   os — operating-system utilities for Ezy: environment, processes,
   filesystem and path manipulation.

   The filesystem/path half used to be baked into the Ezy runtime;
   it now lives here so the runtime stays minimal, alongside new
   process/environment helpers. Thin wrappers over POSIX / libc.
   Returned strings are heap-allocated (the Ezy arena owns them).

   Build: gcc -shared -fPIC os.c -o libos.so
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <dirent.h>
#include <sys/stat.h>

#ifdef _WIN32
  #include <windows.h>
  #include <direct.h>
  #include <process.h>
  #define EZY_MKDIR(p)   _mkdir(p)
  #define EZY_GETCWD     _getcwd
  #define EZY_CHDIR      _chdir
  #define EZY_POPEN      _popen
  #define EZY_PCLOSE     _pclose
#else
  #include <unistd.h>
  #include <sys/utsname.h>
  #define EZY_MKDIR(p)   mkdir((p), 0755)
  #define EZY_GETCWD     getcwd
  #define EZY_CHDIR      chdir
  #define EZY_POPEN      popen
  #define EZY_PCLOSE     pclose
#endif

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

/* ───────────────────────── environment ───────────────────────── */
char *os_getenv(const char *name) {
    if (!name) return strdup("");
    const char *v = getenv(name);
    return strdup(v ? v : "");
}
long long os_setenv(const char *name, const char *value) {
    if (!name) return 0;
#ifdef _WIN32
    return _putenv_s(name, value ? value : "") == 0 ? 1 : 0;
#else
    return setenv(name, value ? value : "", 1) == 0 ? 1 : 0;
#endif
}
long long os_unsetenv(const char *name) {
    if (!name) return 0;
#ifdef _WIN32
    return _putenv_s(name, "") == 0 ? 1 : 0;
#else
    return unsetenv(name) == 0 ? 1 : 0;
#endif
}

/* ───────────────────────── processes ───────────────────────── */
/* run a shell command, return its exit status (-1 on failure) */
long long os_run(const char *cmd) {
    if (!cmd) return -1;
    int rc = system(cmd);
    if (rc == -1) return -1;
    return (long long)((rc >> 8) & 0xff);   /* WEXITSTATUS */
}
/* run a command and capture its stdout as a string */
char *os_run_capture(const char *cmd) {
    if (!cmd) return strdup("");
    FILE *p = EZY_POPEN(cmd, "r");
    if (!p) return strdup("");
    size_t cap = 4096, len = 0;
    char *buf = malloc(cap);
    size_t n;
    char tmp[4096];
    while ((n = fread(tmp, 1, sizeof tmp, p)) > 0) {
        if (len + n + 1 > cap) { while (len + n + 1 > cap) cap *= 2; buf = realloc(buf, cap); }
        memcpy(buf + len, tmp, n); len += n;
    }
    buf[len] = 0;
    EZY_PCLOSE(p);
    return buf;
}
#ifdef _WIN32
long long os_pid(void)  { return (long long)_getpid(); }
long long os_ppid(void) { return 0; }
char *os_hostname(void) { const char *h = getenv("COMPUTERNAME"); return strdup(h ? h : ""); }
char *os_platform(void) { return strdup("windows"); }
char *os_arch(void)     { const char *a = getenv("PROCESSOR_ARCHITECTURE"); return strdup(a ? a : "x86_64"); }
#else
long long os_pid(void)  { return (long long)getpid(); }
long long os_ppid(void) { return (long long)getppid(); }
char *os_hostname(void) {
    char b[256];
    if (gethostname(b, sizeof b) != 0) return strdup("");
    b[sizeof b - 1] = 0;
    return strdup(b);
}
/* OS name: "linux", "darwin", ... (lowercased uname sysname) */
char *os_platform(void) {
    struct utsname u;
    if (uname(&u) != 0) return strdup("unknown");
    for (char *c = u.sysname; *c; c++) if (*c >= 'A' && *c <= 'Z') *c += 32;
    return strdup(u.sysname);
}
/* CPU architecture: "x86_64", "aarch64", ... */
char *os_arch(void) {
    struct utsname u;
    if (uname(&u) != 0) return strdup("unknown");
    return strdup(u.machine);
}
#endif

/* ───────────────────────── directories / cwd ───────────────────────── */
char *os_getcwd(void) {
    char buf[PATH_MAX];
    if (!EZY_GETCWD(buf, sizeof buf)) return strdup(".");
    return strdup(buf);
}
long long os_chdir(const char *p) { return (p && EZY_CHDIR(p) == 0) ? 1 : 0; }

long long os_mkdir(const char *p) {
    if (!p) return 0;
    return EZY_MKDIR(p) == 0 ? 1 : 0;
}
/* remove a file, or a directory and everything under it */
long long os_rmdir(const char *p) {
    if (!p) return 0;
    struct stat st;
    if (stat(p, &st) != 0) return 0;
    if (S_ISDIR(st.st_mode)) {
        DIR *d = opendir(p);
        if (d) {
            struct dirent *e;
            while ((e = readdir(d))) {
                if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
                char ch[PATH_MAX];
                snprintf(ch, sizeof ch, "%s/%s", p, e->d_name);
                os_rmdir(ch);
            }
            closedir(d);
        }
        return rmdir(p) == 0 ? 1 : 0;
    }
    return remove(p) == 0 ? 1 : 0;
}
/* newline-separated directory listing (os.list() in the header splits it) */
char *os_listdir(const char *p) {
    if (!p) p = ".";
    DIR *d = opendir(p);
    if (!d) return strdup("");
    size_t cap = 4096, pos = 0;
    char *buf = malloc(cap);
    struct dirent *e;
    int first = 1;
    while ((e = readdir(d)) != NULL) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        size_t nl = strlen(e->d_name);
        if (pos + nl + 2 > cap) { while (pos + nl + 2 > cap) cap *= 2; buf = realloc(buf, cap); }
        if (!first) buf[pos++] = '\n';
        memcpy(buf + pos, e->d_name, nl); pos += nl;
        first = 0;
    }
    closedir(d);
    buf[pos] = 0;
    return buf;
}

/* ───────────────────────── files ───────────────────────── */
char *os_read(const char *p) {
    if (!p) return strdup("");
    FILE *f = fopen(p, "rb");
    if (!f) return strdup("");
    fseek(f, 0, SEEK_END); long sz = ftell(f); rewind(f);
    char *b = malloc((size_t)sz + 1);
    size_t r = fread(b, 1, (size_t)sz, f); b[r] = 0;
    fclose(f); return b;
}
long long os_write(const char *p, const char *s) {
    if (!p || !s) return 0;
    FILE *f = fopen(p, "w"); if (!f) return 0;
    fputs(s, f); fclose(f); return 1;
}
long long os_append(const char *p, const char *s) {
    if (!p || !s) return 0;
    FILE *f = fopen(p, "a"); if (!f) return 0;
    fputs(s, f); fclose(f); return 1;
}
long long os_delete(const char *p)  { return (p && remove(p) == 0) ? 1 : 0; }
long long os_move(const char *a, const char *b) { return (a && b && rename(a, b) == 0) ? 1 : 0; }
long long os_touch(const char *p) {
    if (!p) return 0;
    FILE *f = fopen(p, "a"); if (!f) return 0; fclose(f); return 1;
}
long long os_copy(const char *s, const char *d) {
    if (!s || !d) return 0;
    FILE *in = fopen(s, "rb"); if (!in) return 0;
    FILE *out = fopen(d, "wb"); if (!out) { fclose(in); return 0; }
    char buf[8192]; size_t n;
    while ((n = fread(buf, 1, sizeof buf, in)) > 0) fwrite(buf, 1, n, out);
    fclose(in); fclose(out); return 1;
}
long long os_filesize(const char *p) {
    if (!p) return -1;
    struct stat st;
    if (stat(p, &st) != 0) return -1;
    return (long long)st.st_size;
}

/* ───────────────────────── path queries ───────────────────────── */
long long os_exists(const char *p) { struct stat st; return (p && stat(p,&st)==0) ? 1 : 0; }
long long os_isfile(const char *p) { struct stat st; return (p && stat(p,&st)==0 && S_ISREG(st.st_mode)) ? 1 : 0; }
long long os_isdir(const char *p)  { struct stat st; return (p && stat(p,&st)==0 && S_ISDIR(st.st_mode)) ? 1 : 0; }
long long os_mtime(const char *p)  { struct stat st; return (p && stat(p,&st)==0) ? (long long)st.st_mtime : 0; }

/* ───────────────────────── path manipulation ───────────────────────── */
char *os_dirname(const char *p) {
    if (!p || !*p) return strdup(".");
    char *c = strdup(p);
    char *s = strrchr(c, '/');
    if (!s) { free(c); return strdup("."); }
    if (s == c) { free(c); return strdup("/"); }
    *s = 0; char *r = strdup(c); free(c); return r;
}
char *os_basename(const char *p) {
    if (!p || !*p) return strdup(".");
    int n = (int)strlen(p);
    while (n > 1 && p[n-1] == '/') n--;
    int i = n - 1;
    while (i > 0 && p[i] != '/') i--;
    if (p[i] == '/') i++;
    char *r = malloc(n - i + 1);
    memcpy(r, p + i, n - i); r[n-i] = 0; return r;
}
char *os_path_join(const char *a, const char *b) {
    if (!a) return strdup(b ? b : "");
    if (!b) return strdup(a);
    if (b[0] == '/') return strdup(b);          /* absolute second arg wins */
    int la = (int)strlen(a), lb = (int)strlen(b);
    int sep = (la > 0 && a[la-1] != '/');
    char *r = malloc(la + lb + sep + 1);
    memcpy(r, a, la);
    if (sep) r[la++] = '/';
    memcpy(r + la, b, lb + 1); return r;
}
char *os_path_ext(const char *p) {
    if (!p) return strdup("");
    const char *bn = strrchr(p, '/'); bn = bn ? bn + 1 : p;
    const char *dot = strrchr(bn, '.');
    if (!dot || dot == bn) return strdup("");
    return strdup(dot);
}
char *os_path_stem(const char *p) {
    if (!p) return strdup("");
    const char *bn = strrchr(p, '/'); bn = bn ? bn + 1 : p;
    const char *dot = strrchr(bn, '.');
    if (!dot || dot == bn) return strdup(bn);
    char *r = malloc(dot - bn + 1);
    memcpy(r, bn, dot - bn); r[dot-bn] = 0; return r;
}
char *os_abspath(const char *p) {
    if (!p) return strdup(".");
    char r[PATH_MAX];
#ifdef _WIN32
    if (!_fullpath(r, p, sizeof r)) return strdup(p);
#else
    if (!realpath(p, r)) return strdup(p);
#endif
    return strdup(r);
}

char *os_version(void) { return strdup("os 1.0.0"); }
