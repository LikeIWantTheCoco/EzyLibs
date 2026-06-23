/* dataframe — a small Pandas-like data-analysis library for Ezy.
 *
 * A DataFrame is an opaque integer handle. Columns hold the original cell
 * text plus a parsed numeric view (NaN when a cell is empty or a column is
 * not fully numeric). Numeric aggregations skip NaN. Transform functions
 * (head/tail/select/filter/sort/groupby) return a NEW handle and never
 * mutate the source. 0 is the invalid/null handle.
 *
 * Crosses the Ezy<->C boundary with only int (long long), float (double)
 * and string (char*), per the EzyLibs C convention.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <ctype.h>

/* ── data model ─────────────────────────────────────────────────── */

typedef struct {
    int     is_numeric;   /* every non-empty cell parses as a number */
    double *nums;         /* nrows; NaN = empty / non-numeric */
    char  **strs;         /* nrows; original text (never NULL entries) */
} Column;

typedef struct {
    long long nrows;
    long long ncols;
    char    **names;      /* ncols */
    Column   *cols;       /* ncols */
} DataFrame;

/* ── handle registry ────────────────────────────────────────────── */

static DataFrame **g_dfs = NULL;
static long long   g_cap = 0;
static long long   g_count = 0;

static long long df_register(DataFrame *d) {
    if (g_count + 1 >= g_cap) {
        long long nc = g_cap ? g_cap * 2 : 16;
        DataFrame **n = realloc(g_dfs, (size_t)nc * sizeof *n);
        if (!n) return 0;
        g_dfs = n; g_cap = nc;
    }
    if (g_count == 0) { g_dfs[0] = NULL; g_count = 1; } /* reserve handle 0 */
    g_dfs[g_count] = d;
    return g_count++;
}

static DataFrame *DF(long long h) {
    if (h <= 0 || h >= g_count) return NULL;
    return g_dfs[h];
}

static long long col_index(DataFrame *d, const char *name) {
    if (!d || !name) return -1;
    for (long long c = 0; c < d->ncols; c++)
        if (strcmp(d->names[c], name) == 0) return c;
    return -1;
}

/* ── small helpers ──────────────────────────────────────────────── */

static char *dup_str(const char *s) {
    if (!s) s = "";
    size_t n = strlen(s);
    char *r = malloc(n + 1);
    if (r) memcpy(r, s, n + 1);
    return r;
}

/* parse a whole token as a double; returns 1 on success */
static int parse_num(const char *s, double *out) {
    if (!s) return 0;
    while (*s == ' ' || *s == '\t') s++;
    if (*s == '\0') return 0;
    char *end = NULL;
    double v = strtod(s, &end);
    if (end == s) return 0;
    while (*end == ' ' || *end == '\t' || *end == '\r' || *end == '\n') end++;
    if (*end != '\0') return 0;
    *out = v;
    return 1;
}

static DataFrame *df_alloc(long long ncols, long long nrows) {
    DataFrame *d = calloc(1, sizeof *d);
    if (!d) return NULL;
    d->ncols = ncols;
    d->nrows = nrows;
    d->names = calloc((size_t)ncols, sizeof(char *));
    d->cols  = calloc((size_t)ncols, sizeof(Column));
    for (long long c = 0; c < ncols; c++) {
        d->cols[c].nums = calloc((size_t)(nrows > 0 ? nrows : 1), sizeof(double));
        d->cols[c].strs = calloc((size_t)(nrows > 0 ? nrows : 1), sizeof(char *));
    }
    return d;
}

/* after strs are filled, infer numeric columns and fill nums */
static void df_finalize_types(DataFrame *d) {
    for (long long c = 0; c < d->ncols; c++) {
        int numeric = 1, any = 0;
        for (long long r = 0; r < d->nrows; r++) {
            const char *s = d->cols[c].strs[r];
            if (!s || s[0] == '\0') { d->cols[c].nums[r] = NAN; continue; }
            double v;
            if (parse_num(s, &v)) { d->cols[c].nums[r] = v; any = 1; }
            else { numeric = 0; d->cols[c].nums[r] = NAN; }
        }
        d->cols[c].is_numeric = (numeric && any);
    }
}

/* ── CSV parsing ────────────────────────────────────────────────── */

/* read one CSV field starting at *p; advances *p past the field and the
   following ',' or end-of-line. Returns a malloc'd string. *eol set to 1
   if the field ended the line. */
