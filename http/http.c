/* ═══════════════════════════════════════════════════════════════
   http — HTTP/HTTPS client for Ezy (wraps libcurl).

   Requests and responses are opaque integer handles. Two layers:
     • convenience: http_get / http_post / http_put / http_delete / http_fetch
     • builder: http_request → set headers/body/timeout → http_send

   The libcurl symbols are declared here directly, so no -dev header is
   needed; only the runtime libcurl.so.4 (ubiquitous) is required.

   Build: gcc -shared -fPIC http.c -o libhttp.so -l:libcurl.so.4
   ═══════════════════════════════════════════════════════════════ */
#define _POSIX_C_SOURCE 200809L
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <stdio.h>
#include <stdint.h>
#include <ctype.h>

/* ── minimal libcurl declarations (ABI-stable, no header needed) ── */
typedef void CURL;
struct curl_slist;
extern CURL *curl_easy_init(void);
extern int   curl_easy_setopt(CURL *, int, ...);
extern int   curl_easy_perform(CURL *);
extern int   curl_easy_getinfo(CURL *, int, ...);
extern void  curl_easy_cleanup(CURL *);
extern struct curl_slist *curl_slist_append(struct curl_slist *, const char *);
extern void  curl_slist_free_all(struct curl_slist *);
extern char *curl_version(void);

#define CURLOPT_URL              10002
#define CURLOPT_WRITEFUNCTION    20011
#define CURLOPT_WRITEDATA        10001
#define CURLOPT_HEADERFUNCTION   20079
#define CURLOPT_HEADERDATA       10029
#define CURLOPT_POSTFIELDS       10015
#define CURLOPT_POSTFIELDSIZE    60
#define CURLOPT_CUSTOMREQUEST    10036
#define CURLOPT_HTTPHEADER       10023
#define CURLOPT_TIMEOUT          13
#define CURLOPT_FOLLOWLOCATION   52
#define CURLOPT_USERAGENT        10018
#define CURLOPT_NOSIGNAL         99
#define CURLOPT_ACCEPT_ENCODING  10102
#define CURLINFO_RESPONSE_CODE   2097154

#define HND(p) ((long long)(intptr_t)(p))

/* ── growable buffer for the write/header callbacks ── */
typedef struct { char *d; size_t n; } Buf;
static size_t buf_cb(char *p, size_t s, size_t m, void *u) {
    size_t t = s * m;
    Buf *b = (Buf *)u;
    char *nd = realloc(b->d, b->n + t + 1);
    if (!nd) return 0;
    b->d = nd;
    memcpy(b->d + b->n, p, t);
    b->n += t;
    b->d[b->n] = '\0';
    return t;
}

typedef struct { long status; char *body; char *headers; } HttpResp;
typedef struct {
    char *method;
    char *url;
    char *body;
    struct curl_slist *hdrs;
    long  timeout;
} HttpReq;

static HttpResp *perform(HttpReq *req) {
    HttpResp *r = calloc(1, sizeof *r);
    CURL *c = curl_easy_init();
    if (!c) { r->body = strdup(""); r->headers = strdup(""); return r; }
    Buf body = {0}, head = {0};

    curl_easy_setopt(c, CURLOPT_URL, req->url ? req->url : "");
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, buf_cb);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &body);
    curl_easy_setopt(c, CURLOPT_HEADERFUNCTION, buf_cb);
    curl_easy_setopt(c, CURLOPT_HEADERDATA, &head);
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, (long)1);
    curl_easy_setopt(c, CURLOPT_NOSIGNAL, (long)1);
    curl_easy_setopt(c, CURLOPT_USERAGENT, "ezy-http/1.0");
    curl_easy_setopt(c, CURLOPT_ACCEPT_ENCODING, "");   /* all supported encodings */
    if (req->timeout > 0) curl_easy_setopt(c, CURLOPT_TIMEOUT, req->timeout);
    if (req->method)      curl_easy_setopt(c, CURLOPT_CUSTOMREQUEST, req->method);
    if (req->body) {
        curl_easy_setopt(c, CURLOPT_POSTFIELDS, req->body);
        curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)strlen(req->body));
    }
    if (req->hdrs) curl_easy_setopt(c, CURLOPT_HTTPHEADER, req->hdrs);

    if (curl_easy_perform(c) == 0)
        curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &r->status);
    curl_easy_cleanup(c);

    r->body    = body.d ? body.d : strdup("");
    r->headers = head.d ? head.d : strdup("");
    return r;
}

