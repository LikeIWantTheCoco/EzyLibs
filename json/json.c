/* ═══════════════════════════════════════════════════════════════
   json — a self-contained JSON library for Ezy.

   Values are exposed to Ezy as opaque integer handles (a JVal* cast to
   long long). 0 is the null handle (missing / error). A parsed document
   owns its whole tree; freeing the root frees everything. Values handed
   to json_set / json_append are owned by the container afterwards.

   Build: gcc -shared -fPIC json.c -o libjson.so
   ═══════════════════════════════════════════════════════════════ */
#define _POSIX_C_SOURCE 200809L
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>

typedef enum { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ } JType;

typedef struct JVal {
    JType type;
    int   isint;                 /* J_NUM: 1 if the number is integral */
    union {
        long long  b;            /* J_BOOL */
        double     num;          /* J_NUM  */
        char      *str;          /* J_STR (owned) */
        struct { struct JVal **items; int len, cap; } arr;
        struct { char **keys; struct JVal **vals; int len, cap; } obj;
    };
} JVal;

#define H(p)  ((long long)(intptr_t)(p))   /* JVal* -> handle */
#define V(h)  ((JVal*)(intptr_t)(h))       /* handle -> JVal* */

/* ── constructors ─────────────────────────────────────── */
static JVal *jalloc(JType t) {
    JVal *v = calloc(1, sizeof *v);
    v->type = t;
    return v;
}
static JVal *jnull(void)          { return jalloc(J_NULL); }
static JVal *jbool(long long b)   { JVal *v = jalloc(J_BOOL); v->b = b ? 1 : 0; return v; }
static JVal *jint(long long n)    { JVal *v = jalloc(J_NUM); v->num = (double)n; v->isint = 1; return v; }
static JVal *jflt(double x)       { JVal *v = jalloc(J_NUM); v->num = x; v->isint = 0; return v; }
static JVal *jstr(const char *s)  { JVal *v = jalloc(J_STR); v->str = strdup(s ? s : ""); return v; }

static void arr_push(JVal *a, JVal *e) {
    if (a->type != J_ARR) return;
    if (a->arr.len >= a->arr.cap) {
        a->arr.cap = a->arr.cap ? a->arr.cap * 2 : 8;
        a->arr.items = realloc(a->arr.items, (size_t)a->arr.cap * sizeof(JVal*));
    }
    a->arr.items[a->arr.len++] = e;
}
static void obj_set(JVal *o, const char *key, JVal *val) {
    if (o->type != J_OBJ || !key) return;
    for (int i = 0; i < o->obj.len; i++)
        if (strcmp(o->obj.keys[i], key) == 0) {        /* replace existing */
            o->obj.vals[i] = val;
            return;
        }
    if (o->obj.len >= o->obj.cap) {
        o->obj.cap = o->obj.cap ? o->obj.cap * 2 : 8;
        o->obj.keys = realloc(o->obj.keys, (size_t)o->obj.cap * sizeof(char*));
        o->obj.vals = realloc(o->obj.vals, (size_t)o->obj.cap * sizeof(JVal*));
    }
    o->obj.keys[o->obj.len] = strdup(key);
    o->obj.vals[o->obj.len] = val;
    o->obj.len++;
}

static void jfree(JVal *v) {
    if (!v) return;
    switch (v->type) {
        case J_STR: free(v->str); break;
        case J_ARR:
            for (int i = 0; i < v->arr.len; i++) jfree(v->arr.items[i]);
            free(v->arr.items);
            break;
        case J_OBJ:
            for (int i = 0; i < v->obj.len; i++) { free(v->obj.keys[i]); jfree(v->obj.vals[i]); }
            free(v->obj.keys); free(v->obj.vals);
            break;
        default: break;
    }
    free(v);
}

/* ── parser ───────────────────────────────────────────── */
typedef struct { const char *p; int ok; } JP;

static void skipws(JP *jp) {
    while (*jp->p == ' ' || *jp->p == '\t' || *jp->p == '\n' || *jp->p == '\r') jp->p++;
}
static JVal *parse_value(JP *jp);

