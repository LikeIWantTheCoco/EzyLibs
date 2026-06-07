/* ═══════════════════════════════════════════════════════════════
   regex — Perl-compatible regular expressions for Ezy (wraps PCRE2).

   Two layers:
     • convenience calls (match / find / group / count / replace) that
       compile the pattern on each call — handy for one-offs.
     • a match object (regex_exec → handle) for iterating every match
       and reading capture groups, including named groups.

   Build: gcc -shared -fPIC regex.c -o libregex.so -lpcre2-8
   ═══════════════════════════════════════════════════════════════ */
#define _POSIX_C_SOURCE 200809L
#define PCRE2_CODE_UNIT_WIDTH 8
#include <pcre2.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define HND(p) ((long long)(intptr_t)(p))

/* ── helpers ──────────────────────────────────────────── */
static pcre2_code *compile(const char *pat) {
    if (!pat) return NULL;
    int errc; PCRE2_SIZE erro;
    return pcre2_compile((PCRE2_SPTR)pat, PCRE2_ZERO_TERMINATED, 0, &errc, &erro, NULL);
}
static char *substr(const char *s, PCRE2_SIZE a, PCRE2_SIZE b) {
    if (a == PCRE2_UNSET || b == PCRE2_UNSET || b < a) return strdup("");
    size_t n = (size_t)(b - a);
    char *r = malloc(n + 1);
    memcpy(r, s + a, n); r[n] = '\0';
    return r;
}

/* ═══════════════════════════════════════════════════════════════
   Convenience (compile per call)
   ═══════════════════════════════════════════════════════════════ */

/* does the pattern match anywhere in text? */
long long regex_match(const char *pat, const char *text) {
    pcre2_code *re = compile(pat);
    if (!re || !text) { if (re) pcre2_code_free(re); return 0; }
    pcre2_match_data *md = pcre2_match_data_create_from_pattern(re, NULL);
    int rc = pcre2_match(re, (PCRE2_SPTR)text, PCRE2_ZERO_TERMINATED, 0, 0, md, NULL);
    pcre2_match_data_free(md); pcre2_code_free(re);
    return rc >= 0 ? 1 : 0;
}

/* first whole match (group 0), or "" */
char *regex_find(const char *pat, const char *text) {
    pcre2_code *re = compile(pat);
    if (!re || !text) { if (re) pcre2_code_free(re); return strdup(""); }
    pcre2_match_data *md = pcre2_match_data_create_from_pattern(re, NULL);
    int rc = pcre2_match(re, (PCRE2_SPTR)text, PCRE2_ZERO_TERMINATED, 0, 0, md, NULL);
    char *out = strdup("");
    if (rc >= 0) {
        PCRE2_SIZE *ov = pcre2_get_ovector_pointer(md);
        free(out); out = substr(text, ov[0], ov[1]);
    }
    pcre2_match_data_free(md); pcre2_code_free(re);
    return out;
}

/* nth capture group of the first match (0 = whole match), or "" */
char *regex_group(const char *pat, const char *text, long long n) {
    pcre2_code *re = compile(pat);
    if (!re || !text) { if (re) pcre2_code_free(re); return strdup(""); }
    pcre2_match_data *md = pcre2_match_data_create_from_pattern(re, NULL);
    int rc = pcre2_match(re, (PCRE2_SPTR)text, PCRE2_ZERO_TERMINATED, 0, 0, md, NULL);
    char *out = strdup("");
    if (rc > (int)n && n >= 0) {
        PCRE2_SIZE *ov = pcre2_get_ovector_pointer(md);
        free(out); out = substr(text, ov[2*n], ov[2*n+1]);
    }
    pcre2_match_data_free(md); pcre2_code_free(re);
    return out;
}

/* number of non-overlapping matches */
long long regex_count(const char *pat, const char *text) {
    pcre2_code *re = compile(pat);
    if (!re || !text) { if (re) pcre2_code_free(re); return 0; }
    pcre2_match_data *md = pcre2_match_data_create_from_pattern(re, NULL);
    size_t len = strlen(text), off = 0;
    long long cnt = 0;
    while (off <= len) {
        int rc = pcre2_match(re, (PCRE2_SPTR)text, len, off, 0, md, NULL);
        if (rc < 0) break;
        PCRE2_SIZE *ov = pcre2_get_ovector_pointer(md);
        cnt++;
        off = (ov[1] > ov[0]) ? ov[1] : ov[1] + 1;   /* advance past empty matches */
    }
    pcre2_match_data_free(md); pcre2_code_free(re);
    return cnt;
}