static char *csv_field(const char **p, int *eol) {
    const char *s = *p;
    char *buf = malloc(strlen(s) + 1);
    size_t bi = 0;
    *eol = 0;
    if (*s == '"') {            /* quoted field */
        s++;
        while (*s) {
            if (*s == '"' && s[1] == '"') { buf[bi++] = '"'; s += 2; }
            else if (*s == '"') { s++; break; }
            else buf[bi++] = *s++;
        }
        while (*s && *s != ',' && *s != '\n' && *s != '\r') s++;
    } else {
        while (*s && *s != ',' && *s != '\n' && *s != '\r') buf[bi++] = *s++;
    }
    buf[bi] = '\0';
    if (*s == ',') { s++; }
    else { *eol = 1; if (*s == '\r') s++; if (*s == '\n') s++; }
    *p = s;
    return buf;
}

static long long count_fields(const char *line) {
    long long n = 0; int eol = 0;
    const char *p = line;
    if (*p == '\0') return 0;
    do { char *f = csv_field(&p, &eol); free(f); n++; } while (!eol && *p);
    return n;
}

long long df_read_csv(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
    if (sz < 0) { fclose(f); return 0; }
    char *txt = malloc((size_t)sz + 1);
    size_t rd = fread(txt, 1, (size_t)sz, f);
    txt[rd] = '\0';
    fclose(f);

    const char *p = txt;
    /* header */
    while (*p == '\r' || *p == '\n') p++;
    if (*p == '\0') { free(txt); return 0; }
    long long ncols = count_fields(p);
    if (ncols <= 0) { free(txt); return 0; }

    char **names = calloc((size_t)ncols, sizeof(char *));
    int eol = 0;
    for (long long c = 0; c < ncols; c++) names[c] = csv_field(&p, &eol);

    /* count data rows */
    const char *q = p; long long nrows = 0;
    while (*q) {
        const char *ls = q; int e = 0;
        while (*q && !e) { char *fld = csv_field(&q, &e); free(fld); }
        if (q != ls) nrows++;
        if (*ls == '\0') break;
    }

    DataFrame *d = df_alloc(ncols, nrows);
    for (long long c = 0; c < ncols; c++) d->names[c] = names[c];
    free(names);

    /* fill rows */
    long long r = 0;
    while (*p && r < nrows) {
        for (long long c = 0; c < ncols; c++) {
            int e = 0;
            if (*p == '\0' || (c > 0 && e)) { d->cols[c].strs[r] = dup_str(""); continue; }
            char *fld = csv_field(&p, &e);
            d->cols[c].strs[r] = fld;
            if (e) { for (long long k = c + 1; k < ncols; k++) d->cols[k].strs[r] = dup_str(""); break; }
        }
        r++;
    }
    free(txt);
    df_finalize_types(d);
    return df_register(d);
}

long long df_save_csv(long long h, const char *path) {
    DataFrame *d = DF(h);
    if (!d) return 0;
    FILE *f = fopen(path, "wb");
    if (!f) return 0;
    for (long long c = 0; c < d->ncols; c++)
        fprintf(f, "%s%s", c ? "," : "", d->names[c]);
    fputc('\n', f);
    for (long long r = 0; r < d->nrows; r++) {
        for (long long c = 0; c < d->ncols; c++) {
            const char *s = d->cols[c].strs[r];
            int needq = strchr(s, ',') || strchr(s, '"') || strchr(s, '\n');
            if (c) fputc(',', f);
            if (needq) { fputc('"', f); for (const char *x = s; *x; x++) { if (*x == '"') fputc('"', f); fputc(*x, f); } fputc('"', f); }
            else fputs(s, f);
        }
        fputc('\n', f);
    }
    fclose(f);
    return 1;
}

long long df_free(long long h) {
    DataFrame *d = DF(h);
    if (!d) return 0;
    for (long long c = 0; c < d->ncols; c++) {
        for (long long r = 0; r < d->nrows; r++) free(d->cols[c].strs[r]);
        free(d->cols[c].strs); free(d->cols[c].nums); free(d->names[c]);
    }
    free(d->names); free(d->cols); free(d);
    g_dfs[h] = NULL;
    return 1;
}

/* ── shape / metadata ───────────────────────────────────────────── */