static void utf8_encode(unsigned cp, char *out, int *n) {
    if (cp < 0x80)        { out[(*n)++] = (char)cp; }
    else if (cp < 0x800)  { out[(*n)++] = (char)(0xC0 | (cp >> 6));
                            out[(*n)++] = (char)(0x80 | (cp & 0x3F)); }
    else                  { out[(*n)++] = (char)(0xE0 | (cp >> 12));
                            out[(*n)++] = (char)(0x80 | ((cp >> 6) & 0x3F));
                            out[(*n)++] = (char)(0x80 | (cp & 0x3F)); }
}

static char *parse_raw_string(JP *jp) {
    if (*jp->p != '"') { jp->ok = 0; return NULL; }
    jp->p++;
    size_t cap = 16, len = 0;
    char *buf = malloc(cap);
    while (*jp->p && *jp->p != '"') {
        if (len + 4 >= cap) { cap *= 2; buf = realloc(buf, cap); }
        char c = *jp->p++;
        if (c == '\\') {
            char e = *jp->p++;
            switch (e) {
                case '"':  buf[len++] = '"';  break;
                case '\\': buf[len++] = '\\'; break;
                case '/':  buf[len++] = '/';  break;
                case 'b':  buf[len++] = '\b'; break;
                case 'f':  buf[len++] = '\f'; break;
                case 'n':  buf[len++] = '\n'; break;
                case 't':  buf[len++] = '\t'; break;
                case 'r':  buf[len++] = '\r'; break;
                case 'u': {
                    unsigned cp = 0;
                    for (int i = 0; i < 4 && *jp->p; i++) {
                        char h = *jp->p++;
                        cp <<= 4;
                        if (h >= '0' && h <= '9')      cp |= (unsigned)(h - '0');
                        else if (h >= 'a' && h <= 'f') cp |= (unsigned)(h - 'a' + 10);
                        else if (h >= 'A' && h <= 'F') cp |= (unsigned)(h - 'A' + 10);
                    }
                    int n = 0; char tmp[4]; utf8_encode(cp, tmp, &n);
                    for (int i = 0; i < n; i++) buf[len++] = tmp[i];
                    break;
                }
                default: buf[len++] = e; break;
            }
        } else {
            buf[len++] = c;
        }
    }
    if (*jp->p == '"') jp->p++; else jp->ok = 0;
    buf[len] = '\0';
    return buf;
}

static JVal *parse_value(JP *jp) {
    skipws(jp);
    char c = *jp->p;
    if (c == '"') { char *s = parse_raw_string(jp); JVal *v = jalloc(J_STR); v->str = s; return v; }
    if (c == '{') {
        jp->p++;
        JVal *o = jalloc(J_OBJ);
        skipws(jp);
        if (*jp->p == '}') { jp->p++; return o; }
        for (;;) {
            skipws(jp);
            char *key = parse_raw_string(jp);
            if (!jp->ok) { free(key); break; }
            skipws(jp);
            if (*jp->p == ':') jp->p++; else { jp->ok = 0; free(key); break; }
            JVal *val = parse_value(jp);
            obj_set(o, key, val);
            free(key);
            skipws(jp);
            if (*jp->p == ',') { jp->p++; continue; }
            if (*jp->p == '}') { jp->p++; break; }
            jp->ok = 0; break;
        }
        return o;
    }
    if (c == '[') {
        jp->p++;
        JVal *a = jalloc(J_ARR);
        skipws(jp);
        if (*jp->p == ']') { jp->p++; return a; }
        for (;;) {
            JVal *e = parse_value(jp);
            arr_push(a, e);
            skipws(jp);
            if (*jp->p == ',') { jp->p++; continue; }
            if (*jp->p == ']') { jp->p++; break; }
            jp->ok = 0; break;
        }
        return a;
    }
    if (c == 't') { if (strncmp(jp->p, "true", 4) == 0)  { jp->p += 4; return jbool(1); } jp->ok = 0; return jnull(); }
    if (c == 'f') { if (strncmp(jp->p, "false", 5) == 0) { jp->p += 5; return jbool(0); } jp->ok = 0; return jnull(); }
    if (c == 'n') { if (strncmp(jp->p, "null", 4) == 0)  { jp->p += 4; return jnull(); } jp->ok = 0; return jnull(); }
    /* number */
    if (c == '-' || (c >= '0' && c <= '9')) {
        const char *start = jp->p;
        int isint = 1;
        if (*jp->p == '-') jp->p++;
        while (*jp->p >= '0' && *jp->p <= '9') jp->p++;
        if (*jp->p == '.') { isint = 0; jp->p++; while (*jp->p >= '0' && *jp->p <= '9') jp->p++; }
        if (*jp->p == 'e' || *jp->p == 'E') {
            isint = 0; jp->p++;
            if (*jp->p == '+' || *jp->p == '-') jp->p++;
            while (*jp->p >= '0' && *jp->p <= '9') jp->p++;
        }
        char *end;
        double num = strtod(start, &end);
        JVal *v = jalloc(J_NUM); v->num = num; v->isint = isint;
        return v;
    }
    jp->ok = 0;
    return jnull();
}

