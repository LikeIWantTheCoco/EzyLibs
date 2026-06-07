/* ═══════════════════════════════════════════════════════════════
   crypto — hashing, HMAC, base64/hex and random bytes for Ezy.

   Digests and HMAC come from OpenSSL (libcrypto); base64 and hex are
   hand-rolled. All results are text (hex digests, base64), safe to pass
   around as Ezy strings.

   Build: gcc -shared -fPIC crypto.c -o libcrypto_ezy.so -l:libcrypto.so.3
   ═══════════════════════════════════════════════════════════════ */
#define _POSIX_C_SOURCE 200809L
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>

/* ── hex ── */
static char *to_hex(const unsigned char *b, size_t n) {
    char *o = malloc(n * 2 + 1);
    static const char *h = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) { o[i*2] = h[b[i]>>4]; o[i*2+1] = h[b[i]&15]; }
    o[n*2] = '\0';
    return o;
}
static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

char *hex_encode(const char *s) {
    if (!s) return strdup("");
    return to_hex((const unsigned char *)s, strlen(s));
}
char *hex_decode(const char *s) {
    if (!s) return strdup("");
    size_t n = strlen(s) / 2;
    char *o = malloc(n + 1);
    for (size_t i = 0; i < n; i++) {
        int hi = hexval(s[i*2]), lo = hexval(s[i*2+1]);
        if (hi < 0 || lo < 0) { o[i] = 0; break; }
        o[i] = (char)((hi << 4) | lo);
    }
    o[n] = '\0';
    return o;
}

/* ── base64 ── */
static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
char *base64_encode(const char *in) {
    if (!in) return strdup("");
    size_t len = strlen(in);
    size_t olen = 4 * ((len + 2) / 3);
    char *out = malloc(olen + 1);
    size_t i, j;
    const unsigned char *d = (const unsigned char *)in;
    for (i = 0, j = 0; i < len;) {
        unsigned a = i < len ? d[i++] : 0;
        unsigned b = i < len ? d[i++] : 0;
        unsigned c = i < len ? d[i++] : 0;
        unsigned t = (a << 16) | (b << 8) | c;
        out[j++] = B64[(t >> 18) & 63];
        out[j++] = B64[(t >> 12) & 63];
        out[j++] = B64[(t >> 6) & 63];
        out[j++] = B64[t & 63];
    }
    int mod = len % 3;
    if (mod == 1) { out[olen-1] = '='; out[olen-2] = '='; }
    else if (mod == 2) { out[olen-1] = '='; }
    out[olen] = '\0';
    return out;
}
char *base64_decode(const char *in) {
    if (!in) return strdup("");
    static int rev[256], init = 0;
    if (!init) {
        for (int k = 0; k < 256; k++) rev[k] = -1;
        for (int k = 0; k < 64; k++) rev[(unsigned char)B64[k]] = k;
        init = 1;
    }
    size_t len = strlen(in);
    char *out = malloc(len / 4 * 3 + 4);
    size_t j = 0; int buf = 0, bits = 0;
    for (size_t i = 0; i < len; i++) {
        if (in[i] == '=') break;
        int v = rev[(unsigned char)in[i]];
        if (v < 0) continue;
        buf = (buf << 6) | v; bits += 6;
        if (bits >= 8) { bits -= 8; out[j++] = (char)((buf >> bits) & 0xFF); }
    }
    out[j] = '\0';
    return out;
}

/* ── digests (OpenSSL EVP) ── */
static char *digest_hex(const EVP_MD *md, const unsigned char *data, size_t len) {
    unsigned char out[EVP_MAX_MD_SIZE]; unsigned int olen = 0;
    EVP_Digest(data, len, out, &olen, md, NULL);
    return to_hex(out, olen);
}
char *md5(const char *s)    { return digest_hex(EVP_md5(),    (const unsigned char*)(s?s:""), s?strlen(s):0); }
char *sha1(const char *s)   { return digest_hex(EVP_sha1(),   (const unsigned char*)(s?s:""), s?strlen(s):0); }
char *sha256(const char *s) { return digest_hex(EVP_sha256(), (const unsigned char*)(s?s:""), s?strlen(s):0); }
char *sha512(const char *s) { return digest_hex(EVP_sha512(), (const unsigned char*)(s?s:""), s?strlen(s):0); }

/* hash a whole file (streamed); empty string on error */
static char *digest_file(const EVP_MD *md, const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return strdup("");
    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    EVP_DigestInit_ex(ctx, md, NULL);
    unsigned char buf[65536]; size_t n;
    while ((n = fread(buf, 1, sizeof buf, f)) > 0) EVP_DigestUpdate(ctx, buf, n);
    fclose(f);
    unsigned char out[EVP_MAX_MD_SIZE]; unsigned int olen = 0;
    EVP_DigestFinal_ex(ctx, out, &olen);
    EVP_MD_CTX_free(ctx);
    return to_hex(out, olen);
}
char *md5_file(const char *p)    { return p ? digest_file(EVP_md5(), p)    : strdup(""); }
char *sha256_file(const char *p) { return p ? digest_file(EVP_sha256(), p) : strdup(""); }

/* ── HMAC ── */
char *hmac_sha256(const char *key, const char *msg) {
    if (!key) key = "";
    if (!msg) msg = "";
    unsigned char out[EVP_MAX_MD_SIZE]; unsigned int olen = 0;
    HMAC(EVP_sha256(), key, (int)strlen(key),
         (const unsigned char*)msg, strlen(msg), out, &olen);
    return to_hex(out, olen);
}
char *hmac_sha1(const char *key, const char *msg) {
    if (!key) key = "";
    if (!msg) msg = "";
    unsigned char out[EVP_MAX_MD_SIZE]; unsigned int olen = 0;
    HMAC(EVP_sha1(), key, (int)strlen(key),
         (const unsigned char*)msg, strlen(msg), out, &olen);
    return to_hex(out, olen);
}

/* ── random ── */
/* n random bytes as a hex string */
char *random_hex(long long n) {
    if (n <= 0) return strdup("");
    unsigned char *b = malloc((size_t)n);
    if (RAND_bytes(b, (int)n) != 1) { free(b); return strdup(""); }
    char *o = to_hex(b, (size_t)n);
    free(b);
    return o;
}
/* a random integer in [0, max) */
long long random_int(long long max) {
    if (max <= 0) return 0;
    unsigned long long r = 0;
    RAND_bytes((unsigned char*)&r, sizeof r);
    return (long long)(r % (unsigned long long)max);
}