static char *replace_impl(const char *pat, const char *text, const char *repl, int global) {
    pcre2_code *re = compile(pat);
    if (!re || !text) { if (re) pcre2_code_free(re); return strdup(text ? text : ""); }
    if (!repl) repl = "";
    uint32_t opt = PCRE2_SUBSTITUTE_OVERFLOW_LENGTH | (global ? PCRE2_SUBSTITUTE_GLOBAL : 0);
    PCRE2_SIZE outlen = strlen(text) * 2 + 64;
    char *out = malloc(outlen);
    int rc = pcre2_substitute(re, (PCRE2_SPTR)text, PCRE2_ZERO_TERMINATED, 0, opt, NULL, NULL,
                              (PCRE2_SPTR)repl, PCRE2_ZERO_TERMINATED, (PCRE2_UCHAR*)out, &outlen);
    if (rc == PCRE2_ERROR_NOMEMORY) {            /* grow to the reported size */
        out = realloc(out, outlen);
        rc = pcre2_substitute(re, (PCRE2_SPTR)text, PCRE2_ZERO_TERMINATED, 0, opt, NULL, NULL,
                              (PCRE2_SPTR)repl, PCRE2_ZERO_TERMINATED, (PCRE2_UCHAR*)out, &outlen);
    }
    if (rc < 0) { free(out); out = strdup(text); }
    pcre2_code_free(re);
    return out;
}
/* replace every match; $1, ${name}, $0 supported in repl */
char *regex_replace(const char *pat, const char *text, const char *repl)       { return replace_impl(pat, text, repl, 1); }
char *regex_replace_first(const char *pat, const char *text, const char *repl) { return replace_impl(pat, text, repl, 0); }

/* ═══════════════════════════════════════════════════════════════
   Match object — iterate matches and read groups
   ═══════════════════════════════════════════════════════════════ */
typedef struct {
    pcre2_code       *re;        /* owned */
    char             *subject;   /* owned copy */
    size_t            len;
    pcre2_match_data *md;
    size_t            next;      /* search start for the following match */
    int               rc;        /* group count of the current match (+1) */
    int               valid;     /* 1 if the current match is good */
} RxMatch;

static int rx_advance(RxMatch *m) {
    if (m->next > m->len) { m->valid = 0; return 0; }
    int rc = pcre2_match(m->re, (PCRE2_SPTR)m->subject, m->len, m->next, 0, m->md, NULL);
    if (rc < 0) { m->valid = 0; return 0; }
    PCRE2_SIZE *ov = pcre2_get_ovector_pointer(m->md);
    m->rc = rc; m->valid = 1;
    m->next = (ov[1] > ov[0]) ? ov[1] : ov[1] + 1;
    return 1;
}

/* compile + find the first match; 0 if the pattern fails or no match */
long long regex_exec(const char *pat, const char *text) {
    pcre2_code *re = compile(pat);
    if (!re || !text) { if (re) pcre2_code_free(re); return 0; }
    RxMatch *m = calloc(1, sizeof *m);
    m->re = re;
    m->subject = strdup(text);
    m->len = strlen(text);
    m->md = pcre2_match_data_create_from_pattern(re, NULL);
    m->next = 0;
    if (!rx_advance(m)) {
        pcre2_match_data_free(m->md); pcre2_code_free(m->re);
        free(m->subject); free(m);
        return 0;
    }
    return HND(m);
}
/* advance to the next match in the same text; 1 if found, 0 if done */
long long regex_next(long long h) {
    RxMatch *m = (RxMatch*)(intptr_t)h;
    return (m && rx_advance(m)) ? 1 : 0;
}
long long regex_match_start(long long h) {
    RxMatch *m = (RxMatch*)(intptr_t)h;
    if (!m || !m->valid) return -1;
    return (long long)pcre2_get_ovector_pointer(m->md)[0];
}
long long regex_match_end(long long h) {
    RxMatch *m = (RxMatch*)(intptr_t)h;
    if (!m || !m->valid) return -1;
    return (long long)pcre2_get_ovector_pointer(m->md)[1];
}
char *regex_match_str(long long h) {
    RxMatch *m = (RxMatch*)(intptr_t)h;
    if (!m || !m->valid) return strdup("");
    PCRE2_SIZE *ov = pcre2_get_ovector_pointer(m->md);
    return substr(m->subject, ov[0], ov[1]);
}
long long regex_group_count(long long h) {
    RxMatch *m = (RxMatch*)(intptr_t)h;
    return (m && m->valid) ? m->rc - 1 : 0;   /* exclude group 0 */
}
char *regex_match_group(long long h, long long n) {
    RxMatch *m = (RxMatch*)(intptr_t)h;
    if (!m || !m->valid || n < 0 || n >= m->rc) return strdup("");
    PCRE2_SIZE *ov = pcre2_get_ovector_pointer(m->md);
    return substr(m->subject, ov[2*n], ov[2*n+1]);
}
char *regex_named(long long h, const char *name) {
    RxMatch *m = (RxMatch*)(intptr_t)h;
    if (!m || !m->valid || !name) return strdup("");
    PCRE2_UCHAR *buf = NULL; PCRE2_SIZE blen = 0;
    int rc = pcre2_substring_get_byname(m->md, (PCRE2_SPTR)name, &buf, &blen);
    if (rc < 0) return strdup("");
    char *out = strdup((const char*)buf);
    pcre2_substring_free(buf);
    return out;
}
long long regex_match_free(long long h) {
    RxMatch *m = (RxMatch*)(intptr_t)h;
    if (!m) return 0;
    pcre2_match_data_free(m->md);
    pcre2_code_free(m->re);
    free(m->subject); free(m);
    return 0;
}

/* is the pattern itself valid? */
long long regex_valid(const char *pat) {
    pcre2_code *re = compile(pat);
    if (re) { pcre2_code_free(re); return 1; }
    return 0;
}
