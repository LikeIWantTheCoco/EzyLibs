/* ═══════════════════════════════════════════════════════════════
   sqlite — SQLite bindings for Ezy (wraps the system libsqlite3).

   Connections (sqlite3*) and statements (sqlite3_stmt*) are exposed as
   opaque integer handles. 0 is the null handle. Typical flow:

       db   = sqlite_open("app.db")
       sqlite_exec(db, "CREATE TABLE t(id INTEGER, name TEXT)")
       st   = sqlite_prepare(db, "INSERT INTO t VALUES(?, ?)")
       sqlite_bind_int(st, 1, 1); sqlite_bind_string(st, 2, "alice")
       sqlite_step(st); sqlite_finalize(st)
       q = sqlite_prepare(db, "SELECT name FROM t")
       while sqlite_step(q): { print(sqlite_column_string(q, 0)) }
       sqlite_finalize(q); sqlite_close(db)

   Build: gcc -shared -fPIC sqlite.c -o libsqlite.so -lsqlite3
   ═══════════════════════════════════════════════════════════════ */
#define _POSIX_C_SOURCE 200809L
#include <sqlite3.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define DB(h)   ((sqlite3*)(intptr_t)(h))
#define ST(h)   ((sqlite3_stmt*)(intptr_t)(h))
#define HND(p)  ((long long)(intptr_t)(p))

/* ── connection ───────────────────────────────────────── */
long long sqlite_open(const char *path) {
    sqlite3 *db = NULL;
    /* a handle is returned even on most failures, so the caller can read
       the error via sqlite_error(); only OOM yields NULL */
    sqlite3_open(path ? path : ":memory:", &db);
    return HND(db);
}
long long sqlite_open_memory(void) {
    sqlite3 *db = NULL;
    sqlite3_open(":memory:", &db);
    return HND(db);
}
long long sqlite_close(long long h) { sqlite3_close(DB(h)); return 0; }

char *sqlite_error(long long h) {
    const char *m = DB(h) ? sqlite3_errmsg(DB(h)) : "no database";
    return strdup(m ? m : "");
}

/* ── direct execution (no result rows) ───────────────── */
long long sqlite_exec(long long h, const char *sql) {
    if (!DB(h) || !sql) return 0;
    char *err = NULL;
    int rc = sqlite3_exec(DB(h), sql, NULL, NULL, &err);
    if (err) sqlite3_free(err);
    return rc == SQLITE_OK ? 1 : 0;
}
long long sqlite_changes(long long h)        { return DB(h) ? sqlite3_changes(DB(h)) : 0; }
long long sqlite_last_insert_id(long long h) { return DB(h) ? (long long)sqlite3_last_insert_rowid(DB(h)) : 0; }

/* ── prepared statements ─────────────────────────────── */
long long sqlite_prepare(long long h, const char *sql) {
    if (!DB(h) || !sql) return 0;
    sqlite3_stmt *st = NULL;
    if (sqlite3_prepare_v2(DB(h), sql, -1, &st, NULL) != SQLITE_OK) return 0;
    return HND(st);
}
/* 1 → a row is ready, 0 → done or error */
long long sqlite_step(long long st)     { return ST(st) && sqlite3_step(ST(st)) == SQLITE_ROW ? 1 : 0; }
long long sqlite_finalize(long long st) { sqlite3_finalize(ST(st)); return 0; }
long long sqlite_reset(long long st)    { return ST(st) && sqlite3_reset(ST(st)) == SQLITE_OK ? 1 : 0; }

/* ── parameter binding (1-indexed) ───────────────────── */
long long sqlite_bind_int(long long st, long long i, long long v) {
    return ST(st) && sqlite3_bind_int64(ST(st), (int)i, v) == SQLITE_OK ? 1 : 0;
}
long long sqlite_bind_float(long long st, long long i, double v) {
    return ST(st) && sqlite3_bind_double(ST(st), (int)i, v) == SQLITE_OK ? 1 : 0;
}
long long sqlite_bind_string(long long st, long long i, const char *v) {
    return ST(st) && sqlite3_bind_text(ST(st), (int)i, v ? v : "", -1, SQLITE_TRANSIENT) == SQLITE_OK ? 1 : 0;
}
long long sqlite_bind_null(long long st, long long i) {
    return ST(st) && sqlite3_bind_null(ST(st), (int)i) == SQLITE_OK ? 1 : 0;
}

/* ── column access (0-indexed) ───────────────────────── */
long long sqlite_column_count(long long st)          { return ST(st) ? sqlite3_column_count(ST(st)) : 0; }
long long sqlite_column_int(long long st, long long c){ return ST(st) ? (long long)sqlite3_column_int64(ST(st), (int)c) : 0; }
double    sqlite_column_float(long long st, long long c){ return ST(st) ? sqlite3_column_double(ST(st), (int)c) : 0.0; }
char *sqlite_column_string(long long st, long long c) {
    if (!ST(st)) return strdup("");
    const unsigned char *t = sqlite3_column_text(ST(st), (int)c);
    return strdup(t ? (const char *)t : "");
}
char *sqlite_column_name(long long st, long long c) {
    if (!ST(st)) return strdup("");
    const char *n = sqlite3_column_name(ST(st), (int)c);
    return strdup(n ? n : "");
}
const char *sqlite_column_type(long long st, long long c) {
    if (!ST(st)) return "null";
    switch (sqlite3_column_type(ST(st), (int)c)) {
        case SQLITE_INTEGER: return "integer";
        case SQLITE_FLOAT:   return "float";
        case SQLITE_TEXT:    return "text";
        case SQLITE_BLOB:    return "blob";
        default:             return "null";
    }
}

/* ── convenience ─────────────────────────────────────── */
/* run a query and return the first column of the first row as an int
   (handy for `SELECT COUNT(*) ...`). Returns 0 if there are no rows. */
long long sqlite_query_int(long long h, const char *sql) {
    if (!DB(h) || !sql) return 0;
    sqlite3_stmt *st = NULL;
    long long r = 0;
    if (sqlite3_prepare_v2(DB(h), sql, -1, &st, NULL) == SQLITE_OK) {
        if (sqlite3_step(st) == SQLITE_ROW) r = (long long)sqlite3_column_int64(st, 0);
        sqlite3_finalize(st);
    }
    return r;
}
/* first column of the first row as text (caller-owned). Empty if no rows. */
char *sqlite_query_string(long long h, const char *sql) {
    if (!DB(h) || !sql) return strdup("");
    sqlite3_stmt *st = NULL;
    char *r = NULL;
    if (sqlite3_prepare_v2(DB(h), sql, -1, &st, NULL) == SQLITE_OK) {
        if (sqlite3_step(st) == SQLITE_ROW) {
            const unsigned char *t = sqlite3_column_text(st, 0);
            r = strdup(t ? (const char *)t : "");
        }
        sqlite3_finalize(st);
    }
    return r ? r : strdup("");
}

const char *sqlite_version(void) { return sqlite3_libversion(); }
