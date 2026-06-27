/* ═══════════════════════════════════════════════════════════════
   websocket — a RFC 6455 WebSocket *client* for Ezy.

   Standalone: speaks the protocol directly over a TCP socket. Plain
   `ws://` uses a raw socket; secure `wss://` is tunnelled through
   OpenSSL. The handshake (key + Sec-WebSocket-Accept verification)
   and frame masking use OpenSSL for SHA-1, so the only dependency is
   libssl / libcrypto.

   Connections are referred to by a small integer handle (>= 0). All
   strings returned to Ezy are heap-allocated; the Ezy arena owns them.

   Build: gcc -shared -fPIC websocket.c -o libwebsocket.so \
              -l:libssl.so.3 -l:libcrypto.so.3
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <ctype.h>
#include <time.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/time.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/sha.h>

#define WS_GUID   "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
#define WS_MAXCONN 256

/* ───────────────────────── dynamic byte buffer ───────────────────────── */
typedef struct { char *p; size_t len, cap; } buf_t;
static void buf_init(buf_t *b) { b->cap = 256; b->len = 0; b->p = malloc(b->cap); b->p[0] = 0; }
static void buf_ensure(buf_t *b, size_t extra) {
    if (b->len + extra + 1 > b->cap) {
        while (b->len + extra + 1 > b->cap) b->cap *= 2;
        b->p = realloc(b->p, b->cap);
    }
}
static void buf_addn(buf_t *b, const void *src, size_t n) { buf_ensure(b, n); memcpy(b->p + b->len, src, n); b->len += n; b->p[b->len] = 0; }
static void buf_add(buf_t *b, const char *s) { buf_addn(b, s, strlen(s)); }
static void buf_addc(buf_t *b, unsigned char c) { buf_ensure(b, 1); b->p[b->len++] = (char)c; b->p[b->len] = 0; }

/* ───────────────────────── base64 (encode only) ───────────────────────── */
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

/* ───────────────────────── connection table ───────────────────────── */
typedef struct {
    int      in_use;
    int      fd;
    SSL     *ssl;        /* non-NULL for wss:// */
    SSL_CTX *ctx;
    int      open;       /* 1 until a close frame / error */
    char     err[160];
} ws_conn;

static ws_conn g_conns[WS_MAXCONN];
static int     g_seeded = 0;

static void ws_seed(void) {
    if (g_seeded) return;
    srand((unsigned)(time(NULL) ^ (getpid() << 16) ^ (uintptr_t)&g_conns));
    g_seeded = 1;
}
static int ws_alloc(void) {
    for (int i = 0; i < WS_MAXCONN; i++)
        if (!g_conns[i].in_use) { memset(&g_conns[i], 0, sizeof(ws_conn)); g_conns[i].in_use = 1; return i; }
    return -1;
}
static ws_conn *ws_at(long long h) {
    if (h < 0 || h >= WS_MAXCONN || !g_conns[h].in_use) return NULL;
    return &g_conns[h];
}
static void ws_set_err(ws_conn *c, const char *m) {
    if (!c) return;
    strncpy(c->err, m, sizeof c->err - 1); c->err[sizeof c->err - 1] = 0;
}

/* ───────────────────────── raw / TLS I/O ───────────────────────── */
static int io_read(ws_conn *c, void *buf, size_t n) {       /* read exactly n bytes */
    size_t got = 0; char *p = buf;
    while (got < n) {
        int r = c->ssl ? SSL_read(c->ssl, p + got, (int)(n - got))
                       : (int)recv(c->fd, p + got, n - got, 0);
        if (r <= 0) return -1;
        got += r;
    }
    return 0;
}
static int io_write(ws_conn *c, const void *buf, size_t n) { /* write all n bytes */
    size_t sent = 0; const char *p = buf;
    while (sent < n) {
        int w = c->ssl ? SSL_write(c->ssl, p + sent, (int)(n - sent))
                       : (int)send(c->fd, p + sent, n - sent, MSG_NOSIGNAL);
        if (w <= 0) return -1;
        sent += w;
    }
    return 0;
}
static int io_getc(ws_conn *c, char *out) {                 /* one byte; 1 ok, 0 closed */
    int r = c->ssl ? SSL_read(c->ssl, out, 1) : (int)recv(c->fd, out, 1, 0);
    return r == 1 ? 1 : 0;
}