/* ── serializer ───────────────────────────────────────── */
typedef struct { char *buf; size_t len, cap; } SB;
static void sb_putc(SB *s, char c) {
    if (s->len + 1 >= s->cap) { s->cap = s->cap ? s->cap * 2 : 64; s->buf = realloc(s->buf, s->cap); }
    s->buf[s->len++] = c;
}
static void sb_puts(SB *s, const char *t) { for (; *t; t++) sb_putc(s, *t); }
static void sb_indent(SB *s, int depth) { for (int i = 0; i < depth * 2; i++) sb_putc(s, ' '); }

static void sb_escaped(SB *s, const char *str) {
    sb_putc(s, '"');
    for (const unsigned char *p = (const unsigned char *)str; p && *p; p++) {
        switch (*p) {
            case '"':  sb_puts(s, "\\\""); break;
            case '\\': sb_puts(s, "\\\\"); break;
            case '\n': sb_puts(s, "\\n");  break;
            case '\t': sb_puts(s, "\\t");  break;
            case '\r': sb_puts(s, "\\r");  break;
            case '\b': sb_puts(s, "\\b");  break;
            case '\f': sb_puts(s, "\\f");  break;
            default:
                if (*p < 0x20) { char tmp[8]; snprintf(tmp, sizeof tmp, "\\u%04x", *p); sb_puts(s, tmp); }
                else sb_putc(s, (char)*p);
        }
    }
    sb_putc(s, '"');
}

static void sb_num(SB *s, JVal *v) {
    char tmp[40];
    if (v->isint) snprintf(tmp, sizeof tmp, "%lld", (long long)v->num);
    else          snprintf(tmp, sizeof tmp, "%.17g", v->num);
    sb_puts(s, tmp);
}

static void serialize(SB *s, JVal *v, int pretty, int depth) {
    if (!v) { sb_puts(s, "null"); return; }
    switch (v->type) {
        case J_NULL: sb_puts(s, "null"); break;
        case J_BOOL: sb_puts(s, v->b ? "true" : "false"); break;
        case J_NUM:  sb_num(s, v); break;
        case J_STR:  sb_escaped(s, v->str ? v->str : ""); break;
        case J_ARR:
            if (v->arr.len == 0) { sb_puts(s, "[]"); break; }
            sb_putc(s, '[');
            for (int i = 0; i < v->arr.len; i++) {
                if (pretty) { sb_putc(s, '\n'); sb_indent(s, depth + 1); }
                serialize(s, v->arr.items[i], pretty, depth + 1);
                if (i < v->arr.len - 1) sb_putc(s, ',');
            }
            if (pretty) { sb_putc(s, '\n'); sb_indent(s, depth); }
            sb_putc(s, ']');
            break;
        case J_OBJ:
            if (v->obj.len == 0) { sb_puts(s, "{}"); break; }
            sb_putc(s, '{');
            for (int i = 0; i < v->obj.len; i++) {
                if (pretty) { sb_putc(s, '\n'); sb_indent(s, depth + 1); }
                sb_escaped(s, v->obj.keys[i]);
                sb_putc(s, ':');
                if (pretty) sb_putc(s, ' ');
                serialize(s, v->obj.vals[i], pretty, depth + 1);
                if (i < v->obj.len - 1) sb_putc(s, ',');
            }
            if (pretty) { sb_putc(s, '\n'); sb_indent(s, depth); }
            sb_putc(s, '}');
            break;
    }
}

