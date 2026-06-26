/* ═══════════════════════════════════════════════════════════════
   webdriver — browser automation for Ezy via the Chrome DevTools
   Protocol (CDP). Chromium only (for now).

   Self-contained: launches the browser with a remote-debugging port,
   discovers a page target over HTTP, opens the DevTools WebSocket,
   and drives it with CDP JSON commands. No external deps beyond a
   Chromium/Chrome binary on PATH.

   Most high-level element work is done by injecting JavaScript through
   Runtime.evaluate; real input (human-curved mouse, paced typing) goes
   through the CDP Input domain so pages see genuine events.

   The flat C functions below are wrapped into an OOP API (Browser /
   Element classes) in webdriver.ez.

   Build: gcc -shared -fPIC webdriver.c -o libwebdriver.so
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <ctype.h>
#include <time.h>
#include <math.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <signal.h>
#include <fcntl.h>

/* ───────────────────────── dynamic string ───────────────────────── */
typedef struct { char *p; size_t len, cap; } str_t;
static void str_init(str_t *s) { s->cap = 256; s->len = 0; s->p = malloc(s->cap); s->p[0] = 0; }
static void str_ensure(str_t *s, size_t extra) {
    if (s->len + extra + 1 > s->cap) {
        while (s->len + extra + 1 > s->cap) s->cap *= 2;
        s->p = realloc(s->p, s->cap);
    }
}
static void str_addn(str_t *s, const char *b, size_t n) { str_ensure(s, n); memcpy(s->p + s->len, b, n); s->len += n; s->p[s->len] = 0; }
static void str_add(str_t *s, const char *b) { str_addn(s, b, strlen(b)); }
static void str_addc(str_t *s, char c) { str_ensure(s, 1); s->p[s->len++] = c; s->p[s->len] = 0; }

/* JSON-escape `in` into `out` (out already initialised) */
static void json_escape(str_t *out, const char *in) {
    for (; *in; in++) {
        unsigned char c = *in;
        switch (c) {
            case '"':  str_add(out, "\\\""); break;
            case '\\': str_add(out, "\\\\"); break;
            case '\n': str_add(out, "\\n");  break;
            case '\r': str_add(out, "\\r");  break;
            case '\t': str_add(out, "\\t");  break;
            default:
                if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); str_add(out, b); }
                else str_addc(out, (char)c);
        }
    }
}

/* ───────────────────────── base64 ───────────────────────── */
static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static char *b64_encode(const unsigned char *in, size_t n) {
    char *out = malloc(((n + 2) / 3) * 4 + 1); size_t o = 0;
    for (size_t i = 0; i < n; i += 3) {
        unsigned v = in[i] << 16;
        if (i + 1 < n) v |= in[i+1] << 8;
        if (i + 2 < n) v |= in[i+2];
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = (i + 1 < n) ? B64[(v >> 6) & 63] : '=';
        out[o++] = (i + 2 < n) ? B64[v & 63] : '=';
    }
    out[o] = 0; return out;
}
static int b64_val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}
static unsigned char *b64_decode(const char *in, size_t *outlen) {
    size_t n = strlen(in);
    unsigned char *out = malloc(n / 4 * 3 + 4); size_t o = 0;
    int buf = 0, bits = 0;
    for (size_t i = 0; i < n; i++) {
        if (in[i] == '=' || isspace((unsigned char)in[i])) continue;
        int v = b64_val(in[i]); if (v < 0) continue;
        buf = (buf << 6) | v; bits += 6;
        if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff; }
    }
    *outlen = o; return out;
}

/* ───────────────────────── minimal JSON parser ─────────────────────────
   Parses into a node tree; enough to read CDP responses. */
typedef enum { JNULL, JBOOL, JNUM, JSTR, JARR, JOBJ } jtype;
typedef struct jnode {
    jtype t;
    double num; int b;
    char *str;                 /* unescaped string (JSTR) or key storage */
    struct jnode **kids; char **keys; int nkids, cap;
} jnode;

static void j_free(jnode *n) {
    if (!n) return;
    for (int i = 0; i < n->nkids; i++) { free(n->keys ? n->keys[i] : NULL); j_free(n->kids[i]); }
    free(n->kids); free(n->keys); free(n->str); free(n);
}
static jnode *j_new(jtype t) { jnode *n = calloc(1, sizeof *n); n->t = t; return n; }
static void j_push(jnode *p, char *key, jnode *c) {
    if (p->nkids >= p->cap) { p->cap = p->cap ? p->cap * 2 : 8; p->kids = realloc(p->kids, p->cap * sizeof *p->kids); p->keys = realloc(p->keys, p->cap * sizeof *p->keys); }
    p->keys[p->nkids] = key; p->kids[p->nkids] = c; p->nkids++;
}

static const char *j_skip(const char *s) { while (*s && (*s==' '||*s=='\t'||*s=='\n'||*s=='\r')) s++; return s; }
static const char *j_parse(const char *s, jnode **out);

static const char *j_str(const char *s, char **out) {
    str_t b; str_init(&b); s++; /* opening quote */
    while (*s && *s != '"') {
        if (*s == '\\') {
            s++;
            switch (*s) {
                case 'n': str_addc(&b, '\n'); break;
                case 't': str_addc(&b, '\t'); break;
                case 'r': str_addc(&b, '\r'); break;
                case 'b': str_addc(&b, '\b'); break;
                case 'f': str_addc(&b, '\f'); break;
                case '/': str_addc(&b, '/');  break;
                case '"': str_addc(&b, '"');  break;
                case '\\':str_addc(&b, '\\'); break;
                case 'u': {
                    char hex[5] = {s[1],s[2],s[3],s[4],0};
                    int cp = (int)strtol(hex, NULL, 16); s += 4;
                    if (cp < 0x80) str_addc(&b, (char)cp);
                    else if (cp < 0x800) { str_addc(&b, 0xC0|(cp>>6)); str_addc(&b, 0x80|(cp&0x3F)); }
                    else { str_addc(&b, 0xE0|(cp>>12)); str_addc(&b, 0x80|((cp>>6)&0x3F)); str_addc(&b, 0x80|(cp&0x3F)); }
                } break;
                default: str_addc(&b, *s);
            }
            s++;
        } else str_addc(&b, *s++);
    }
    if (*s == '"') s++;
    *out = b.p; return s;
}