static int tcp_connect(const char *host, int port) {
    char ports[16]; snprintf(ports, sizeof ports, "%d", port);
    struct addrinfo hints, *res, *rp;
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(host, ports, &hints, &res) != 0) return -1;
    int fd = -1;
    for (rp = res; rp; rp = rp->ai_next) {
        fd = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
        if (fd < 0) continue;
        if (connect(fd, rp->ai_addr, rp->ai_addrlen) == 0) break;
        close(fd); fd = -1;
    }
    freeaddrinfo(res);
    if (fd >= 0) { int one = 1; setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one); }
    return fd;
}

/* ───────────────────────── URL parsing ─────────────────────────
   ws://host[:port]/path   or   wss://host[:port]/path */
static int ws_parse_url(const char *url, int *secure, char *host, size_t hostsz, int *port, char *path, size_t pathsz) {
    if (!strncmp(url, "wss://", 6)) { *secure = 1; url += 6; *port = 443; }
    else if (!strncmp(url, "ws://", 5)) { *secure = 0; url += 5; *port = 80; }
    else return -1;

    const char *slash = strchr(url, '/');
    const char *hostend = slash ? slash : url + strlen(url);
    const char *colon = memchr(url, ':', hostend - url);
    size_t hlen = (colon ? colon : hostend) - url;
    if (hlen == 0 || hlen >= hostsz) return -1;
    memcpy(host, url, hlen); host[hlen] = 0;
    if (colon) { *port = atoi(colon + 1); if (*port <= 0) return -1; }

    if (slash) { strncpy(path, slash, pathsz - 1); path[pathsz - 1] = 0; }
    else { path[0] = '/'; path[1] = 0; }
    return 0;
}

/* ───────────────────────── handshake ───────────────────────── */
static int ws_handshake(ws_conn *c, const char *host, int port, const char *path) {
    unsigned char rawkey[16];
    for (int i = 0; i < 16; i++) rawkey[i] = rand() & 0xff;
    char *key = b64_encode(rawkey, 16);

    buf_t req; buf_init(&req);
    buf_add(&req, "GET "); buf_add(&req, path); buf_add(&req, " HTTP/1.1\r\n");
    buf_add(&req, "Host: "); buf_add(&req, host);
    { char b[16]; snprintf(b, sizeof b, ":%d", port); buf_add(&req, b); }
    buf_add(&req, "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n");
    buf_add(&req, "Sec-WebSocket-Key: "); buf_add(&req, key); buf_add(&req, "\r\n");
    buf_add(&req, "Sec-WebSocket-Version: 13\r\n\r\n");
    int wr = io_write(c, req.p, req.len);
    free(req.p);
    if (wr < 0) { free(key); ws_set_err(c, "handshake write failed"); return -1; }

    /* expected accept = base64( SHA1(key + GUID) ) */
    char concat[64]; snprintf(concat, sizeof concat, "%s%s", key, WS_GUID);
    free(key);
    unsigned char digest[SHA_DIGEST_LENGTH];
    SHA1((const unsigned char *)concat, strlen(concat), digest);
    char *expect = b64_encode(digest, SHA_DIGEST_LENGTH);

    /* read response headers up to CRLFCRLF */
    buf_t resp; buf_init(&resp); char ch;
    while (io_getc(c, &ch)) {
        buf_addc(&resp, (unsigned char)ch);
        if (resp.len >= 4 && !memcmp(resp.p + resp.len - 4, "\r\n\r\n", 4)) break;
        if (resp.len > 16384) break;
    }
    int ok = strstr(resp.p, " 101") != NULL;
    if (ok && !strcasestr(resp.p, expect)) ok = 0;    /* verify accept token */
    if (!ok) ws_set_err(c, "server rejected handshake (no 101 / bad accept)");
    free(expect); free(resp.p);
    return ok ? 0 : -1;
}

