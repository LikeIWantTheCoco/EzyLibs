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
  #include <sys/types.h>
  #include <sys/wait.h>
  #include <signal.h>
  #include <glob.h>
  #define EZY_MKDIR(p)   mkdir((p), 0755)
  #define EZY_GETCWD     getcwd
  #define EZY_CHDIR      chdir
  #define EZY_POPEN      popen
  #define EZY_PCLOSE     pclose
#endif

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

/* Ezy's built-in array (matches the runtime layout); string arrays store each
   char* in a `data` slot. Used to accept a [string] argv in os_exec. */
typedef struct { long long len, cap; long long *data; } EzyArr;

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
/* the current user's home directory */
char *os_homedir(void) {
    const char *h = getenv("HOME");
    if (!h || !*h) h = getenv("USERPROFILE");   /* windows fallback */
    return strdup(h && *h ? h : "");
}
/* the system temp directory */
char *os_tmpdir(void) {
    const char *t = getenv("TMPDIR");
    if (!t || !*t) t = getenv("TMP");
    if (!t || !*t) t = getenv("TEMP");
    return strdup(t && *t ? t : "/tmp");
}
/* the current username */
char *os_user(void) {
    const char *u = getenv("USER");
    if (!u || !*u) u = getenv("LOGNAME");
    if (!u || !*u) u = getenv("USERNAME");      /* windows */
    return strdup(u && *u ? u : "");
}
/* all environment variables as newline-separated KEY=VALUE pairs */
char *os_environ(void) {
#ifdef _WIN32
    extern char **_environ; char **env = _environ;
#else
    extern char **environ; char **env = environ;
#endif
    size_t cap = 4096, len = 0; char *buf = malloc(cap);
    if (env) for (char **e = env; *e; e++) {
        size_t n = strlen(*e);
        if (len + n + 2 > cap) { while (len + n + 2 > cap) cap *= 2; buf = realloc(buf, cap); }
        if (len) buf[len++] = '\n';
        memcpy(buf + len, *e, n); len += n;
    }
    buf[len] = 0;
    return buf;
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
long long os_exec(EzyArr *argv) { (void)argv; return -1; }   /* see the per-OS os lib */
long long os_kill(long long pid, long long sig) { (void)pid; (void)sig; return 0; }
#else
long long os_pid(void)  { return (long long)getpid(); }
long long os_ppid(void) { return (long long)getppid(); }
char *os_hostname(void) {
    char b[256];
    if (gethostname(b, sizeof b) != 0) return strdup("");
    b[sizeof b - 1] = 0;
    return strdup(b);
}
/* run a program directly (no shell), wait, return its exit status.
   argv[0] is the program; args are passed verbatim (no quoting/injection). */
long long os_exec(EzyArr *argv) {
    if (!argv || argv->len <= 0) return -1;
    int n = (int)argv->len;
    char **a = malloc((size_t)(n + 1) * sizeof(char *));
    for (int i = 0; i < n; i++) a[i] = (char *)(size_t)argv->data[i];
    a[n] = NULL;
    pid_t pid = fork();
    if (pid < 0) { free(a); return -1; }
    if (pid == 0) { execvp(a[0], a); _exit(127); }
    free(a);
    int st; if (waitpid(pid, &st, 0) < 0) return -1;
    return WIFEXITED(st) ? (long long)WEXITSTATUS(st) : -1;
}
/* send signal `sig` to process `pid` (1 ok / 0 fail) */
long long os_kill(long long pid, long long sig) {
    return kill((pid_t)pid, (int)sig) == 0 ? 1 : 0;
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
/* create a directory and all missing parents (mkdir -p) */
long long os_mkdirs(const char *p) {
    if (!p || !*p) return 0;
    char tmp[PATH_MAX];
    snprintf(tmp, sizeof tmp, "%s", p);
    size_t n = strlen(tmp);
    if (n && tmp[n-1] == '/') tmp[n-1] = 0;
    for (char *c = tmp + 1; *c; c++) {
        if (*c == '/') {
            *c = 0;
            struct stat st;
            if (stat(tmp, &st) != 0) EZY_MKDIR(tmp);
            *c = '/';
        }
    }
    struct stat st;
    if (stat(tmp, &st) == 0) return S_ISDIR(st.st_mode) ? 1 : 0;
    return EZY_MKDIR(tmp) == 0 ? 1 : 0;
}
/* set file permissions from an octal string, e.g. "755" */
long long os_chmod(const char *p, const char *octal) {
#ifdef _WIN32
    (void)p; (void)octal; return 0;     /* Windows: see the per-OS os lib */
#else
    if (!p || !octal) return 0;
    long m = strtol(octal, NULL, 8);
    return chmod(p, (mode_t)m) == 0 ? 1 : 0;
#endif
}
/* test access: mode is any of "r","w","x" (e.g. "rw"); 1 if all are permitted */
long long os_access(const char *p, const char *mode) {
#ifdef _WIN32
    (void)mode; struct stat st; return (p && stat(p,&st)==0) ? 1 : 0;
#else
    if (!p) return 0;
    int m = F_OK;
    for (const char *c = mode ? mode : ""; *c; c++) {
        if (*c == 'r') m |= R_OK;
        else if (*c == 'w') m |= W_OK;
        else if (*c == 'x') m |= X_OK;
    }
    return access(p, m) == 0 ? 1 : 0;
#endif
}
/* expand a shell glob ("*.txt") → newline-separated matches */
char *os_glob(const char *pattern) {
#ifdef _WIN32
    (void)pattern; return strdup("");   /* Windows: see the per-OS os lib */
#else
    if (!pattern) return strdup("");
    glob_t g;
    if (glob(pattern, 0, NULL, &g) != 0) { globfree(&g); return strdup(""); }
    size_t cap = 4096, len = 0; char *buf = malloc(cap);
    for (size_t i = 0; i < g.gl_pathc; i++) {
        size_t n = strlen(g.gl_pathv[i]);
        if (len + n + 2 > cap) { while (len + n + 2 > cap) cap *= 2; buf = realloc(buf, cap); }
        if (len) buf[len++] = '\n';
        memcpy(buf + len, g.gl_pathv[i], n); len += n;
    }
    buf[len] = 0;
    globfree(&g);
    return buf;
#endif
}
/* create a unique temp file, return its path ("" on failure) */
char *os_tempfile(void) {
#ifdef _WIN32
    char *p = _tempnam(NULL, "ezy"); char *r = strdup(p ? p : ""); free(p); return r;
#else
    char tmpl[PATH_MAX];
    const char *d = getenv("TMPDIR"); if (!d || !*d) d = "/tmp";
    snprintf(tmpl, sizeof tmpl, "%s/ezyXXXXXX", d);
    int fd = mkstemp(tmpl);
    if (fd < 0) return strdup("");
    close(fd);
    return strdup(tmpl);
#endif
}
/* symbolic links */
long long os_symlink(const char *target, const char *linkpath) {
#ifdef _WIN32
    (void)target; (void)linkpath; return 0;
#else
    return (target && linkpath && symlink(target, linkpath) == 0) ? 1 : 0;
#endif
}
char *os_readlink(const char *p) {
#ifdef _WIN32
    (void)p; return strdup("");
#else
    if (!p) return strdup("");
    char buf[PATH_MAX];
    ssize_t n = readlink(p, buf, sizeof buf - 1);
    if (n < 0) return strdup("");
    buf[n] = 0; return strdup(buf);
#endif
}
long long os_islink(const char *p) {
#ifdef _WIN32
    (void)p; return 0;
#else
    struct stat st;
    return (p && lstat(p, &st) == 0 && S_ISLNK(st.st_mode)) ? 1 : 0;
#endif
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

/* is this an absolute path? */
long long os_isabs(const char *p) { return (p && p[0] == '/') ? 1 : 0; }

/* normalize a path: collapse "//", "." and ".." lexically (no filesystem access) */
char *os_normpath(const char *p) {
    if (!p || !*p) return strdup(".");
    int absolute = (p[0] == '/');
    /* split on '/', resolving . and .. into a component stack */
    char *parts[512]; int np = 0;
    char *work = strdup(p);
    for (char *tok = strtok(work, "/"); tok; tok = strtok(NULL, "/")) {
        if (!strcmp(tok, ".") || !*tok) continue;
        if (!strcmp(tok, "..")) {
            if (np > 0 && strcmp(parts[np-1], "..")) np--;
            else if (!absolute) parts[np++] = tok;   /* keep leading .. on relative paths */
        } else if (np < 512) parts[np++] = tok;
    }
    size_t cap = strlen(p) + 4, len = 0; char *out = malloc(cap);
    if (absolute) out[len++] = '/';
    for (int i = 0; i < np; i++) {
        if (i) out[len++] = '/';
        size_t n = strlen(parts[i]); memcpy(out + len, parts[i], n); len += n;
    }
    if (len == 0) out[len++] = absolute ? '/' : '.';
    out[len] = 0;
    free(work);
    return out;
}

/* path of `target` relative to `base` (base defaults to the cwd if empty) */
char *os_relpath(const char *target, const char *base) {
    if (!target) return strdup(".");
    char *cwd = NULL;
    if (!base || !*base) { cwd = os_getcwd(); base = cwd; }
    char *at = os_abspath(target), *ab = os_abspath(base);
    char *nt = os_normpath(at), *nb = os_normpath(ab);
    free(at); free(ab);
    /* split both into components */
    char *tw = strdup(nt), *bw = strdup(nb);
    char *tp[512], *bp[512]; int nt2 = 0, nb2 = 0;
    for (char *t = strtok(tw, "/"); t; t = strtok(NULL, "/")) if (nt2 < 512) tp[nt2++] = t;
    for (char *b = strtok(bw, "/"); b; b = strtok(NULL, "/")) if (nb2 < 512) bp[nb2++] = b;
    int i = 0; while (i < nt2 && i < nb2 && !strcmp(tp[i], bp[i])) i++;
    size_t cap = strlen(nt) + (size_t)nb2 * 3 + 8, len = 0; char *out = malloc(cap);
    for (int j = i; j < nb2; j++) { memcpy(out+len, "../", 3); len += 3; }   /* up from base */
    for (int j = i; j < nt2; j++) {                                          /* down to target */
        size_t n = strlen(tp[j]); memcpy(out+len, tp[j], n); len += n;
        if (j < nt2 - 1) out[len++] = '/';
    }
    if (len == 0) out[len++] = '.';
    else if (out[len-1] == '/') len--;
    out[len] = 0;
    free(nt); free(nb); free(tw); free(bw); free(cwd);
    return out;
}

char *os_version(void) { return strdup("os 1.0.0"); }