static const char *j_parse(const char *s, jnode **out) {
    s = j_skip(s);
    if (*s == '{') {
        jnode *n = j_new(JOBJ); s++;
        s = j_skip(s);
        while (*s && *s != '}') {
            char *key = NULL; s = j_str(s, &key); s = j_skip(s);
            if (*s == ':') s++;
            jnode *v; s = j_parse(s, &v);
            j_push(n, key, v); s = j_skip(s);
            if (*s == ',') { s++; s = j_skip(s); }
        }
        if (*s == '}') s++;
        *out = n; return s;
    }
    if (*s == '[') {
        jnode *n = j_new(JARR); s++; s = j_skip(s);
        while (*s && *s != ']') {
            jnode *v; s = j_parse(s, &v);
            j_push(n, NULL, v); s = j_skip(s);
            if (*s == ',') { s++; s = j_skip(s); }
        }
        if (*s == ']') s++;
        *out = n; return s;
    }
    if (*s == '"') { jnode *n = j_new(JSTR); s = j_str(s, &n->str); *out = n; return s; }
    if (!strncmp(s, "true", 4))  { jnode *n = j_new(JBOOL); n->b = 1; *out = n; return s + 4; }
    if (!strncmp(s, "false", 5)) { jnode *n = j_new(JBOOL); n->b = 0; *out = n; return s + 5; }
    if (!strncmp(s, "null", 4))  { *out = j_new(JNULL); return s + 4; }
    { jnode *n = j_new(JNUM); char *e; n->num = strtod(s, &e); *out = n; return e; }
}
static jnode *json_parse(const char *s) { jnode *n; j_parse(s, &n); return n; }
static jnode *j_get(jnode *o, const char *key) {
    if (!o || o->t != JOBJ) return NULL;
    for (int i = 0; i < o->nkids; i++) if (o->keys[i] && !strcmp(o->keys[i], key)) return o->kids[i];
    return NULL;
}
/* dotted path, e.g. "result.result.value" */
static jnode *j_path(jnode *o, const char *path) {
    char tmp[256]; strncpy(tmp, path, sizeof tmp - 1); tmp[sizeof tmp - 1] = 0;
    jnode *cur = o;
    for (char *t = strtok(tmp, "."); t && cur; t = strtok(NULL, ".")) cur = j_get(cur, t);
    return cur;
}

/* ───────────────────────── sockets ───────────────────────── */
static int readn(int fd, void *buf, size_t n) {
    size_t got = 0; char *p = buf;
    while (got < n) {
        ssize_t r = recv(fd, p + got, n - got, 0);
        if (r <= 0) return -1;
        got += r;
    }
    return 0;
}
static int writen(int fd, const void *buf, size_t n) {
    size_t sent = 0; const char *p = buf;
    while (sent < n) {
        ssize_t w = send(fd, p + sent, n - sent, MSG_NOSIGNAL);
        if (w <= 0) return -1;
        sent += w;
    }
    return 0;
}
static int tcp_connect(const char *host, int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_in a; memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_port = htons(port);
    if (inet_pton(AF_INET, host, &a.sin_addr) <= 0) {
        struct hostent *he = gethostbyname(host);
        if (!he) { close(fd); return -1; }
        memcpy(&a.sin_addr, he->h_addr, he->h_length);
    }
    if (connect(fd, (struct sockaddr *)&a, sizeof a) < 0) { close(fd); return -1; }
    return fd;
}