static char *to_string(JVal *v, int pretty) {
    SB s = {0};
    serialize(&s, v, pretty, 0);
    sb_putc(&s, '\0');
    return s.buf ? s.buf : strdup("");
}

/* ═══════════════════════════════════════════════════════════════
   Public API (handles are JVal* as long long; 0 = null handle)
   ═══════════════════════════════════════════════════════════════ */

long long json_parse(const char *s) {
    if (!s) return 0;
    JP jp = { s, 1 };
    JVal *v = parse_value(&jp);
    if (!jp.ok) { jfree(v); return 0; }
    return H(v);
}
char *json_stringify(long long h) { return to_string(V(h), 0); }
char *json_pretty(long long h)    { return to_string(V(h), 1); }

long long json_load(const char *path) {
    if (!path) return 0;
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    fseek(f, 0, SEEK_END); long sz = ftell(f); rewind(f);
    char *b = malloc((size_t)sz + 1);
    if (fread(b, 1, (size_t)sz, f) != (size_t)sz) { /* short read tolerated */ }
    b[sz] = '\0'; fclose(f);
    long long h = json_parse(b);
    free(b);
    return h;
}
static long long save_impl(long long h, const char *path, int pretty) {
    if (!path) return 0;
    FILE *f = fopen(path, "w");
    if (!f) return 0;
    char *s = to_string(V(h), pretty);
    fputs(s, f); if (pretty) fputc('\n', f);
    free(s); fclose(f);
    return 1;
}
long long json_save(long long h, const char *path)        { return save_impl(h, path, 0); }
long long json_save_pretty(long long h, const char *path) { return save_impl(h, path, 1); }

/* ── type inspection ── */
const char *json_type(long long h) {
    JVal *v = V(h);
    if (!v) return "null";
    switch (v->type) {
        case J_NULL: return "null";  case J_BOOL: return "bool";
        case J_NUM:  return "number"; case J_STR: return "string";
        case J_ARR:  return "array";  case J_OBJ: return "object";
    }
    return "null";
}
long long json_is_null(long long h)   { JVal *v = V(h); return (!v || v->type == J_NULL) ? 1 : 0; }
long long json_is_object(long long h) { JVal *v = V(h); return (v && v->type == J_OBJ) ? 1 : 0; }
long long json_is_array(long long h)  { JVal *v = V(h); return (v && v->type == J_ARR) ? 1 : 0; }
long long json_is_number(long long h) { JVal *v = V(h); return (v && v->type == J_NUM) ? 1 : 0; }
long long json_is_string(long long h) { JVal *v = V(h); return (v && v->type == J_STR) ? 1 : 0; }
long long json_is_bool(long long h)   { JVal *v = V(h); return (v && v->type == J_BOOL) ? 1 : 0; }

/* ── leaf extraction ── */
long long json_int(long long h)   { JVal *v = V(h); return (v && v->type == J_NUM) ? (long long)v->num : 0; }
double    json_float(long long h) { JVal *v = V(h); return (v && v->type == J_NUM) ? v->num : 0.0; }
long long json_bool(long long h)  { JVal *v = V(h); return (v && v->type == J_BOOL) ? v->b : 0; }
char     *json_string(long long h){ JVal *v = V(h); return strdup((v && v->type == J_STR && v->str) ? v->str : ""); }