long long df_rows(long long h)        { DataFrame *d = DF(h); return d ? d->nrows : 0; }
long long df_cols(long long h)        { DataFrame *d = DF(h); return d ? d->ncols : 0; }
long long df_has_col(long long h, const char *name) { return col_index(DF(h), name) >= 0; }
long long df_col_index(long long h, const char *name) { return col_index(DF(h), name); }
long long df_is_numeric(long long h, const char *col) {
    DataFrame *d = DF(h); long long c = col_index(d, col);
    return (c >= 0 && d->cols[c].is_numeric) ? 1 : 0;
}

char *df_col_name(long long h, long long i) {
    DataFrame *d = DF(h);
    if (!d || i < 0 || i >= d->ncols) return dup_str("");
    return dup_str(d->names[i]);
}

/* ── cell access ────────────────────────────────────────────────── */

double df_get_float(long long h, long long row, const char *col) {
    DataFrame *d = DF(h); long long c = col_index(d, col);
    if (c < 0 || row < 0 || row >= d->nrows) return NAN;
    return d->cols[c].nums[row];
}
long long df_get_int(long long h, long long row, const char *col) {
    double v = df_get_float(h, row, col);
    return isnan(v) ? 0 : (long long)v;
}
char *df_get_str(long long h, long long row, const char *col) {
    DataFrame *d = DF(h); long long c = col_index(d, col);
    if (c < 0 || row < 0 || row >= d->nrows) return dup_str("");
    return dup_str(d->cols[c].strs[row]);
}

/* ── aggregations (numeric column, NaN skipped) ─────────────────── */

static double *col_nums(DataFrame *d, const char *col, long long *n_out) {
    long long c = col_index(d, col);
    if (c < 0) { *n_out = -1; return NULL; }
    *n_out = d->nrows;
    return d->cols[c].nums;
}

long long df_count(long long h, const char *col) {
    DataFrame *d = DF(h); long long n; double *v = col_nums(d, col, &n);
    if (!v) return 0;
    long long k = 0;
    for (long long i = 0; i < n; i++) if (!isnan(v[i])) k++;
    return k;
}
double df_sum(long long h, const char *col) {
    DataFrame *d = DF(h); long long n; double *v = col_nums(d, col, &n);
    if (!v) return NAN;
    double s = 0; for (long long i = 0; i < n; i++) if (!isnan(v[i])) s += v[i];
    return s;
}
double df_mean(long long h, const char *col) {
    long long k = df_count(h, col);
    return k ? df_sum(h, col) / (double)k : NAN;
}
double df_min(long long h, const char *col) {
    DataFrame *d = DF(h); long long n; double *v = col_nums(d, col, &n);
    if (!v) return NAN;
    double m = NAN; for (long long i = 0; i < n; i++) if (!isnan(v[i])) { if (isnan(m) || v[i] < m) m = v[i]; }
    return m;
}
double df_max(long long h, const char *col) {
    DataFrame *d = DF(h); long long n; double *v = col_nums(d, col, &n);
    if (!v) return NAN;
    double m = NAN; for (long long i = 0; i < n; i++) if (!isnan(v[i])) { if (isnan(m) || v[i] > m) m = v[i]; }
    return m;
}
double df_std(long long h, const char *col) {       /* sample std (n-1) */
    long long k = df_count(h, col);
    if (k < 2) return NAN;
    double mu = df_mean(h, col);
    DataFrame *d = DF(h); long long n; double *v = col_nums(d, col, &n);
    double s = 0; for (long long i = 0; i < n; i++) if (!isnan(v[i])) { double e = v[i] - mu; s += e * e; }
    return sqrt(s / (double)(k - 1));
}
double df_var(long long h, const char *col) {
    double s = df_std(h, col); return isnan(s) ? NAN : s * s;
}

static int cmp_double(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return (x > y) - (x < y);
}
double df_median(long long h, const char *col) {
    DataFrame *d = DF(h); long long n; double *v = col_nums(d, col, &n);
    if (!v) return NAN;
    double *tmp = malloc((size_t)(n > 0 ? n : 1) * sizeof(double));
    long long k = 0;
    for (long long i = 0; i < n; i++) if (!isnan(v[i])) tmp[k++] = v[i];
    if (k == 0) { free(tmp); return NAN; }
    qsort(tmp, (size_t)k, sizeof(double), cmp_double);
    double med = (k % 2) ? tmp[k / 2] : (tmp[k / 2 - 1] + tmp[k / 2]) / 2.0;
    free(tmp);
    return med;
}
long long df_nunique(long long h, const char *col) {
    DataFrame *d = DF(h); long long c = col_index(d, col);
    if (c < 0) return 0;
    long long u = 0;
    for (long long i = 0; i < d->nrows; i++) {
        int seen = 0;
        for (long long j = 0; j < i; j++)
            if (strcmp(d->cols[c].strs[i], d->cols[c].strs[j]) == 0) { seen = 1; break; }
        if (!seen) u++;
    }
    return u;
}