/* HTTP GET, returns malloc'd body (caller frees) or NULL */
static char *http_get(const char *host, int port, const char *path) {
    int fd = tcp_connect(host, port);
    if (fd < 0) return NULL;
    /* DevTools' HTTP server may not close the socket; bound the read */
    struct timeval tv = { 2, 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    str_t req; str_init(&req);
    str_add(&req, "GET "); str_add(&req, path);
    str_add(&req, " HTTP/1.1\r\nHost: "); str_add(&req, host);
    str_add(&req, "\r\nConnection: close\r\n\r\n");
    if (writen(fd, req.p, req.len) < 0) { free(req.p); close(fd); return NULL; }
    free(req.p);

    str_t resp; str_init(&resp);
    char buf[4096]; ssize_t r;
    while ((r = recv(fd, buf, sizeof buf, 0)) > 0) str_addn(&resp, buf, r);
    close(fd);
    char *body = strstr(resp.p, "\r\n\r\n");
    char *out = strdup(body ? body + 4 : resp.p);
    free(resp.p);
    return out;
}

/* ───────────────────────── WebSocket client ───────────────────────── */
static int ws_handshake(int fd, const char *host, int port, const char *path) {
    unsigned char key[16];
    for (int i = 0; i < 16; i++) key[i] = rand() & 0xff;
    char *k = b64_encode(key, 16);
    str_t req; str_init(&req);
    str_add(&req, "GET "); str_add(&req, path); str_add(&req, " HTTP/1.1\r\n");
    str_add(&req, "Host: "); str_add(&req, host); { char b[16]; snprintf(b, sizeof b, ":%d", port); str_add(&req, b); }
    str_add(&req, "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n");
    str_add(&req, "Sec-WebSocket-Key: "); str_add(&req, k); str_add(&req, "\r\n");
    str_add(&req, "Sec-WebSocket-Version: 13\r\n\r\n");
    free(k);
    int rc = writen(fd, req.p, req.len); free(req.p);
    if (rc < 0) return -1;
    /* read response headers up to \r\n\r\n */
    str_t resp; str_init(&resp); char c;
    while (recv(fd, &c, 1, 0) == 1) {
        str_addc(&resp, c);
        if (resp.len >= 4 && !memcmp(resp.p + resp.len - 4, "\r\n\r\n", 4)) break;
        if (resp.len > 8192) break;
    }
    int ok = strstr(resp.p, "101") != NULL;
    free(resp.p);
    return ok ? 0 : -1;
}
static int ws_send(int fd, const char *data) {
    size_t n = strlen(data);
    str_t f; str_init(&f);
    str_addc(&f, (char)0x81);              /* FIN + text */
    unsigned char mask[4]; for (int i = 0; i < 4; i++) mask[i] = rand() & 0xff;
    if (n <= 125) { str_addc(&f, (char)(0x80 | n)); }
    else if (n <= 0xFFFF) { str_addc(&f, (char)(0x80 | 126)); str_addc(&f, (n>>8)&0xff); str_addc(&f, n&0xff); }
    else { str_addc(&f, (char)(0x80 | 127)); for (int i = 7; i >= 0; i--) str_addc(&f, (n >> (i*8)) & 0xff); }
    str_addn(&f, (char *)mask, 4);
    for (size_t i = 0; i < n; i++) str_addc(&f, data[i] ^ mask[i & 3]);
    int rc = writen(fd, f.p, f.len); free(f.p);
    return rc;
}
/* receive one full (possibly fragmented) text message; malloc'd, caller frees */
static char *ws_recv(int fd) {
    str_t msg; str_init(&msg);
    for (;;) {
        unsigned char h[2];
        if (readn(fd, h, 2) < 0) { free(msg.p); return NULL; }
        int fin = h[0] & 0x80, op = h[0] & 0x0f;
        unsigned long len = h[1] & 0x7f;
        if (len == 126) { unsigned char e[2]; if (readn(fd, e, 2) < 0) { free(msg.p); return NULL; } len = (e[0]<<8)|e[1]; }
        else if (len == 127) { unsigned char e[8]; if (readn(fd, e, 8) < 0) { free(msg.p); return NULL; } len = 0; for (int i = 0; i < 8; i++) len = (len<<8)|e[i]; }
        if (h[1] & 0x80) { unsigned char mk[4]; if (readn(fd, mk, 4) < 0) { free(msg.p); return NULL; } } /* server frames unmasked normally */
        char *payload = malloc(len + 1);
        if (len && readn(fd, payload, len) < 0) { free(payload); free(msg.p); return NULL; }
        payload[len] = 0;
        if (op == 0x8) { free(payload); free(msg.p); return NULL; }     /* close */
        if (op == 0x9) { free(payload); continue; }                     /* ping → ignore */
        if (op == 0xA) { free(payload); continue; }                     /* pong */
        str_addn(&msg, payload, len); free(payload);
        if (fin) break;
    }
    return msg.p;
}

/* ───────────────────────── sessions ───────────────────────── */
#define WD_MAX 8
#define WD_CDP  0     /* Chromium DevTools Protocol */
#define WD_BIDI 1     /* Firefox/Gecko WebDriver BiDi */
typedef struct {
    int used, fd, port;
    pid_t pid;
    int next_id;
    int proto;             /* WD_CDP | WD_BIDI */
    char ctx[96];          /* BiDi browsing-context id */
    char profile_dir[256];
} wd_session;
static wd_session g_sess[WD_MAX];
static int g_seeded = 0;
static void seed_once(void) { if (!g_seeded) { srand((unsigned)(time(NULL) ^ getpid())); g_seeded = 1; } }

static void msleep(long ms) { struct timespec ts = { ms/1000, (ms%1000)*1000000L }; nanosleep(&ts, NULL); }
static double frand(void) { return rand() / (RAND_MAX + 1.0); }
static double frange(double a, double b) { return a + frand()*(b-a); }

/* one CDP request/response. Returns malloc'd JSON response (the whole frame),
   or NULL. Skips event frames (those without our id). */
static char *cdp_call(wd_session *s, const char *method, const char *params) {
    int id = ++s->next_id;
    str_t req; str_init(&req);
    char head[64]; snprintf(head, sizeof head, "{\"id\":%d,\"method\":\"", id);
    str_add(&req, head); str_add(&req, method); str_add(&req, "\",\"params\":");
    str_add(&req, params && *params ? params : "{}");
    str_addc(&req, '}');
    int rc = ws_send(s->fd, req.p); free(req.p);
    if (rc < 0) return NULL;
    for (int tries = 0; tries < 1000; tries++) {
        char *r = ws_recv(s->fd);
        if (!r) return NULL;
        jnode *root = json_parse(r);
        jnode *jid = j_get(root, "id");
        if (jid && jid->t == JNUM && (int)jid->num == id) { j_free(root); return r; }
        j_free(root); free(r);   /* event or other id → keep reading */
    }
    return NULL;
}

/* extract result.result.value (shared by CDP Runtime.evaluate and BiDi
   script.evaluate — both serialise primitives at the same path) */
static char *extract_value(const char *resp) {
    if (!resp) return strdup("");
    jnode *root = json_parse(resp);
    jnode *v = j_path(root, "result.result.value");
    char *out;
    if (!v) out = strdup("");
    else if (v->t == JSTR) out = strdup(v->str);
    else if (v->t == JBOOL) out = strdup(v->b ? "true" : "false");
    else if (v->t == JNUM) { char b[64]; if (v->num == (long long)v->num) snprintf(b,sizeof b,"%lld",(long long)v->num); else snprintf(b,sizeof b,"%g",v->num); out = strdup(b); }
    else out = strdup("");
    j_free(root);
    return out;
}
/* evaluate JS in the page, protocol-aware → malloc'd string ("" on null) */
static char *js_eval(wd_session *s, const char *expr) {
    str_t p; str_init(&p);
    if (s->proto == WD_BIDI) {
        str_add(&p, "{\"expression\":\""); json_escape(&p, expr);
        str_add(&p, "\",\"awaitPromise\":true,\"target\":{\"context\":\"");
        str_add(&p, s->ctx); str_add(&p, "\"}}");
        char *resp = cdp_call(s, "script.evaluate", p.p); free(p.p);
        char *out = extract_value(resp); free(resp); return out;
    }
    str_add(&p, "{\"expression\":\""); json_escape(&p, expr);
    str_add(&p, "\",\"returnByValue\":true,\"awaitPromise\":true}");
    char *resp = cdp_call(s, "Runtime.evaluate", p.p); free(p.p);
    char *out = extract_value(resp); free(resp); return out;
}
#define cdp_eval js_eval   /* internal callers go through the dispatcher */

/* forward declarations for functions used before their definition */
long long wd_set_user_agent(long long h, const char *ua);
long long wd_wait_ready(long long h, long long timeout_ms);
char *wd_current_url(long long h);

/* ───────────────────────── browser launch ───────────────────────── */
static const char *find_chrome(void) {
    /* allow an explicit override */
    const char *env = getenv("EZY_CHROME");
    if (env && *env && access(env, X_OK) == 0) return env;
    static const char *cands[] = {
        "chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
        "brave-browser", "brave",
        "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
        "/usr/bin/brave-browser", "/usr/bin/brave",
        "/opt/brave.com/brave/brave", "/opt/brave.com/brave/brave-browser",
        "/snap/bin/chromium", "/snap/bin/brave", "/opt/google/chrome/chrome", NULL };
    for (int i = 0; cands[i]; i++) {
        char cmd[512]; snprintf(cmd, sizeof cmd, "command -v %s >/dev/null 2>&1", cands[i]);
        if (cands[i][0] == '/') { if (access(cands[i], X_OK) == 0) return cands[i]; }
        else if (system(cmd) == 0) return cands[i];
    }
    return NULL;
}

/* launch chromium and connect CDP. Returns session handle (>=0) or -1. */
long long wd_chrome(long long headless, long long width, long long height,
                    const char *user_agent, const char *profile) {
    seed_once();
    int h = -1;
    for (int i = 0; i < WD_MAX; i++) if (!g_sess[i].used) { h = i; break; }
    if (h < 0) return -1;
    const char *chrome = find_chrome();
    if (!chrome) return -1;

    int port = 9222 + h;
    wd_session *s = &g_sess[h];
    memset(s, 0, sizeof *s);
    if (profile && *profile) snprintf(s->profile_dir, sizeof s->profile_dir, "%s", profile);
    else snprintf(s->profile_dir, sizeof s->profile_dir, "/tmp/ezy_wd_%d_%d", getpid(), h);
    if (width <= 0) width = 1280;
    if (height <= 0) height = 800;

    char portarg[48]; snprintf(portarg, sizeof portarg, "--remote-debugging-port=%d", port);
    char dirarg[320]; snprintf(dirarg, sizeof dirarg, "--user-data-dir=%s", s->profile_dir);
    char sizearg[48]; snprintf(sizearg, sizeof sizearg, "--window-size=%d,%d", (int)width, (int)height);
    char uaarg[1024]; uaarg[0] = 0;
    if (user_agent && *user_agent) snprintf(uaarg, sizeof uaarg, "--user-agent=%s", user_agent);

    pid_t pid = fork();
    if (pid == 0) {
        int devnull = open("/dev/null", O_WRONLY);
        if (devnull >= 0) { dup2(devnull, 1); dup2(devnull, 2); }
        char *argv[24]; int n = 0;
        argv[n++] = (char *)chrome;
        argv[n++] = portarg;
        argv[n++] = dirarg;
        argv[n++] = sizearg;
        argv[n++] = "--remote-allow-origins=*";   /* required by recent Chrome for CDP ws */
        argv[n++] = "--no-first-run";
        argv[n++] = "--no-default-browser-check";
        argv[n++] = "--disable-background-networking";
        argv[n++] = "--disable-popup-blocking";
        if (headless) { argv[n++] = "--headless=new"; argv[n++] = "--disable-gpu"; }
        if (uaarg[0]) argv[n++] = uaarg;
        argv[n++] = "about:blank";
        argv[n] = NULL;
        execvp(chrome, argv);
        _exit(127);
    }
    if (pid < 0) return -1;
    s->pid = pid;
    s->port = port;

    /* poll /json/version then a page target for up to ~10s */
    char *wsurl = NULL;
    for (int t = 0; t < 100 && !wsurl; t++) {
        msleep(100);
        char *body = http_get("127.0.0.1", port, "/json");
        if (!body) continue;
        jnode *arr = json_parse(body);
        if (arr && arr->t == JARR) {
            for (int i = 0; i < arr->nkids; i++) {
                jnode *type = j_get(arr->kids[i], "type");
                jnode *ws = j_get(arr->kids[i], "webSocketDebuggerUrl");
                if (ws && ws->t == JSTR && type && type->t == JSTR && !strcmp(type->str, "page")) {
                    wsurl = strdup(ws->str); break;
                }
            }
        }
        j_free(arr); free(body);
    }
    if (!wsurl) { kill(pid, SIGKILL); return -1; }
#ifdef WD_DEBUG
    fprintf(stderr, "[wd] got wsurl=%s\n", wsurl);
#endif

    /* parse ws://127.0.0.1:PORT/devtools/page/ID → path */
    char *path = strstr(wsurl, "://");
    path = path ? strchr(path + 3, '/') : NULL;
    if (!path) { free(wsurl); kill(pid, SIGKILL); return -1; }
    char pathbuf[512]; snprintf(pathbuf, sizeof pathbuf, "%s", path);
    free(wsurl);

    int fd = tcp_connect("127.0.0.1", port);
    if (fd < 0 || ws_handshake(fd, "127.0.0.1", port, pathbuf) < 0) {
        if (fd >= 0) close(fd);
        kill(pid, SIGKILL); return -1;
    }
    s->fd = fd; s->used = 1; s->next_id = 0;
    /* safety net: never block forever waiting on a CDP response */
    { struct timeval tv = { 30, 0 }; setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv); }
#ifdef WD_DEBUG
    fprintf(stderr, "[wd] ws handshake ok, path=%s\n", pathbuf);
#endif

    /* enable the domains we use */
    char *r;
    r = cdp_call(s, "Page.enable", "{}");     free(r);
#ifdef WD_DEBUG
    fprintf(stderr, "[wd] Page.enable done\n");
#endif
    r = cdp_call(s, "Runtime.enable", "{}");  free(r);
    r = cdp_call(s, "DOM.enable", "{}");      free(r);
    r = cdp_call(s, "Network.enable", "{}");  free(r);
    if (user_agent && *user_agent) {
        str_t p; str_init(&p); str_add(&p, "{\"userAgent\":\""); json_escape(&p, user_agent); str_add(&p, "\"}");
        r = cdp_call(s, "Network.setUserAgentOverride", p.p); free(r); free(p.p);
    }
    return h;
}