/* ── object access ── */
long long json_get(long long h, const char *key) {
    JVal *v = V(h);
    if (!v || v->type != J_OBJ || !key) return 0;
    for (int i = 0; i < v->obj.len; i++)
        if (strcmp(v->obj.keys[i], key) == 0) return H(v->obj.vals[i]);
    return 0;
}
long long json_has(long long h, const char *key) { return json_get(h, key) != 0; }
long long json_size(long long h) {
    JVal *v = V(h);
    if (!v) return 0;
    if (v->type == J_OBJ) return v->obj.len;
    if (v->type == J_ARR) return v->arr.len;
    return 0;
}
char *json_key_at(long long h, long long i) {
    JVal *v = V(h);
    if (!v || v->type != J_OBJ || i < 0 || i >= v->obj.len) return strdup("");
    return strdup(v->obj.keys[i]);
}

/* convenience: get + extract in one call */
char     *json_get_string(long long h, const char *key) { return json_string(json_get(h, key)); }
long long json_get_int(long long h, const char *key)    { return json_int(json_get(h, key)); }
double    json_get_float(long long h, const char *key)  { return json_float(json_get(h, key)); }
long long json_get_bool(long long h, const char *key)   { return json_bool(json_get(h, key)); }

/* ── array access ── */
long long json_at(long long h, long long i) {
    JVal *v = V(h);
    if (!v || v->type != J_ARR || i < 0 || i >= v->arr.len) return 0;
    return H(v->arr.items[i]);
}
long long json_len(long long h) { JVal *v = V(h); return (v && v->type == J_ARR) ? v->arr.len : 0; }

/* ── construction ── */
long long json_object(void)            { return H(jalloc(J_OBJ)); }
long long json_array(void)             { return H(jalloc(J_ARR)); }
long long json_new_string(const char *s){ return H(jstr(s)); }
long long json_new_int(long long n)    { return H(jint(n)); }
long long json_new_float(double x)     { return H(jflt(x)); }
long long json_new_bool(long long b)   { return H(jbool(b)); }
long long json_null(void)              { return H(jnull()); }

/* ── mutation (container takes ownership of val) ── */
long long json_set(long long obj, const char *key, long long val) {
    JVal *o = V(obj); if (!o || o->type != J_OBJ) return 0;
    obj_set(o, key, V(val)); return 1;
}
long long json_set_string(long long obj, const char *key, const char *s) { return json_set(obj, key, H(jstr(s))); }
long long json_set_int(long long obj, const char *key, long long n)      { return json_set(obj, key, H(jint(n))); }
long long json_set_float(long long obj, const char *key, double x)       { return json_set(obj, key, H(jflt(x))); }
long long json_set_bool(long long obj, const char *key, long long b)     { return json_set(obj, key, H(jbool(b))); }

long long json_remove(long long obj, const char *key) {
    JVal *o = V(obj); if (!o || o->type != J_OBJ || !key) return 0;
    for (int i = 0; i < o->obj.len; i++)
        if (strcmp(o->obj.keys[i], key) == 0) {
            free(o->obj.keys[i]); jfree(o->obj.vals[i]);
            for (int j = i; j < o->obj.len - 1; j++) {
                o->obj.keys[j] = o->obj.keys[j + 1];
                o->obj.vals[j] = o->obj.vals[j + 1];
            }
            o->obj.len--; return 1;
        }
    return 0;
}

long long json_append(long long arr, long long val) {
    JVal *a = V(arr); if (!a || a->type != J_ARR) return 0;
    arr_push(a, V(val)); return 1;
}
long long json_append_string(long long arr, const char *s) { return json_append(arr, H(jstr(s))); }
long long json_append_int(long long arr, long long n)      { return json_append(arr, H(jint(n))); }
long long json_append_float(long long arr, double x)       { return json_append(arr, H(jflt(x))); }
long long json_append_bool(long long arr, long long b)     { return json_append(arr, H(jbool(b))); }

/* ── cleanup ── */
long long json_free(long long h) { jfree(V(h)); return 0; }