/* ── row-copy helper for transforms ─────────────────────────────── */

static DataFrame *df_copy_rows(DataFrame *src, const long long *rows, long long nrows) {
    DataFrame *d = df_alloc(src->ncols, nrows);
    for (long long c = 0; c < src->ncols; c++) d->names[c] = dup_str(src->names[c]);
    for (long long r = 0; r < nrows; r++) {
        long long sr = rows[r];
        for (long long c = 0; c < src->ncols; c++)
            d->cols[c].strs[r] = dup_str(src->cols[c].strs[sr]);
    }
    df_finalize_types(d);
    return d;
}

long long df_head(long long h, long long n) {
    DataFrame *d = DF(h); if (!d) return 0;
    if (n > d->nrows) n = d->nrows;
    if (n < 0) n = 0;
    long long *idx = malloc((size_t)(n > 0 ? n : 1) * sizeof(long long));
    for (long long i = 0; i < n; i++) idx[i] = i;
    DataFrame *r = df_copy_rows(d, idx, n); free(idx);
    return df_register(r);
}
long long df_tail(long long h, long long n) {
    DataFrame *d = DF(h); if (!d) return 0;
    if (n > d->nrows) n = d->nrows;
    if (n < 0) n = 0;
    long long *idx = malloc((size_t)(n > 0 ? n : 1) * sizeof(long long));
    for (long long i = 0; i < n; i++) idx[i] = d->nrows - n + i;
    DataFrame *r = df_copy_rows(d, idx, n); free(idx);
    return df_register(r);
}

/* select a subset of columns by comma-separated names */
long long df_select(long long h, const char *cols_csv) {
    DataFrame *d = DF(h); if (!d) return 0;
    char *spec = dup_str(cols_csv);
    long long want = 1;
    for (char *p = spec; *p; p++) if (*p == ',') want++;
    long long *ci = malloc((size_t)want * sizeof(long long));
    long long m = 0;
    char *tok = strtok(spec, ",");
    while (tok) {
        while (*tok == ' ') tok++;
        long long c = col_index(d, tok);
        if (c >= 0) ci[m++] = c;
        tok = strtok(NULL, ",");
    }
    free(spec);
    DataFrame *r = df_alloc(m, d->nrows);
    for (long long c = 0; c < m; c++) r->names[c] = dup_str(d->names[ci[c]]);
    for (long long row = 0; row < d->nrows; row++)
        for (long long c = 0; c < m; c++)
            r->cols[c].strs[row] = dup_str(d->cols[ci[c]].strs[row]);
    free(ci);
    df_finalize_types(r);
    return df_register(r);
}

/* ── filtering ──────────────────────────────────────────────────── */

typedef enum { F_GT, F_GE, F_LT, F_LE, F_EQ, F_NE } FOp;

static long long df_filter_num(DataFrame *d, const char *col, double val, FOp op) {
    long long c = col_index(d, col);
    if (c < 0) return 0;
    long long *idx = malloc((size_t)(d->nrows > 0 ? d->nrows : 1) * sizeof(long long));
    long long m = 0;
    for (long long r = 0; r < d->nrows; r++) {
        double v = d->cols[c].nums[r];
        if (isnan(v)) continue;
        int keep = 0;
        switch (op) {
            case F_GT: keep = v >  val; break;
            case F_GE: keep = v >= val; break;
            case F_LT: keep = v <  val; break;
            case F_LE: keep = v <= val; break;
            case F_EQ: keep = v == val; break;
            case F_NE: keep = v != val; break;
        }
        if (keep) idx[m++] = r;
    }
    DataFrame *r = df_copy_rows(d, idx, m); free(idx);
    return df_register(r);
}