/* ───────────────────────── Firefox / WebDriver BiDi ───────────────────────── */
static const char *find_firefox(void) {
    const char *env = getenv("EZY_FIREFOX");
    if (env && *env && access(env, X_OK) == 0) return env;
    static const char *cands[] = {
        "firefox", "firefox-esr",
        "/usr/bin/firefox", "/usr/bin/firefox-esr",
        "/snap/bin/firefox", "/opt/firefox/firefox", NULL };
    for (int i = 0; cands[i]; i++) {
        if (cands[i][0] == '/') { if (access(cands[i], X_OK) == 0) return cands[i]; }
        else { char cmd[256]; snprintf(cmd, sizeof cmd, "command -v %s >/dev/null 2>&1", cands[i]); if (system(cmd) == 0) return cands[i]; }
    }
    return NULL;
}

/* establish a BiDi session and grab the first browsing context */
static int bidi_setup(wd_session *s) {
    char *r = cdp_call(s, "session.new", "{\"capabilities\":{}}");
    if (!r) return -1;
    free(r);
    char *t = cdp_call(s, "browsingContext.getTree", "{}");
    if (!t) return -1;
    jnode *root = json_parse(t); free(t);
    jnode *ctxs = j_path(root, "result.contexts");
    if (ctxs && ctxs->t == JARR && ctxs->nkids > 0) {
        jnode *c = j_get(ctxs->kids[0], "context");
        if (c && c->t == JSTR) snprintf(s->ctx, sizeof s->ctx, "%s", c->str);
    }
    j_free(root);
    return s->ctx[0] ? 0 : -1;
}

/* launch Firefox and connect over WebDriver BiDi. Returns handle or -1. */
long long wd_firefox(long long headless, long long width, long long height,
                     const char *user_agent, const char *profile) {
    seed_once();
    int h = -1;
    for (int i = 0; i < WD_MAX; i++) if (!g_sess[i].used) { h = i; break; }
    if (h < 0) return -1;
    const char *ff = find_firefox();
    if (!ff) return -1;

    int port = 9222 + h;
    wd_session *s = &g_sess[h];
    memset(s, 0, sizeof *s);
    s->proto = WD_BIDI;
    if (profile && *profile) snprintf(s->profile_dir, sizeof s->profile_dir, "%s", profile);
    else snprintf(s->profile_dir, sizeof s->profile_dir, "/tmp/ezy_ff_%d_%d", getpid(), h);
    if (width <= 0) width = 1280;
    if (height <= 0) height = 800;

    char portarg[48]; snprintf(portarg, sizeof portarg, "--remote-debugging-port=%d", port);
    char sizew[32]; snprintf(sizew, sizeof sizew, "--width=%d", (int)width);
    char sizeh[32]; snprintf(sizeh, sizeof sizeh, "--height=%d", (int)height);

    /* the profile must enable the remote agent (off by default on some builds) */
    mkdir(s->profile_dir, 0700);
    { char ujs[400]; snprintf(ujs, sizeof ujs, "%s/user.js", s->profile_dir);
      FILE *uf = fopen(ujs, "w");
      if (uf) {
          fputs("user_pref(\"remote.enabled\", true);\n", uf);
          fputs("user_pref(\"remote.force-local\", true);\n", uf);
          fputs("user_pref(\"browser.shell.checkDefaultBrowser\", false);\n", uf);
          fputs("user_pref(\"toolkit.telemetry.reportingpolicy.firstRun\", false);\n", uf);
          fputs("user_pref(\"datareporting.policy.firstRunURL\", \"\");\n", uf);
          fclose(uf);
      }
    }

    pid_t pid = fork();
    if (pid == 0) {
        int devnull = open("/dev/null", O_WRONLY);
        if (devnull >= 0) { dup2(devnull, 1); dup2(devnull, 2); }
        char *argv[20]; int n = 0;
        argv[n++] = (char *)ff;
        argv[n++] = portarg;
        argv[n++] = "--remote-allow-hosts=127.0.0.1";
        argv[n++] = "--remote-allow-origins=*";
        argv[n++] = "--new-instance";
        argv[n++] = "--no-remote";
        argv[n++] = "-profile"; argv[n++] = s->profile_dir;
        if (headless) argv[n++] = "--headless";
        argv[n++] = sizew; argv[n++] = sizeh;
        argv[n++] = "about:blank";
        argv[n] = NULL;
        execvp(ff, argv);
        _exit(127);
    }
    if (pid < 0) return -1;
    s->pid = pid; s->port = port;

    /* Firefox doesn't serve /json; wait until the BiDi port accepts a
       connection, then use the fixed /session endpoint. */
    const char *pathbuf = "/session";
    int fd = -1;
    for (int t = 0; t < 200; t++) {
        fd = tcp_connect("127.0.0.1", port);
        if (fd >= 0) break;
        msleep(100);
    }
#ifdef WD_DEBUG
    fprintf(stderr, "[wd] firefox port up, fd=%d, path=%s\n", fd, pathbuf);
#endif
    if (fd < 0 || ws_handshake(fd, "127.0.0.1", port, pathbuf) < 0) {
        if (fd >= 0) close(fd);
        kill(pid, SIGKILL); return -1;
    }
    s->fd = fd; s->used = 1; s->next_id = 0;
    { struct timeval tv = { 30, 0 }; setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv); }

    if (bidi_setup(s) < 0) { close(fd); kill(pid, SIGKILL); s->used = 0; return -1; }