static HttpResp *quick(const char *method, const char *url, const char *body) {
    HttpReq req = {0};
    req.method = (char *)method;
    req.url    = (char *)url;
    req.body   = (char *)body;
    return perform(&req);
}

/* ═══════════════════════════════════════════════════════════════
   Convenience
   ═══════════════════════════════════════════════════════════════ */
long long http_get(const char *url)                    { return HND(quick(NULL,     url, NULL)); }
long long http_post(const char *url, const char *body) { return HND(quick("POST",   url, body)); }
long long http_put(const char *url, const char *body)  { return HND(quick("PUT",    url, body)); }
long long http_delete(const char *url)                 { return HND(quick("DELETE", url, NULL)); }

/* GET and return the body directly (empty string on error) */
char *http_fetch(const char *url) {
    HttpResp *r = quick(NULL, url, NULL);
    char *b = r->body ? strdup(r->body) : strdup("");
    free(r->body); free(r->headers); free(r);
    return b;
}

/* ═══════════════════════════════════════════════════════════════
   Response inspection
   ═══════════════════════════════════════════════════════════════ */
long long http_status(long long h) { HttpResp *r = (HttpResp*)(intptr_t)h; return r ? r->status : 0; }
long long http_ok(long long h)     { HttpResp *r = (HttpResp*)(intptr_t)h; return (r && r->status >= 200 && r->status < 300) ? 1 : 0; }
char *http_body(long long h)       { HttpResp *r = (HttpResp*)(intptr_t)h; return strdup((r && r->body) ? r->body : ""); }

/* a response header by name (case-insensitive); "" if absent */
char *http_header(long long h, const char *name) {
    HttpResp *r = (HttpResp*)(intptr_t)h;
    if (!r || !r->headers || !name) return strdup("");
    size_t nl = strlen(name);
    const char *p = r->headers;
    while (*p) {
        const char *eol = strchr(p, '\n');
        size_t linelen = eol ? (size_t)(eol - p) : strlen(p);
        if (linelen > nl && strncasecmp(p, name, nl) == 0 && p[nl] == ':') {
            const char *v = p + nl + 1;
            while (*v == ' ' || *v == '\t') v++;
            size_t vl = (p + linelen) - v;
            while (vl > 0 && (v[vl-1] == '\r' || v[vl-1] == ' ')) vl--;
            char *out = malloc(vl + 1);
            memcpy(out, v, vl); out[vl] = '\0';
            return out;
        }
        if (!eol) break;
        p = eol + 1;
    }
    return strdup("");
}
long long http_free(long long h) {
    HttpResp *r = (HttpResp*)(intptr_t)h;
    if (!r) return 0;
    free(r->body); free(r->headers); free(r);
    return 0;
}

/* ═══════════════════════════════════════════════════════════════
   Builder — custom method, headers, body, timeout
   ═══════════════════════════════════════════════════════════════ */
long long http_request(const char *method, const char *url) {
    HttpReq *req = calloc(1, sizeof *req);
    if (method) req->method = strdup(method);
    req->url = strdup(url ? url : "");
    return HND(req);
}
long long http_set_header(long long h, const char *name, const char *value) {
    HttpReq *req = (HttpReq*)(intptr_t)h;
    if (!req || !name) return 0;
    char line[4096];
    snprintf(line, sizeof line, "%s: %s", name, value ? value : "");
    req->hdrs = curl_slist_append(req->hdrs, line);
    return 1;
}
long long http_set_body(long long h, const char *body) {
    HttpReq *req = (HttpReq*)(intptr_t)h;
    if (!req) return 0;
    free(req->body);
    req->body = strdup(body ? body : "");
    return 1;
}
long long http_set_timeout(long long h, long long seconds) {
    HttpReq *req = (HttpReq*)(intptr_t)h;
    if (!req) return 0;
    req->timeout = (long)seconds;
    return 1;
}
/* perform the request, free it, and return a response handle */
long long http_send(long long h) {
    HttpReq *req = (HttpReq*)(intptr_t)h;
    if (!req) return 0;
    HttpResp *r = perform(req);
    free(req->method); free(req->url); free(req->body);
    if (req->hdrs) curl_slist_free_all(req->hdrs);
    free(req);
    return HND(r);
}
long long http_request_free(long long h) {
    HttpReq *req = (HttpReq*)(intptr_t)h;
    if (!req) return 0;
    free(req->method); free(req->url); free(req->body);
    if (req->hdrs) curl_slist_free_all(req->hdrs);
    free(req);
    return 0;
}

const char *http_version(void) { return curl_version(); }