long long df_filter_gt(long long h, const char *col, double v) { return df_filter_num(DF(h), col, v, F_GT); }
long long df_filter_ge(long long h, const char *col, double v) { return df_filter_num(DF(h), col, v, F_GE); }
long long df_filter_lt(long long h, const char *col, double v) { return df_filter_num(DF(h), col, v, F_LT); }
long long df_filter_le(long long h, const char *col, double v) { return df_filter_num(DF(h), col, v, F_LE); }
long long df_filter_eq(long long h, const char *col, double v) { return df_filter_num(DF(h), col, v, F_EQ); }
long long df_filter_ne(long long h, const char *col, double v) { return df_filter_num(DF(h), col, v, F_NE); }

long long df_filter_str(long long h, const char *col, const char *val) {
    DataFrame *d = DF(h); long long c = col_index(d, col);
    if (c < 0) return 0;
    long long *idx = malloc((size_t)(d->nrows > 0 ? d->nrows : 1) * sizeof(long long));
    long long m = 0;
    for (long long r = 0; r < d->nrows; r++)
        if (strcmp(d->cols[c].strs[r], val) == 0) idx[m++] = r;
    DataFrame *r = df_copy_rows(d, idx, m); free(idx);
    return df_register(r);
}

/* ── sorting ────────────────────────────────────────────────────── */

static DataFrame  *g_sort_df;
static long long   g_sort_col;
static int         g_sort_asc;
static int         g_sort_numeric;

static int cmp_rows(const void *a, const void *b) {
    long long ra = *(const long long *)a, rb = *(const long long *)b;
    int r;
    if (g_sort_numeric) {
        double x = g_sort_df->cols[g_sort_col].nums[ra];
        double y = g_sort_df->cols[g_sort_col].nums[rb];
        if (isnan(x) && isnan(y)) r = 0;
        else if (isnan(x)) r = 1;
        else if (isnan(y)) r = -1;
        else r = (x > y) - (x < y);
    } else {
        r = strcmp(g_sort_df->cols[g_sort_col].strs[ra],
                   g_sort_df->cols[g_sort_col].strs[rb]);
    }
    return g_sort_asc ? r : -r;
}

long long df_sort(long long h, const char *col, long long ascending) {
    DataFrame *d = DF(h); long long c = col_index(d, col);
    if (c < 0) return 0;
    long long *idx = malloc((size_t)(d->nrows > 0 ? d->nrows : 1) * sizeof(long long));
    for (long long r = 0; r < d->nrows; r++) idx[r] = r;
    g_sort_df = d; g_sort_col = c; g_sort_asc = ascending ? 1 : 0;
    g_sort_numeric = d->cols[c].is_numeric;
    qsort(idx, (size_t)d->nrows, sizeof(long long), cmp_rows);
    DataFrame *r = df_copy_rows(d, idx, d->nrows); free(idx);
    return df_register(r);
}

/* ── group-by (group_col -> aggregate of value_col) ─────────────── */

typedef enum { G_MEAN, G_SUM, G_COUNT, G_MIN, G_MAX } GAgg;

static long long df_group(DataFrame *d, const char *group_col,
                          const char *value_col, GAgg agg) {
    long long gc = col_index(d, group_col);
    if (gc < 0) return 0;
    long long vc = (agg == G_COUNT) ? -1 : col_index(d, value_col);
    if (agg != G_COUNT && vc < 0) return 0;

    /* distinct group keys, first-seen order */
    char **keys = malloc((size_t)(d->nrows > 0 ? d->nrows : 1) * sizeof(char *));
    long long nk = 0;
    for (long long r = 0; r < d->nrows; r++) {
        const char *k = d->cols[gc].strs[r];
        int seen = 0;
        for (long long j = 0; j < nk; j++) if (strcmp(keys[j], k) == 0) { seen = 1; break; }
        if (!seen) keys[nk++] = (char *)k;
    }

    DataFrame *out = df_alloc(2, nk);
    out->names[0] = dup_str(group_col);
    const char *aggname = agg == G_MEAN ? "mean" : agg == G_SUM ? "sum" :
                          agg == G_COUNT ? "count" : agg == G_MIN ? "min" : "max";
    out->names[1] = dup_str(aggname);

    char buf[64];
    for (long long g = 0; g < nk; g++) {
        double acc = NAN; long long cnt = 0;
        for (long long r = 0; r < d->nrows; r++) {
            if (strcmp(d->cols[gc].strs[r], keys[g]) != 0) continue;
            if (agg == G_COUNT) { cnt++; continue; }
            double v = d->cols[vc].nums[r];
            if (isnan(v)) continue;
            cnt++;
            switch (agg) {
                case G_SUM:  acc = isnan(acc) ? v : acc + v; break;
                case G_MEAN: acc = isnan(acc) ? v : acc + v; break;
                case G_MIN:  acc = (isnan(acc) || v < acc) ? v : acc; break;
                case G_MAX:  acc = (isnan(acc) || v > acc) ? v : acc; break;
                default: break;
            }
        }
        if (agg == G_MEAN && cnt) acc /= (double)cnt;
        out->cols[0].strs[g] = dup_str(keys[g]);
        if (agg == G_COUNT) snprintf(buf, sizeof buf, "%lld", cnt);
        else if (cnt == 0)  buf[0] = '\0';
        else if (acc == (long long)acc) snprintf(buf, sizeof buf, "%lld", (long long)acc);
        else snprintf(buf, sizeof buf, "%.6g", acc);
        out->cols[1].strs[g] = dup_str(buf);
    }
    free(keys);
    df_finalize_types(out);
    return df_register(out);
}