#ifdef WD_DEBUG
    fprintf(stderr, "[wd] bidi ctx=%s\n", s->ctx);
#endif
    if (user_agent && *user_agent) wd_set_user_agent(h, user_agent);
    return h;
}

static wd_session *S(long long h) {
    if (h < 0 || h >= WD_MAX || !g_sess[h].used) return NULL;
    return &g_sess[h];
}

long long wd_close(long long h) {
    wd_session *s = S(h);
    if (!s) return -1;
    char *r = cdp_call(s, s->proto == WD_BIDI ? "browser.close" : "Browser.close", "{}"); free(r);
    if (s->fd >= 0) close(s->fd);
    if (s->pid > 0) { kill(s->pid, SIGTERM); msleep(150); kill(s->pid, SIGKILL); waitpid(s->pid, NULL, WNOHANG); }
    char cmd[400]; snprintf(cmd, sizeof cmd, "rm -rf '%s' 2>/dev/null", s->profile_dir); if (system(cmd)){}
    s->used = 0;
    return 0;
}

/* ───────────────────────── navigation / eval ───────────────────────── */
char *wd_eval(long long h, const char *expr) {
    wd_session *s = S(h); if (!s) return strdup("");
    return cdp_eval(s, expr);
}
long long wd_go(long long h, const char *url) {
    wd_session *s = S(h); if (!s) return -1;
    str_t p; str_init(&p);
    if (s->proto == WD_BIDI) {
        str_add(&p, "{\"url\":\""); json_escape(&p, url);
        str_add(&p, "\",\"wait\":\"complete\",\"context\":\""); str_add(&p, s->ctx); str_add(&p, "\"}");
        char *r = cdp_call(s, "browsingContext.navigate", p.p); free(p.p);
        if (!r) return -1;
        free(r); return 0;            /* wait:complete already blocked */
    }
    str_add(&p, "{\"url\":\""); json_escape(&p, url); str_add(&p, "\"}");
    char *r = cdp_call(s, "Page.navigate", p.p); free(p.p);
    if (!r) return -1;
    free(r);
    /* wait for load (readyState complete), up to 30s */
    for (int t = 0; t < 300; t++) {
        char *rs = cdp_eval(s, "document.readyState");
        int done = !strcmp(rs, "complete"); free(rs);
        if (done) return 0;
        msleep(100);
    }
    return 0;
}
char *wd_current_url(long long h) { return wd_eval(h, "location.href"); }
char *wd_title(long long h)       { return wd_eval(h, "document.title"); }
char *wd_html(long long h)        { return wd_eval(h, "document.documentElement.outerHTML"); }
static long long bidi_traverse(wd_session *s, int delta) {
    char p[160];
    snprintf(p, sizeof p, "{\"context\":\"%s\",\"delta\":%d}", s->ctx, delta);
    char *r = cdp_call(s, "browsingContext.traverseHistory", p); free(r); return 0;
}
long long wd_back(long long h) {
    wd_session *s = S(h); if (!s) return -1;
    if (s->proto == WD_BIDI) return bidi_traverse(s, -1);
    char *r = wd_eval(h, "history.back()"); free(r); return 0;
}
long long wd_forward(long long h) {
    wd_session *s = S(h); if (!s) return -1;
    if (s->proto == WD_BIDI) return bidi_traverse(s, 1);
    char *r = wd_eval(h, "history.forward()"); free(r); return 0;
}
long long wd_refresh(long long h) {
    wd_session *s = S(h); if (!s) return -1;
    if (s->proto == WD_BIDI) {
        str_t p; str_init(&p); str_add(&p, "{\"context\":\""); str_add(&p, s->ctx); str_add(&p, "\",\"wait\":\"complete\"}");
        char *r = cdp_call(s, "browsingContext.reload", p.p); free(p.p); free(r); return 0;
    }
    char *r = cdp_call(s, "Page.reload", "{}"); free(r);
    return wd_wait_ready(h, 10000);
}

long long wd_wait_ready(long long h, long long timeout_ms) {
    wd_session *s = S(h); if (!s) return -1;
    long waited = 0;
    while (waited <= timeout_ms) {
        char *rs = cdp_eval(s, "document.readyState");
        int done = !strcmp(rs, "complete"); free(rs);
        if (done) return 0;
        msleep(100); waited += 100;
    }
    return -1;
}

long long wd_screenshot(long long h, const char *path) {
    wd_session *s = S(h); if (!s) return -1;
    char *resp;
    if (s->proto == WD_BIDI) {
        str_t p; str_init(&p); str_add(&p, "{\"context\":\""); str_add(&p, s->ctx); str_add(&p, "\"}");
        resp = cdp_call(s, "browsingContext.captureScreenshot", p.p); free(p.p);
    } else {
        resp = cdp_call(s, "Page.captureScreenshot", "{\"format\":\"png\"}");
    }
    if (!resp) return -1;
    jnode *root = json_parse(resp); free(resp);
    jnode *data = j_path(root, "result.data");
    long long rc = -1;
    if (data && data->t == JSTR) {
        size_t n; unsigned char *bytes = b64_decode(data->str, &n);
        FILE *f = fopen(path, "wb");
        if (f) { fwrite(bytes, 1, n, f); fclose(f); rc = 0; }
        free(bytes);
    }
    j_free(root);
    return rc;
}