/* ───────────────────────── frame send ─────────────────────────
   opcode 0x1 text, 0x2 binary, 0x8 close, 0x9 ping, 0xA pong.
   Client frames MUST be masked (RFC 6455 §5.3). */
static int ws_send_frame(ws_conn *c, int opcode, const char *data, size_t n) {
    buf_t f; buf_init(&f);
    buf_addc(&f, (unsigned char)(0x80 | opcode));      /* FIN + opcode */
    unsigned char mask[4]; for (int i = 0; i < 4; i++) mask[i] = rand() & 0xff;
    if (n <= 125)        { buf_addc(&f, (unsigned char)(0x80 | n)); }
    else if (n <= 0xFFFF){ buf_addc(&f, 0x80 | 126); buf_addc(&f, (n>>8)&0xff); buf_addc(&f, n&0xff); }
    else                 { buf_addc(&f, 0x80 | 127); for (int i = 7; i >= 0; i--) buf_addc(&f, (n >> (i*8)) & 0xff); }
    buf_addn(&f, mask, 4);
    for (size_t i = 0; i < n; i++) buf_addc(&f, (unsigned char)(data[i] ^ mask[i & 3]));
    int rc = io_write(c, f.p, f.len);
    free(f.p);
    return rc;
}

/* ───────────────────────── frame recv ─────────────────────────
   Returns one full (de-fragmented) data message, malloc'd. Control
   frames are handled transparently: ping → pong, close → mark shut.
   On close/error returns NULL. */
static char *ws_recv_msg(ws_conn *c) {
    buf_t msg; buf_init(&msg);
    for (;;) {
        unsigned char h[2];
        if (io_read(c, h, 2) < 0) { c->open = 0; free(msg.p); return NULL; }
        int fin = h[0] & 0x80, op = h[0] & 0x0f;
        unsigned long long len = h[1] & 0x7f;
        if (len == 126) { unsigned char e[2]; if (io_read(c, e, 2) < 0) { c->open=0; free(msg.p); return NULL; } len = ((unsigned long long)e[0]<<8)|e[1]; }
        else if (len == 127) { unsigned char e[8]; if (io_read(c, e, 8) < 0) { c->open=0; free(msg.p); return NULL; } len = 0; for (int i=0;i<8;i++) len = (len<<8)|e[i]; }
        if (h[1] & 0x80) { unsigned char mk[4]; if (io_read(c, mk, 4) < 0) { c->open=0; free(msg.p); return NULL; } } /* servers normally don't mask */

        char *payload = malloc(len + 1);
        if (len && io_read(c, payload, len) < 0) { c->open=0; free(payload); free(msg.p); return NULL; }
        payload[len] = 0;

        if (op == 0x8) { c->open = 0; free(payload); free(msg.p); return NULL; }   /* close */
        if (op == 0x9) { ws_send_frame(c, 0xA, payload, len); free(payload); continue; } /* ping → pong */
        if (op == 0xA) { free(payload); continue; }                                /* pong */
        buf_addn(&msg, payload, len); free(payload);
        if (fin) break;
    }
    return msg.p;
}

/* ═══════════════════════ public API (Ezy-facing) ═══════════════════════ */