long long df_groupby_mean(long long h, const char *g, const char *v)  { return df_group(DF(h), g, v, G_MEAN); }
long long df_groupby_sum(long long h, const char *g, const char *v)   { return df_group(DF(h), g, v, G_SUM); }
long long df_groupby_min(long long h, const char *g, const char *v)   { return df_group(DF(h), g, v, G_MIN); }
long long df_groupby_max(long long h, const char *g, const char *v)   { return df_group(DF(h), g, v, G_MAX); }
long long df_groupby_count(long long h, const char *g)                { return df_group(DF(h), g, NULL, G_COUNT); }

/* ── rendering ──────────────────────────────────────────────────── */

static char *df_render(DataFrame *d, long long max_rows) {
    if (!d) return dup_str("");
    long long show = (max_rows < 0 || max_rows > d->nrows) ? d->nrows : max_rows;

    /* column widths */
    long long *w = calloc((size_t)d->ncols, sizeof(long long));
    for (long long c = 0; c < d->ncols; c++) {
        w[c] = (long long)strlen(d->names[c]);
        for (long long r = 0; r < show; r++) {
            long long L = (long long)strlen(d->cols[c].strs[r]);
            if (L > w[c]) w[c] = L;
        }
    }
    size_t cap = 256;
    for (long long c = 0; c < d->ncols; c++) cap += (size_t)(w[c] + 3) * (size_t)(show + 2);
    char *out = malloc(cap); size_t o = 0;
    #define PUT(...) do { o += (size_t)snprintf(out + o, cap - o, __VA_ARGS__); } while (0)

    for (long long c = 0; c < d->ncols; c++)
        PUT("%s%-*s", c ? "  " : "", (int)w[c], d->names[c]);
    PUT("\n");
    for (long long c = 0; c < d->ncols; c++) {
        if (c) PUT("  ");
        for (long long i = 0; i < w[c]; i++) PUT("-");
    }
    PUT("\n");
    for (long long r = 0; r < show; r++) {
        for (long long c = 0; c < d->ncols; c++)
            PUT("%s%-*s", c ? "  " : "", (int)w[c], d->cols[c].strs[r]);
        PUT("\n");
    }
    if (show < d->nrows) PUT("... (%lld rows total)\n", d->nrows);
    free(w);
    #undef PUT
    return out;
}

char *df_to_string(long long h) { return df_render(DF(h), -1); }

long long df_print(long long h) {
    char *s = df_render(DF(h), 20);
    fputs(s, stdout);
    free(s);
    return 1;
}

char *df_describe(long long h) {
    DataFrame *d = DF(h);
    if (!d) return dup_str("");
    size_t cap = 128 + (size_t)d->ncols * 160;
    char *out = malloc(cap); size_t o = 0;
    #define PUT(...) do { o += (size_t)snprintf(out + o, cap - o, __VA_ARGS__); } while (0)
    PUT("%-16s %8s %10s %10s %10s %10s\n", "column", "count", "mean", "std", "min", "max");
    for (long long c = 0; c < d->ncols; c++) {
        if (!d->cols[c].is_numeric) continue;
        const char *nm = d->names[c];
        PUT("%-16s %8lld %10.4g %10.4g %10.4g %10.4g\n",
            nm, df_count(h, nm), df_mean(h, nm), df_std(h, nm),
            df_min(h, nm), df_max(h, nm));
    }
    #undef PUT
    return out;
}