/* ───────────────────────── element ops (selector-based, via JS) ───────────────────────── */
/* Build JS that resolves `sel` (CSS) at index `idx` into `el`, runs `body`. */
static char *el_eval(long long h, const char *sel, int idx, const char *expr_on_el) {
    str_t js; str_init(&js);
    str_add(&js, "(function(){var el=document.querySelectorAll(");
    /* embed selector as a JS string literal */
    str_t q; str_init(&q); str_add(&q, "\""); json_escape(&q, sel); str_add(&q, "\"");
    /* selector text must be escaped again because el_eval result goes through cdp_eval's escaper */
    str_add(&js, q.p); free(q.p);
    char ib[64]; snprintf(ib, sizeof ib, ")[%d]; if(!el) return null; return ", idx);
    str_add(&js, ib);
    str_add(&js, expr_on_el);
    str_add(&js, ";})()");
    char *out = wd_eval(h, js.p);
    free(js.p);
    return out;
}
long long wd_exists(long long h, const char *sel, long long idx) {
    char *r = el_eval(h, sel, (int)idx, "true"); int ok = !strcmp(r, "true"); free(r); return ok ? 1 : 0;
}
long long wd_count(long long h, const char *sel) {
    str_t js; str_init(&js); str_add(&js, "document.querySelectorAll(\""); json_escape(&js, sel); str_add(&js, "\").length");
    char *r = wd_eval(h, js.p); free(js.p); long long n = atoll(r); free(r); return n;
}
char *wd_text(long long h, const char *sel, long long idx) { return el_eval(h, sel, (int)idx, "el.innerText"); }
char *wd_inner_html(long long h, const char *sel, long long idx) { return el_eval(h, sel, (int)idx, "el.innerHTML"); }
char *wd_attr(long long h, const char *sel, long long idx, const char *name) {
    str_t e; str_init(&e);
    /* `value`/`checked` live on the property, not the HTML attribute */
    if (!strcmp(name, "value") || !strcmp(name, "checked")) {
        str_add(&e, "String(el."); str_add(&e, name); str_add(&e, ")");
    } else {
        str_add(&e, "el.getAttribute(\""); json_escape(&e, name); str_add(&e, "\")");
    }
    char *r = el_eval(h, sel, (int)idx, e.p); free(e.p); return r;
}
long long wd_is_visible(long long h, const char *sel, long long idx) {
    char *r = el_eval(h, sel, (int)idx,
        "(function(){var b=el.getBoundingClientRect();var st=getComputedStyle(el);"
        "return b.width>0&&b.height>0&&st.visibility!=='hidden'&&st.display!=='none';})()");
    int v = !strcmp(r, "true"); free(r); return v ? 1 : 0;
}
long long wd_is_enabled(long long h, const char *sel, long long idx) {
    char *r = el_eval(h, sel, (int)idx, "!el.disabled"); int v = !strcmp(r, "true"); free(r); return v ? 1 : 0;
}
long long wd_clear(long long h, const char *sel, long long idx) {
    char *r = el_eval(h, sel, (int)idx, "(el.value='',true)"); free(r); return 0;
}
/* plain click via DOM */
long long wd_click(long long h, const char *sel, long long idx) {
    char *r = el_eval(h, sel, (int)idx, "(el.scrollIntoView({block:'center'}),el.click(),true)"); free(r); return 0;
}
/* plain type: focus + set value + fire input/change */
long long wd_type(long long h, const char *sel, long long idx, const char *text) {
    str_t e; str_init(&e);
    str_add(&e, "(function(){el.focus();el.value=(el.value||'')+\"");
    json_escape(&e, text);
    str_add(&e, "\";el.dispatchEvent(new Event('input',{bubbles:true}));"
                "el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
    char *r = el_eval(h, sel, (int)idx, e.p); free(e.p); free(r); return 0;
}

/* wait for selector to appear / disappear */
long long wd_wait_for(long long h, const char *sel, long long timeout_ms) {
    long waited = 0;
    while (waited <= timeout_ms) { if (wd_exists(h, sel, 0)) return 0; msleep(100); waited += 100; }
    return -1;
}
long long wd_wait_for_not(long long h, const char *sel, long long timeout_ms) {
    long waited = 0;
    while (waited <= timeout_ms) { if (!wd_exists(h, sel, 0)) return 0; msleep(100); waited += 100; }
    return -1;
}
long long wd_wait_for_text(long long h, const char *sel, const char *text, long long timeout_ms) {
    long waited = 0;
    while (waited <= timeout_ms) {
        char *t = wd_text(h, sel, 0);
        int hit = strstr(t, text) != NULL; free(t);
        if (hit) return 0;
        msleep(100); waited += 100;
    }
    return -1;
}
/* find by visible text (returns a CSS-ish marker via data attribute set on match);
   simpler: returns 1 if an element containing the text exists */
long long wd_find_text(long long h, const char *text) {
    str_t js; str_init(&js);
    str_add(&js, "(function(){var x=document.evaluate(\"//*[contains(text(),'");
    json_escape(&js, text);
    str_add(&js, "')]\",document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return !!x;})()");
    char *r = wd_eval(h, js.p); free(js.p); int ok = !strcmp(r, "true"); free(r); return ok ? 1 : 0;
}

/* ───────────────────────── human input (curved mouse via CDP Input) ───────────────────────── */
static int el_center(wd_session *s, const char *sel, int idx, double *cx, double *cy) {
    str_t js; str_init(&js);
    str_add(&js, "(function(){var el=document.querySelectorAll(\""); json_escape(&js, sel);
    char ib[64]; snprintf(ib, sizeof ib, "\")[%d];if(!el)return '';el.scrollIntoView({block:'center'});", idx);
    str_add(&js, ib);
    str_add(&js, "var b=el.getBoundingClientRect();return (b.left+b.width/2)+','+(b.top+b.height/2);})()");
    char *r = cdp_eval(s, js.p); free(js.p);
    if (!*r) { free(r); return -1; }
    char *comma = strchr(r, ','); if (!comma) { free(r); return -1; }
    *comma = 0; *cx = atof(r); *cy = atof(comma + 1); free(r);
    return 0;
}
static void dispatch_mouse(wd_session *s, const char *type, double x, double y, const char *button, int clicks) {
    char p[256];
    snprintf(p, sizeof p, "{\"type\":\"%s\",\"x\":%.1f,\"y\":%.1f,\"button\":\"%s\",\"clickCount\":%d}",
             type, x, y, button, clicks);
    char *r = cdp_call(s, "Input.dispatchMouseEvent", p); free(r);
}
/* move the virtual cursor along a curved (Bézier) path to (ex,ey) */
static void human_path(wd_session *s, double sx, double sy, double ex, double ey) {
    double dx = ex - sx, dy = ey - sy, dist = sqrt(dx*dx + dy*dy);
    if (dist < 1) { dispatch_mouse(s, "mouseMoved", ex, ey, "none", 0); return; }
    double nx = -dy/dist, ny = dx/dist;
    double off = 0.22 * dist * frange(0.4, 1.0) * (frand() < 0.5 ? -1 : 1);
    double cx = (sx+ex)/2 + nx*off, cy = (sy+ey)/2 + ny*off;
    int steps = (int)(dist/8) + 12; if (steps > 60) steps = 60;
    for (int i = 1; i <= steps; i++) {
        double t = (double)i/steps; t = t*t*(3-2*t);   /* ease */
        double u = 1-t;
        double bx = u*u*sx + 2*u*t*cx + t*t*ex + frange(-1.2,1.2);
        double by = u*u*sy + 2*u*t*cy + t*t*ey + frange(-1.2,1.2);
        dispatch_mouse(s, "mouseMoved", bx, by, "none", 0);
        msleep((long)frange(6, 18));
    }
}
static double g_cur_x = 0, g_cur_y = 0;

/* BiDi: send the whole curved path + press/release as one input.performActions */
static void bidi_human_click(wd_session *s, double ex, double ey) {
    double sx = g_cur_x, sy = g_cur_y;
    double dx = ex - sx, dy = ey - sy, dist = sqrt(dx*dx + dy*dy);
    int steps = (int)(dist/8) + 12; if (steps > 40) steps = 40; if (steps < 2) steps = 2;
    double nx = dist > 1 ? -dy/dist : 0, ny = dist > 1 ? dx/dist : 0;
    double off = 0.22 * dist * frange(0.4, 1.0) * (frand() < 0.5 ? -1 : 1);
    double cxp = (sx+ex)/2 + nx*off, cyp = (sy+ey)/2 + ny*off;
    str_t a; str_init(&a);
    str_add(&a, "{\"context\":\""); str_add(&a, s->ctx);
    str_add(&a, "\",\"actions\":[{\"type\":\"pointer\",\"id\":\"mouse\",\"parameters\":{\"pointerType\":\"mouse\"},\"actions\":[");
    char seg[200];
    for (int i = 1; i <= steps; i++) {
        double t = (double)i/steps; t = t*t*(3-2*t); double u = 1-t;
        double bx = u*u*sx + 2*u*t*cxp + t*t*ex + frange(-1,1);
        double by = u*u*sy + 2*u*t*cyp + t*t*ey + frange(-1,1);
        snprintf(seg, sizeof seg, "%s{\"type\":\"pointerMove\",\"x\":%.0f,\"y\":%.0f,\"duration\":%d}",
                 i > 1 ? "," : "", bx, by, (int)frange(6, 18));
        str_add(&a, seg);
    }
    snprintf(seg, sizeof seg, ",{\"type\":\"pointerDown\",\"button\":0},{\"type\":\"pause\",\"duration\":%d},{\"type\":\"pointerUp\",\"button\":0}",
             (int)frange(50, 110));
    str_add(&a, seg);
    str_add(&a, "]}]}");
    char *r = cdp_call(s, "input.performActions", a.p); free(r); free(a.p);
    g_cur_x = ex; g_cur_y = ey;
}
long long wd_human_click(long long h, const char *sel, long long idx) {
    wd_session *s = S(h); if (!s) return -1;
    double cx, cy;
    if (el_center(s, sel, (int)idx, &cx, &cy) < 0) return -1;
    if (s->proto == WD_BIDI) { bidi_human_click(s, cx, cy); return 0; }
    human_path(s, g_cur_x, g_cur_y, cx, cy);
    g_cur_x = cx; g_cur_y = cy;
    msleep((long)frange(40, 120));
    dispatch_mouse(s, "mousePressed", cx, cy, "left", 1);
    msleep((long)frange(50, 110));
    dispatch_mouse(s, "mouseReleased", cx, cy, "left", 1);
    return 0;
}
static void dispatch_key_char(wd_session *s, char c) {
    str_t p; str_init(&p);
    str_add(&p, "{\"type\":\"keyDown\",\"text\":\"");
    char tmp[2] = { c, 0 }; json_escape(&p, tmp);
    str_add(&p, "\"}");
    char *r = cdp_call(s, "Input.dispatchKeyEvent", p.p); free(r);
    /* keyUp */
    p.len = 0; p.p[0] = 0;
    str_add(&p, "{\"type\":\"keyUp\",\"text\":\"");
    json_escape(&p, tmp); str_add(&p, "\"}");
    r = cdp_call(s, "Input.dispatchKeyEvent", p.p); free(r);
    free(p.p);
}
/* BiDi: type one char with a key source, with a trailing pause */
static void bidi_key_char(wd_session *s, char c, int pause_ms) {
    str_t a; str_init(&a);
    str_add(&a, "{\"context\":\""); str_add(&a, s->ctx);
    str_add(&a, "\",\"actions\":[{\"type\":\"key\",\"id\":\"kb\",\"actions\":[");
    char tmp[2] = { c, 0 };
    str_add(&a, "{\"type\":\"keyDown\",\"value\":\""); json_escape(&a, tmp); str_add(&a, "\"},");
    str_add(&a, "{\"type\":\"keyUp\",\"value\":\""); json_escape(&a, tmp); str_add(&a, "\"},");
    char seg[64]; snprintf(seg, sizeof seg, "{\"type\":\"pause\",\"duration\":%d}", pause_ms);
    str_add(&a, seg);
    str_add(&a, "]}]}");
    char *r = cdp_call(s, "input.performActions", a.p); free(r); free(a.p);
}
long long wd_human_type(long long h, const char *sel, long long idx, const char *text) {
    wd_session *s = S(h); if (!s) return -1;
    char *r = el_eval(h, sel, (int)idx, "(el.focus(),true)"); free(r);
    for (const char *c = text; *c; c++) {
        long d = (long)frange(45, 140);
        if (*c == ' ') d += (long)frange(20, 90);
        else if (strchr(".,!?;:", *c)) d += (long)frange(80, 220);
        if (frand() < 0.04) d += (long)frange(150, 450);
        if (s->proto == WD_BIDI) { bidi_key_char(s, *c, (int)d); }
        else { dispatch_key_char(s, *c); msleep(d); }
    }
    return 0;
}
long long wd_random_scroll(long long h) {
    wd_session *s = S(h); if (!s) return -1;
    int n = (int)frange(2, 6);
    for (int i = 0; i < n; i++) {
        if (s->proto == WD_BIDI) {
            char p[256];
            snprintf(p, sizeof p,
                "{\"context\":\"%s\",\"actions\":[{\"type\":\"wheel\",\"id\":\"w\",\"actions\":["
                "{\"type\":\"scroll\",\"x\":10,\"y\":10,\"deltaX\":0,\"deltaY\":%.0f,\"duration\":%d}]}]}",
                s->ctx, frange(80, 260), (int)frange(80, 200));
            char *r = cdp_call(s, "input.performActions", p); free(r);
        } else {
            char p[160];
            snprintf(p, sizeof p, "{\"type\":\"mouseWheel\",\"x\":%.0f,\"y\":%.0f,\"deltaX\":0,\"deltaY\":%.0f}",
                     frange(100, 400), frange(100, 400), frange(80, 260));
            char *r = cdp_call(s, "Input.dispatchMouseEvent", p); free(r);
        }
        msleep((long)frange(120, 400));
    }
    return 0;
}
long long wd_random_delay(long long min_ms, long long max_ms) {
    seed_once(); long d = (long)frange((double)min_ms, (double)max_ms); msleep(d); return d;
}

/* ───────────────────────── anti-detection ───────────────────────── */
static long long add_init_script(wd_session *s, const char *js) {
    str_t p; str_init(&p);
    if (s->proto == WD_BIDI) {
        str_add(&p, "{\"functionDeclaration\":\"() => { ");
        json_escape(&p, js);
        str_add(&p, " }\"}");
        char *r = cdp_call(s, "script.addPreloadScript", p.p); free(p.p);
        if (!r) return -1;
        free(r); return 0;
    }
    str_add(&p, "{\"source\":\""); json_escape(&p, js); str_add(&p, "\"}");
    char *r = cdp_call(s, "Page.addScriptToEvaluateOnNewDocument", p.p); free(p.p);
    if (!r) return -1;
    free(r); return 0;
}
long long wd_hide_automation(long long h) {
    wd_session *s = S(h); if (!s) return -1;
    return add_init_script(s,
        "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
        "window.chrome={runtime:{}};"
        "Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});"
        "Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});");
}
long long wd_spoof_webgl(long long h) {
    wd_session *s = S(h); if (!s) return -1;
    return add_init_script(s,
        "const gp=WebGLRenderingContext.prototype.getParameter;"
        "WebGLRenderingContext.prototype.getParameter=function(p){"
        "if(p===37445)return 'Intel Inc.';if(p===37446)return 'Intel Iris OpenGL Engine';"
        "return gp.call(this,p);};");
}
long long wd_spoof_canvas(long long h) {
    wd_session *s = S(h); if (!s) return -1;
    return add_init_script(s,
        "const td=HTMLCanvasElement.prototype.toDataURL;"
        "HTMLCanvasElement.prototype.toDataURL=function(){"
        "const ctx=this.getContext('2d');if(ctx){const d=ctx.getImageData(0,0,this.width,this.height);"
        "for(let i=0;i<d.data.length;i+=997){d.data[i]=d.data[i]^1;}ctx.putImageData(d,0,0);}"
        "return td.apply(this,arguments);};");
}
long long wd_spoof_audio(long long h) {
    wd_session *s = S(h); if (!s) return -1;
    return add_init_script(s,
        "const ga=AnalyserNode.prototype.getFloatFrequencyData;"
        "AnalyserNode.prototype.getFloatFrequencyData=function(a){ga.call(this,a);"
        "for(let i=0;i<a.length;i+=100){a[i]=a[i]+Math.random()*0.0001;}};");
}
long long wd_set_viewport(long long h, long long w, long long ht) {
    wd_session *s = S(h); if (!s) return -1;
    char p[200];
    if (s->proto == WD_BIDI) {
        snprintf(p, sizeof p, "{\"context\":\"%s\",\"viewport\":{\"width\":%d,\"height\":%d}}", s->ctx, (int)w, (int)ht);
        char *r = cdp_call(s, "browsingContext.setViewport", p); if (!r) return -1;
        free(r); return 0;
    }
    snprintf(p, sizeof p, "{\"width\":%d,\"height\":%d,\"deviceScaleFactor\":1,\"mobile\":false}", (int)w, (int)ht);
    char *r = cdp_call(s, "Emulation.setDeviceMetricsOverride", p); if (!r) return -1;
    free(r); return 0;
}
long long wd_set_user_agent(long long h, const char *ua) {
    wd_session *s = S(h); if (!s) return -1;
    if (s->proto == WD_BIDI) {
        /* BiDi has no UA-override command; spoof navigator.userAgent on new docs */
        str_t js; str_init(&js);
        str_add(&js, "Object.defineProperty(navigator,'userAgent',{get:()=>\"");
        json_escape(&js, ua); str_add(&js, "\"});");
        long long rc = add_init_script(s, js.p); free(js.p); return rc;
    }
    str_t p; str_init(&p); str_add(&p, "{\"userAgent\":\""); json_escape(&p, ua); str_add(&p, "\"}");
    char *r = cdp_call(s, "Network.setUserAgentOverride", p.p); free(p.p);
    if (!r) return -1;
    free(r); return 0;
}
long long wd_set_timezone(long long h, const char *tz) {
    wd_session *s = S(h); if (!s) return -1;
    if (s->proto == WD_BIDI) return 0;   /* not exposed over BiDi yet */
    str_t p; str_init(&p); str_add(&p, "{\"timezoneId\":\""); json_escape(&p, tz); str_add(&p, "\"}");
    char *r = cdp_call(s, "Emulation.setTimezoneOverride", p.p); free(p.p);
    if (!r) return -1;
    free(r); return 0;
}
/* one-shot: apply the common anti-detection stack */
long long wd_anti_detection(long long h) {
    if (wd_hide_automation(h) < 0) return -1;
    wd_spoof_webgl(h); wd_spoof_canvas(h); wd_spoof_audio(h);
    return 0;
}

/* ───────────────────────── cookies ───────────────────────── */
char *wd_cookies(long long h) {
    wd_session *s = S(h); if (!s) return strdup("");
    char *resp;
    if (s->proto == WD_BIDI) {
        str_t p; str_init(&p); str_add(&p, "{\"partition\":{\"type\":\"context\",\"context\":\""); str_add(&p, s->ctx); str_add(&p, "\"}}");
        resp = cdp_call(s, "storage.getCookies", p.p); free(p.p);
    } else {
        resp = cdp_call(s, "Network.getAllCookies", "{}");
    }
    if (!resp) return strdup("");
    return resp;   /* raw JSON; the .ez layer can parse or the user can */
}
long long wd_set_cookie(long long h, const char *name, const char *value) {
    wd_session *s = S(h); if (!s) return -1;
    if (s->proto == WD_BIDI) {
        char *host = js_eval(s, "location.hostname");
        str_t p; str_init(&p);
        str_add(&p, "{\"cookie\":{\"name\":\""); json_escape(&p, name);
        str_add(&p, "\",\"value\":{\"type\":\"string\",\"value\":\""); json_escape(&p, value);
        str_add(&p, "\"},\"domain\":\""); json_escape(&p, host); str_add(&p, "\"},");
        str_add(&p, "\"partition\":{\"type\":\"context\",\"context\":\""); str_add(&p, s->ctx); str_add(&p, "\"}}");
        free(host);
        char *r = cdp_call(s, "storage.setCookie", p.p); free(p.p);
        if (!r) return -1;
        free(r); return 0;
    }
    char *url = wd_current_url(h);
    str_t p; str_init(&p);
    str_add(&p, "{\"name\":\""); json_escape(&p, name);
    str_add(&p, "\",\"value\":\""); json_escape(&p, value);
    str_add(&p, "\",\"url\":\""); json_escape(&p, url); str_add(&p, "\"}");
    free(url);
    char *r = cdp_call(s, "Network.setCookie", p.p); free(p.p);
    if (!r) return -1;
    free(r); return 0;
}
long long wd_delete_cookie(long long h, const char *name) {
    wd_session *s = S(h); if (!s) return -1;
    if (s->proto == WD_BIDI) {
        str_t p; str_init(&p);
        str_add(&p, "{\"filter\":{\"name\":\""); json_escape(&p, name); str_add(&p, "\"},");
        str_add(&p, "\"partition\":{\"type\":\"context\",\"context\":\""); str_add(&p, s->ctx); str_add(&p, "\"}}");
        char *r = cdp_call(s, "storage.deleteCookies", p.p); free(p.p);
        if (!r) return -1;
        free(r); return 0;
    }
    char *url = wd_current_url(h);
    str_t p; str_init(&p);
    str_add(&p, "{\"name\":\""); json_escape(&p, name);
    str_add(&p, "\",\"url\":\""); json_escape(&p, url); str_add(&p, "\"}");
    free(url);
    char *r = cdp_call(s, "Network.deleteCookies", p.p); free(p.p);
    if (!r) return -1;
    free(r); return 0;
}
long long wd_clear_cookies(long long h) {
    wd_session *s = S(h); if (!s) return -1;
    if (s->proto == WD_BIDI) {
        str_t p; str_init(&p); str_add(&p, "{\"partition\":{\"type\":\"context\",\"context\":\""); str_add(&p, s->ctx); str_add(&p, "\"}}");
        char *r = cdp_call(s, "storage.deleteCookies", p.p); free(p.p);
        if (!r) return -1;
        free(r); return 0;
    }
    char *r = cdp_call(s, "Network.clearBrowserCookies", "{}"); if (!r) return -1;
    free(r); return 0;
}

long long wd_maximize(long long h) { return wd_set_viewport(h, 1920, 1080); }

char *wd_version(void) { return (char *)"webdriver 1.1.0 (Chromium/CDP + Firefox/BiDi)"; }