/* Connect to a ws:// or wss:// URL. Returns a handle >= 0, or -1 on error. */
long long ws_connect(const char *url) {
    ws_seed();
    int secure, port; char host[256], path[1024];
    if (!url || ws_parse_url(url, &secure, host, sizeof host, &port, path, sizeof path) < 0)
        return -1;
    int h = ws_alloc();
    if (h < 0) return -1;
    ws_conn *c = &g_conns[h];

    c->fd = tcp_connect(host, port);
    if (c->fd < 0) { ws_set_err(c, "tcp connect failed"); c->in_use = 0; return -1; }

    if (secure) {
        c->ctx = SSL_CTX_new(TLS_client_method());
        if (!c->ctx) { ws_set_err(c, "SSL_CTX_new failed"); close(c->fd); c->in_use = 0; return -1; }
        c->ssl = SSL_new(c->ctx);
        SSL_set_fd(c->ssl, c->fd);
        SSL_set_tlsext_host_name(c->ssl, host);          /* SNI */
        if (SSL_connect(c->ssl) != 1) {
            ws_set_err(c, "TLS handshake failed");
            SSL_free(c->ssl); SSL_CTX_free(c->ctx); close(c->fd); c->in_use = 0; return -1;
        }
    }

    if (ws_handshake(c, host, port, path) < 0) {
        if (c->ssl) { SSL_free(c->ssl); SSL_CTX_free(c->ctx); }
        close(c->fd); c->in_use = 0; return -1;
    }
    c->open = 1;
    return h;
}

/* Send a text message. Returns 0 on success, -1 on error. */
long long ws_send(long long h, const char *text) {
    ws_conn *c = ws_at(h);
    if (!c || !c->open) return -1;
    int rc = ws_send_frame(c, 0x1, text ? text : "", text ? strlen(text) : 0);
    if (rc < 0) { c->open = 0; ws_set_err(c, "send failed"); }
    return rc < 0 ? -1 : 0;
}

/* Receive one text message (blocking). Returns "" on close/error;
   use ws_connected() to tell the two apart. */
char *ws_recv(long long h) {
    ws_conn *c = ws_at(h);
    if (!c || !c->open) return strdup("");
    char *m = ws_recv_msg(c);
    return m ? m : strdup("");
}

/* Receive with a timeout in milliseconds. "" if nothing arrived in time,
   on close, or on error. (Plain ws:// only honours the socket timeout;
   for wss:// the timeout applies to the first byte.) */
char *ws_recv_timeout(long long h, long long ms) {
    ws_conn *c = ws_at(h);
    if (!c || !c->open) return strdup("");
    struct timeval tv = { (time_t)(ms / 1000), (suseconds_t)((ms % 1000) * 1000) };
    setsockopt(c->fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    char *m = ws_recv_msg(c);
    struct timeval zero = { 0, 0 };
    setsockopt(c->fd, SOL_SOCKET, SO_RCVTIMEO, &zero, sizeof zero);
    return m ? m : strdup("");
}

/* Send a ping (optionally with a payload). 0 ok, -1 error. */
long long ws_ping(long long h, const char *payload) {
    ws_conn *c = ws_at(h);
    if (!c || !c->open) return -1;
    int rc = ws_send_frame(c, 0x9, payload ? payload : "", payload ? strlen(payload) : 0);
    return rc < 0 ? -1 : 0;
}

/* Is the connection still open? 1 / 0. */
long long ws_connected(long long h) {
    ws_conn *c = ws_at(h);
    return (c && c->open) ? 1 : 0;
}

/* Last error string for a handle (or a generic message). */
char *ws_error(long long h) {
    ws_conn *c = ws_at(h);
    return strdup(c && c->err[0] ? c->err : "no error");
}

/* Send a close frame and tear down. Always returns 0. */
long long ws_close(long long h) {
    ws_conn *c = ws_at(h);
    if (!c) return 0;
    if (c->open) ws_send_frame(c, 0x8, "", 0);
    if (c->ssl) { SSL_shutdown(c->ssl); SSL_free(c->ssl); SSL_CTX_free(c->ctx); }
    if (c->fd >= 0) close(c->fd);
    c->in_use = 0; c->open = 0;
    return 0;
}

char *ws_version(void) { return strdup("websocket 1.0.0 (RFC 6455, ws/wss)"); }
