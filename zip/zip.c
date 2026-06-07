/* ═══════════════════════════════════════════════════════════════
   zip — read and write .zip archives for Ezy (wraps libzip).

   Archives are opaque integer handles. Build one with zip_create, add
   files/text, then zip_save (writes + closes). Read with zip_load,
   zip_count/zip_name/zip_read/zip_extract.

   The libzip symbols are declared inline (no -dev header needed); the
   Ezy-facing functions use distinct names to avoid clashing with them.

   Build: gcc -shared -fPIC zip.c -o libzip_ezy.so -l:libzip.so.4
   ═══════════════════════════════════════════════════════════════ */
#define _POSIX_C_SOURCE 200809L
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>

/* ── minimal libzip declarations ── */
typedef struct zip        zip_t;
typedef struct zip_source zip_source_t;
typedef struct zip_file   zip_file_t;
extern zip_t        *zip_open(const char *, int, int *);
extern int           zip_close(zip_t *);
extern void          zip_discard(zip_t *);
extern int64_t       zip_file_add(zip_t *, const char *, zip_source_t *, uint32_t);
extern zip_source_t *zip_source_buffer(zip_t *, const void *, uint64_t, int);
extern zip_source_t *zip_source_file(zip_t *, const char *, uint64_t, int64_t);
extern void          zip_source_free(zip_source_t *);
extern int64_t       zip_get_num_entries(zip_t *, uint32_t);
extern const char   *zip_get_name(zip_t *, uint64_t, uint32_t);
extern int64_t       zip_name_locate(zip_t *, const char *, uint32_t);
extern zip_file_t   *zip_fopen(zip_t *, const char *, uint32_t);
extern int64_t       zip_fread(zip_file_t *, void *, uint64_t);
extern int           zip_fclose(zip_file_t *);

#define ZIP_CREATE        1
#define ZIP_TRUNCATE      8
#define ZIP_RDONLY        16
#define ZIP_FL_OVERWRITE  8192

#define HND(p) ((long long)(intptr_t)(p))
#define Z(h)   ((zip_t *)(intptr_t)(h))

/* ── open / create / save ── */
long long zip_create(const char *path) {
    if (!path) return 0;
    int err = 0;
    zip_t *z = zip_open(path, ZIP_CREATE | ZIP_TRUNCATE, &err);
    return HND(z);
}
long long zip_load(const char *path) {
    if (!path) return 0;
    int err = 0;
    zip_t *z = zip_open(path, 0, &err);
    return HND(z);
}
/* commit changes and close (1 on success) */
long long zip_save(long long h) {
    if (!Z(h)) return 0;
    return zip_close(Z(h)) == 0 ? 1 : 0;
}
/* close without writing pending changes */
long long zip_discard_changes(long long h) {
    if (Z(h)) zip_discard(Z(h));
    return 0;
}

/* ── add entries ── */
long long zip_add_text(long long h, const char *name, const char *text) {
    if (!Z(h) || !name) return 0;
    if (!text) text = "";
    char *copy = strdup(text);
    zip_source_t *s = zip_source_buffer(Z(h), copy, strlen(copy), 1);
    if (!s) { free(copy); return 0; }
    if (zip_file_add(Z(h), name, s, ZIP_FL_OVERWRITE) < 0) { zip_source_free(s); return 0; }
    return 1;
}
long long zip_add_file(long long h, const char *name, const char *srcpath) {
    if (!Z(h) || !name || !srcpath) return 0;
    zip_source_t *s = zip_source_file(Z(h), srcpath, 0, -1);
    if (!s) return 0;
    if (zip_file_add(Z(h), name, s, ZIP_FL_OVERWRITE) < 0) { zip_source_free(s); return 0; }
    return 1;
}

/* ── inspect ── */
long long zip_count(long long h) {
    return Z(h) ? (long long)zip_get_num_entries(Z(h), 0) : 0;
}
char *zip_name(long long h, long long i) {
    if (!Z(h)) return strdup("");
    const char *n = zip_get_name(Z(h), (uint64_t)i, 0);
    return strdup(n ? n : "");
}
long long zip_has(long long h, const char *name) {
    if (!Z(h) || !name) return 0;
    return zip_name_locate(Z(h), name, 0) >= 0 ? 1 : 0;
}

/* ── read an entry's contents as text ── */
char *zip_read(long long h, const char *name) {
    if (!Z(h) || !name) return strdup("");
    zip_file_t *f = zip_fopen(Z(h), name, 0);
    if (!f) return strdup("");
    size_t cap = 8192, len = 0;
    char *buf = malloc(cap);
    int64_t n;
    char tmp[8192];
    while ((n = zip_fread(f, tmp, sizeof tmp)) > 0) {
        if (len + (size_t)n + 1 > cap) { cap = (len + n) * 2 + 1; buf = realloc(buf, cap); }
        memcpy(buf + len, tmp, (size_t)n);
        len += (size_t)n;
    }
    zip_fclose(f);
    buf[len] = '\0';
    return buf;
}

/* extract one entry to a file on disk (1 on success) */
long long zip_extract(long long h, const char *name, const char *destpath) {
    if (!Z(h) || !name || !destpath) return 0;
    zip_file_t *f = zip_fopen(Z(h), name, 0);
    if (!f) return 0;
    FILE *out = fopen(destpath, "wb");
    if (!out) { zip_fclose(f); return 0; }
    char tmp[65536]; int64_t n;
    while ((n = zip_fread(f, tmp, sizeof tmp)) > 0) fwrite(tmp, 1, (size_t)n, out);
    fclose(out); zip_fclose(f);
    return 1;
}

const char *zip_version(void) { return "libzip (ezy zip 1.0.0)"; }
