/* ═══════════════════════════════════════════════════════════════
   image-adv — advanced extras for the `image` library.

   This is an EXTENSION lib: its manifest declares `"extends": "image"`,
   so ezyl compiles image.c and image_adv.c together into one .so. That
   lets these functions reuse `image`'s loaders, buffers and savers
   directly, while keeping the base `image` library lean.

     • Comparison — diff two images / detect changes
     • OCR        — extract text (via the tesseract CLI)

   Build (done by ezyl): the `image` sources are pulled in automatically.
   ═══════════════════════════════════════════════════════════════ */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* reused from the `image` module (compiled into the same .so) */
extern long long img_width(long long h);
extern long long img_height(long long h);
extern long long img_new(long long w, long long h, long long r, long long g, long long b, long long a);
extern long long img_save(long long h, const char *path);
extern unsigned char *img_pixels(long long h);

static int absi(int v) { return v < 0 ? -v : v; }
static int maxdiff(const unsigned char *a, const unsigned char *b) {
    int dr = absi(a[0]-b[0]), dg = absi(a[1]-b[1]), db = absi(a[2]-b[2]);
    int m = dr > dg ? dr : dg; return m > db ? m : db;
}
/* same-size check; returns pixel count or -1 */
static long long same_size(long long a, long long b, int *w, int *h) {
    int wa = (int)img_width(a), ha = (int)img_height(a);
    int wb = (int)img_width(b), hb = (int)img_height(b);
    if (wa < 0 || wb < 0 || wa != wb || ha != hb) return -1;
    *w = wa; *h = ha; return (long long)wa * ha;
}

/* ───────────────────────── comparison ───────────────────────── */

/* mean per-channel difference, normalised 0.0 (identical) .. 1.0; -1 on size mismatch */
double imgadv_compare(long long a, long long b) {
    int w, h; long long n = same_size(a, b, &w, &h);
    if (n < 0) return -1;
    const unsigned char *pa = img_pixels(a), *pb = img_pixels(b);
    double sum = 0;
    for (long long i = 0; i < n; i++)
        for (int c = 0; c < 3; c++) sum += absi(pa[i*4+c] - pb[i*4+c]);
    return sum / ((double)n * 3 * 255.0);
}
/* 1 if every pixel is identical, else 0 */
long long imgadv_equal(long long a, long long b) {
    int w, h; long long n = same_size(a, b, &w, &h);
    if (n < 0) return 0;
    return memcmp(img_pixels(a), img_pixels(b), (size_t)n*4) == 0 ? 1 : 0;
}
/* percentage of pixels whose change exceeds `threshold` (0..255) */
double imgadv_changed_pct(long long a, long long b, long long threshold) {
    int w, h; long long n = same_size(a, b, &w, &h);
    if (n < 0) return -1;
    const unsigned char *pa = img_pixels(a), *pb = img_pixels(b);
    long long changed = 0;
    for (long long i = 0; i < n; i++)
        if (maxdiff(pa+i*4, pb+i*4) > (int)threshold) changed++;
    return 100.0 * changed / n;
}
/* visual diff → new image: changed pixels in red over a dimmed grayscale of `a` */
long long imgadv_diff(long long a, long long b) {
    int w, h; long long n = same_size(a, b, &w, &h);
    if (n < 0) return -1;
    long long out = img_new(w, h, 0, 0, 0, 255);
    if (out < 0) return -1;
    const unsigned char *pa = img_pixels(a), *pb = img_pixels(b);
    unsigned char *po = img_pixels(out);
    for (long long i = 0; i < n; i++) {
        int d = maxdiff(pa+i*4, pb+i*4);
        if (d > 25) { po[i*4]=255; po[i*4+1]=40; po[i*4+2]=40; }   /* changed → red */
        else {
            int lum = (int)(0.299*pa[i*4] + 0.587*pa[i*4+1] + 0.114*pa[i*4+2]) * 4 / 10;
            po[i*4]=lum; po[i*4+1]=lum; po[i*4+2]=lum;             /* unchanged → dim gray */
        }
        po[i*4+3]=255;
    }
    return out;
}

/* ───────────────────────── OCR (tesseract CLI) ───────────────────────── */
static char *run_capture(const char *cmd) {
    FILE *p = popen(cmd, "r");
    if (!p) return strdup("");
    size_t cap = 4096, len = 0; char *buf = malloc(cap);
    size_t r;
    char tmp[4096];
    while ((r = fread(tmp, 1, sizeof tmp, p)) > 0) {
        if (len + r + 1 > cap) { while (len + r + 1 > cap) cap *= 2; buf = realloc(buf, cap); }
        memcpy(buf + len, tmp, r); len += r;
    }
    buf[len] = 0;
    pclose(p);
    /* trim a single trailing newline */
    while (len && (buf[len-1]=='\n' || buf[len-1]=='\r')) buf[--len] = 0;
    return buf;
}
/* extract text from an image FILE on disk. lang e.g. "eng", "spa", "eng+spa". */
char *imgadv_ocr_file(const char *path, const char *lang) {
    const char *l = (lang && *lang) ? lang : "eng";
    char cmd[1200];
    snprintf(cmd, sizeof cmd, "tesseract \"%s\" stdout -l %s 2>/dev/null", path, l);
    return run_capture(cmd);
}
/* extract text from a loaded image handle (saved to a temp PNG first) */
char *imgadv_ocr(long long h, const char *lang) {
    if (img_width(h) < 0) return strdup("");
    char tmp[256];
    snprintf(tmp, sizeof tmp, "/tmp/ezy_ocr_%d_%lld.png", (int)getpid(), h);
    if (img_save(h, tmp) != 0) return strdup("");
    char *text = imgadv_ocr_file(tmp, lang);
    unlink(tmp);
    return text;
}
/* is the tesseract OCR engine available on PATH? */
long long imgadv_ocr_available(void) {
    return system("command -v tesseract >/dev/null 2>&1") == 0 ? 1 : 0;
}

char *imgadv_version(void) { return (char *)"image-adv 1.0.0 (compare + tesseract OCR)"; }
