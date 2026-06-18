/* ═══════════════════════════════════════════════════════════════
   cli — reactive terminal UI for Ezy.

   CLI variables are named string values anchored to a position on the
   screen. cli_print(name) draws a variable where the cursor is and
   remembers that spot; afterwards, cli_set(name, value) redraws it in
   place — no reprint, no flicker, no manual coordinate bookkeeping.

       cli_set("Greeting", "Hola")      # not shown yet
       cli_print("Greeting")            # shows "Hola"
       cli_set("Greeting", "Adios")     # the on-screen "Hola" becomes "Adios"

   Position is discovered with an ANSI cursor-position query (DSR), so it
   works on a real terminal; when stdout/stdin is not a TTY it degrades
   to plain printing.

   Build: gcc -shared -fPIC cli.c -o libcli.so
   ═══════════════════════════════════════════════════════════════ */
#define _POSIX_C_SOURCE 200809L
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>
#include <termios.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <signal.h>

#define MAX_VARS 256
#define MAX_OPTS 64

/* malloc that never returns NULL — a CLI UI lib has no sane recovery from
   OOM, so we report and exit instead of risking a NULL deref everywhere. */
static void *xmalloc(size_t n) {
    void *p = malloc(n);
    if (!p) { fputs("cli: out of memory\n", stderr); exit(1); }
    return p;
}

typedef struct {
    char *name;
    char *value;        /* current rendered text (may contain '\n') */
    int   used;
    int   shown;        /* has been cli_print'd */
    int   positioned;   /* 1 if we know its real (row,col) — DSR succeeded */
    int   hidden;       /* currently hidden (blanked) */
    int   row, col;     /* top-left anchor (1-based) */
    int   lines;        /* line count of the last drawn value (for clearing) */
    /* picker */
    int   is_picker;
    char *opts[MAX_OPTS];
    int   nopts, sel, vertical;
} CliVar;

static CliVar g_vars[MAX_VARS];
static int    g_tty = -1;   /* lazily: 1 if interactive */

static int is_tty(void) {
    if (g_tty < 0) g_tty = (isatty(STDOUT_FILENO) && isatty(STDIN_FILENO)) ? 1 : 0;
    return g_tty;
}

/* ── shared TTY state: raw mode + cursor visibility ──
   Every raw-mode entry and cursor-hide is tracked so a SIGINT/SIGTERM (or
   normal exit) restores the terminal — no more leaving the shell in raw mode
   with the cursor hidden after Ctrl-C inside a menu. */
static struct termios g_saved_tio;
static int            g_raw = 0;          /* raw mode currently active */
static int            g_cur_hidden = 0;   /* cursor currently hidden */

static void tty_show_cursor(void) {
    if (g_cur_hidden) { fputs("\033[?25h", stdout); fflush(stdout); g_cur_hidden = 0; }
}
static void tty_hide_cursor(void) {
    if (is_tty() && !g_cur_hidden) { fputs("\033[?25l", stdout); fflush(stdout); g_cur_hidden = 1; }
}

/* enter raw mode; returns 1 if THIS call switched it on (caller should leave),
   0 if already raw or not a TTY. Sets VMIN=1/VTIME=0 for blocking 1-byte reads. */
static int tty_raw_enter(void) {
    if (!is_tty() || g_raw) return 0;
    if (tcgetattr(STDIN_FILENO, &g_saved_tio) != 0) return 0;
    struct termios raw = g_saved_tio;
    raw.c_lflag &= ~(unsigned)(ICANON | ECHO);
    raw.c_cc[VMIN]  = 1;
    raw.c_cc[VTIME] = 0;
    tcsetattr(STDIN_FILENO, TCSANOW, &raw);
    g_raw = 1;
    return 1;
}
static void tty_raw_leave(void) {
    if (g_raw) { tcsetattr(STDIN_FILENO, TCSANOW, &g_saved_tio); g_raw = 0; }
}
static void tty_cleanup(void) { tty_raw_leave(); tty_show_cursor(); }

static void on_signal(int sig) {
    tty_cleanup();
    signal(sig, SIG_DFL);
    raise(sig);                 /* re-raise so the process dies as expected */
}
/* install once: restore the terminal on exit and on Ctrl-C / kill */
static void ensure_handlers(void) {
    static int done = 0;
    if (done) return;
    done = 1;
    atexit(tty_cleanup);
    signal(SIGINT,  on_signal);
    signal(SIGTERM, on_signal);
}

static CliVar *find(const char *name) {
    if (!name) return NULL;
    for (int i = 0; i < MAX_VARS; i++)
        if (g_vars[i].used && strcmp(g_vars[i].name, name) == 0) return &g_vars[i];
    return NULL;
}
static CliVar *get_or_new(const char *name) {
    if (!name) return NULL;
    CliVar *v = find(name);
    if (v) return v;
    for (int i = 0; i < MAX_VARS; i++)
        if (!g_vars[i].used) {
            g_vars[i].used = 1;
            g_vars[i].name = strdup(name);
            g_vars[i].value = strdup("");
            return &g_vars[i];
        }
    return NULL;
}

/* ── cursor position query (DSR) ── */
static int query_cursor(int *row, int *col) {
    if (!is_tty()) return 0;
    ensure_handlers();
    int entered = tty_raw_enter();            /* leave only if we switched it on */
    if (write(STDOUT_FILENO, "\033[6n", 4) != 4) { if (entered) tty_raw_leave(); return 0; }
    char buf[32]; int i = 0;
    struct pollfd pfd = { STDIN_FILENO, POLLIN, 0 };
    while (i < 31) {
        if (poll(&pfd, 1, 120) <= 0) break;       /* timeout → give up */
        char c; if (read(STDIN_FILENO, &c, 1) != 1) break;
        buf[i++] = c;
        if (c == 'R') break;
    }
    buf[i] = '\0';
    if (entered) tty_raw_leave();
    return sscanf(buf, "\033[%d;%dR", row, col) == 2;
}

/* count lines + clamp helper */
static int count_lines(const char *s) {
    int n = 1; for (const char *p = s; *p; p++) if (*p == '\n') n++;
    return n;
}

/* draw `val` at (row,col), clearing up to old_lines previous rows.
   returns the new line count. */
static int draw_at(int row, int col, const char *val, int old_lines) {
    fputs("\033[s", stdout);                  /* save cursor */
    int line = 0; const char *p = val;
    for (;;) {
        const char *nl = strchr(p, '\n');
        int len = nl ? (int)(nl - p) : (int)strlen(p);
        printf("\033[%d;%dH\033[K%.*s", row + line, col, len, p);
        line++;
        if (!nl) break;
        p = nl + 1;
    }
    if (line < old_lines) {
        /* delete surplus lines physically so they don't leave blank gaps */
        printf("\033[%d;1H\033[%dM", row + line, old_lines - line);
    }
    fputs("\033[u", stdout);                   /* restore cursor */
    if (line < old_lines)
        printf("\033[%dA", old_lines - line);  /* move up to match new size */
    fflush(stdout);
    return line;
}

/* blank the region with spaces (keeps layout) */
static void blank_at(int row, int col, const char *val) {
    fputs("\033[s", stdout);
    int line = 0; const char *p = val;
    for (;;) {
        const char *nl = strchr(p, '\n');
        int len = nl ? (int)(nl - p) : (int)strlen(p);
        printf("\033[%d;%dH", row + line, col);
        for (int k = 0; k < len; k++) fputc(' ', stdout);
        line++;
        if (!nl) break;
        p = nl + 1;
    }
    fputs("\033[u", stdout);
    fflush(stdout);
}

/* ═══════════════════════════════════════════════════════════════
   Core API
   ═══════════════════════════════════════════════════════════════ */

/* declare a CLI variable with an initial value and return its name
   (use it as a handle):
       Example = cli_var("Example", "Hola")
       cli_print(Example)
       cli_set(Example, "Adios")                                           */
char *cli_var(const char *name, const char *value) {
    if (!name) return strdup("");
    CliVar *v = get_or_new(name);
    if (v && value) { free(v->value); v->value = strdup(value); v->lines = count_lines(v->value); }
    return strdup(name);
}

/* set / update a CLI variable; redraws in place if already shown */
long long cli_set(const char *name, const char *value) {
    CliVar *v = get_or_new(name);
    if (!v) return 0;
    int old_lines = v->lines;
    free(v->value);
    v->value = strdup(value ? value : "");
    /* redraw in place only when we actually know where it is (DSR worked) */
    if (v->shown && v->positioned && !v->hidden) {
        v->lines = draw_at(v->row, v->col, v->value, old_lines);
    } else {
        v->lines = count_lines(v->value);
    }
    return 1;
}
char *cli_get(const char *name) {
    CliVar *v = find(name);
    return strdup(v ? v->value : "");
}

/* print plain, non-reactive text (with newline) at the cursor — use this
   for static lines/spacing, not cli_print which expects a variable name */
long long cli_text(const char *text) {
    printf("%s\n", text ? text : "");
    fflush(stdout);
    return 0;
}
/* a blank line */
long long cli_newline(void) {
    fputc('\n', stdout);
    fflush(stdout);
    return 0;
}

/* render a variable where the cursor is; remembers the spot.
   The value is printed with a trailing newline so the cursor advances
   naturally (scrolling the screen if we are on the last row); the anchor
   is then computed from the post-print position, so later updates land on
   the right line and the shell prompt ends up *below* the widget. */
long long cli_print(const char *name) {
    CliVar *v = get_or_new(name);
    if (!v) return 0;
    v->shown = 1; v->hidden = 0;
    v->lines = count_lines(v->value);
    if (is_tty()) {
        int sr, sc;
        int ok_start = query_cursor(&sr, &sc);
        printf("%s\n", v->value);                 /* natural flow → scrolls if needed */
        fflush(stdout);
        int er, ec;
        if (ok_start && query_cursor(&er, &ec)) {
            v->positioned = 1;
            v->row = er - v->lines;                /* top row of the widget */
            v->col = sc;
        } else {
            v->positioned = 0;
        }
    } else {
        v->positioned = 0;
        printf("%s\n", v->value);
        fflush(stdout);
    }
    return 1;
}

/* like cli_print but NO trailing newline — cursor stays at end of value.
   use this to place multiple variables on the same line; follow with
   cli_newline() to end the line after the last inline variable.
   note: if a variable's visual width changes after cli_set, adjacent
         variables on the same line may shift — use cli_ljust/rjust to
         keep widths stable. */
long long cli_print_inline(const char *name) {
    CliVar *v = get_or_new(name);
    if (!v) return 0;
    v->shown = 1; v->hidden = 0;
    v->lines = 1;
    if (is_tty()) {
        int sr, sc;
        /* query BEFORE print so we capture this variable's start column */
        if (query_cursor(&sr, &sc)) {
            v->positioned = 1;
            v->row = sr;
            v->col = sc;
        } else {
            v->positioned = 0;
        }
        printf("%s", v->value);
        fflush(stdout);
    } else {
        v->positioned = 0;
        printf("%s", v->value);
        fflush(stdout);
    }
    return 1;
}

/* hide: blank the region with spaces (layout preserved) */
long long cli_hide(const char *name) {
    CliVar *v = find(name);
    if (!v || !v->shown || v->hidden) return 0;
    if (is_tty() && v->positioned) blank_at(v->row, v->col, v->value);
    v->hidden = 1;
    return 1;
}
/* show again after hide */
long long cli_show(const char *name) {
    CliVar *v = find(name);
    if (!v || !v->shown || !v->hidden) return 0;
    if (is_tty() && v->positioned) v->lines = draw_at(v->row, v->col, v->value, v->lines);
    v->hidden = 0;
    return 1;
}

/* replace what `name` shows with `other`'s value (in name's region) */
long long cli_replace(const char *name, const char *other) {
    CliVar *v = find(name); CliVar *o = find(other);
    if (!v || !o) return 0;
    return cli_set(name, o->value);
}

/* forget a variable and clear its region */
long long cli_remove(const char *name) {
    CliVar *v = find(name);
    if (!v) return 0;
    if (v->shown && v->positioned && is_tty()) blank_at(v->row, v->col, v->value);
    free(v->name); free(v->value);
    for (int i = 0; i < v->nopts; i++) free(v->opts[i]);
    memset(v, 0, sizeof *v);
    return 1;
}

/* ═══════════════════════════════════════════════════════════════
   Screen / cursor control
   ═══════════════════════════════════════════════════════════════ */
long long cli_clear(void)       { if (is_tty()) { fputs("\033[2J\033[H", stdout); fflush(stdout);} return 0; }
long long cli_cursor_hide(void) { ensure_handlers(); tty_hide_cursor(); return 0; }
long long cli_cursor_show(void) { tty_show_cursor(); return 0; }
/* clear from cursor to end of line (and return to column 1) */
long long cli_clear_line(void) { if (is_tty()) { fputs("\r\033[K", stdout); fflush(stdout); } return 0; }
long long cli_cursor_up(long long n)   { if (is_tty() && n > 0) { printf("\033[%lldA", n); fflush(stdout); } return 0; }
long long cli_cursor_down(long long n) { if (is_tty() && n > 0) { printf("\033[%lldB", n); fflush(stdout); } return 0; }
long long cli_move(long long row, long long col) {
    if (is_tty()) { printf("\033[%lld;%lldH", row, col); fflush(stdout); }
    return 0;
}

/* ═══════════════════════════════════════════════════════════════
   Terminal size queries
   ═══════════════════════════════════════════════════════════════ */
long long cli_term_width(void) {
    struct winsize ws;
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &ws) == 0 && ws.ws_col > 0)
        return ws.ws_col;
    return 80;
}
long long cli_term_height(void) {
    struct winsize ws;
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &ws) == 0 && ws.ws_row > 0)
        return ws.ws_row;
    return 24;
}

/* ═══════════════════════════════════════════════════════════════
   Styling helpers — return styled strings to use as values
   ═══════════════════════════════════════════════════════════════ */
static const char *color_code(const char *c) {
    if (!c) return "0";
    if (!strcmp(c,"red"))     return "31";
    if (!strcmp(c,"green"))   return "32";
    if (!strcmp(c,"yellow"))  return "33";
    if (!strcmp(c,"blue"))    return "34";
    if (!strcmp(c,"magenta")) return "35";
    if (!strcmp(c,"cyan"))    return "36";
    if (!strcmp(c,"white"))   return "37";
    if (!strcmp(c,"grey") || !strcmp(c,"gray")) return "90";
    return "0";
}
/* background SGR code for a named color (foreground + 10) */
static const char *bgcolor_code(const char *c) {
    if (!c) return "49";
    if (!strcmp(c,"red"))     return "41";
    if (!strcmp(c,"green"))   return "42";
    if (!strcmp(c,"yellow"))  return "43";
    if (!strcmp(c,"blue"))    return "44";
    if (!strcmp(c,"magenta")) return "45";
    if (!strcmp(c,"cyan"))    return "46";
    if (!strcmp(c,"white"))   return "47";
    if (!strcmp(c,"grey") || !strcmp(c,"gray")) return "100";
    return "49";
}
/* wrap text in a single SGR attribute code, auto-reset */
static char *style_wrap(const char *text, const char *sgr) {
    if (!text) text = "";
    size_t n = strlen(text) + strlen(sgr) + 8;
    char *o = xmalloc(n);
    snprintf(o, n, "\033[%sm%s\033[0m", sgr, text);
    return o;
}
char *cli_color(const char *text, const char *color) {
    return style_wrap(text, color_code(color));
}
/* set the background color: red green yellow blue magenta cyan white grey */
char *cli_bg(const char *text, const char *color) {
    return style_wrap(text, bgcolor_code(color));
}
/* 256-color palette foreground (0–255) */
static long long clamp255(long long v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }
char *cli_color256(const char *text, long long code) {
    code = clamp255(code);
    char sgr[16]; snprintf(sgr, sizeof sgr, "38;5;%lld", code);
    return style_wrap(text, sgr);
}
/* true-color (24-bit RGB) foreground */
char *cli_rgb(const char *text, long long r, long long g, long long b) {
    r = clamp255(r); g = clamp255(g); b = clamp255(b);
    char sgr[24]; snprintf(sgr, sizeof sgr, "38;2;%lld;%lld;%lld", r, g, b);
    return style_wrap(text, sgr);
}
char *cli_bold(const char *text)      { return style_wrap(text, "1"); }
char *cli_underline(const char *text) { return style_wrap(text, "4"); }
char *cli_italic(const char *text)    { return style_wrap(text, "3"); }
char *cli_reverse(const char *text)   { return style_wrap(text, "7"); }
char *cli_strike(const char *text)    { return style_wrap(text, "9"); }
char *cli_blink(const char *text)     { return style_wrap(text, "5"); }
char *cli_dim(const char *text) {
    if (!text) text = "";
    size_t n = strlen(text) + 12; char *o = xmalloc(n);
    snprintf(o, n, "\033[2m%s\033[0m", text); return o;
}

/* visual width: strips ANSI escapes, counts UTF-8 lead bytes only */
static int visual_len(const char *s) {
    int n = 0;
    while (*s) {
        if (*s == '\033' && *(s+1) == '[') {
            s += 2;
            while (*s && *s != 'm') s++;
            if (*s) s++;
            continue;
        }
        unsigned char c = (unsigned char)*s++;
        if (c < 0x80 || c >= 0xC0) n++;
    }
    return n;
}

/* byte length of the next UTF-8 codepoint */
static int utf8_seq(unsigned char c) {
    if (c < 0x80) return 1;
    if (c < 0xE0) return 2;
    if (c < 0xF0) return 3;
    return 4;
}

/* extract up to `max` UTF-8 codepoints from s into out[] (malloc'd, null-terminated).
   Returns count extracted. */
static int parse_box_chars(const char *s, char **out, int max) {
    int n = 0;
    while (s && *s && n < max) {
        int len = utf8_seq((unsigned char)*s);
        char *ch = xmalloc(len + 1);
        memcpy(ch, s, len); ch[len] = '\0';
        out[n++] = ch;
        s += len;
    }
    return n;
}

/* wrap pre-styled content in a unicode box whose frame uses frame_color.
   chars: UTF-8 string of 5 glyphs (tl h tr bl br, side=│) or 6 (tl h tr v bl br).
   padding: spaces added on each side of content horizontally, and blank rows
            added above/below content vertically.
       cli_make_box(cli_color("Hi","white"), "blue", "╔═╗║╚╝", 1) */
char *cli_make_box(const char *content, const char *frame_color, const char *chars, long long padding) {
    if (!content) content = "";
    if (!chars || !*chars) chars = "┌─┐│└┘";
    if (padding < 0) padding = 0;
    const char *fc = color_code(frame_color);

    char *ch[6] = {NULL};
    int nc = parse_box_chars(chars, ch, 6);

    const char *tl = nc > 0 ? ch[0] : "┌";
    const char *h  = nc > 1 ? ch[1] : "─";
    const char *tr = nc > 2 ? ch[2] : "┐";
    const char *v, *bl, *br;
    if (nc >= 6) { v = ch[3]; bl = ch[4]; br = ch[5]; }
    else if (nc == 5) { v = "│"; bl = ch[3]; br = ch[4]; }
    else { v = "│"; bl = "└"; br = "┘"; }

    /* box width = widest content line (content may span multiple '\n' lines) */
    int maxw = 0, nlines = 0;
    for (const char *q = content; ; ) {
        const char *nl = strchr(q, '\n');
        int seg = nl ? (int)(nl - q) : (int)strlen(q);
        char *ln = xmalloc(seg + 1); memcpy(ln, q, seg); ln[seg] = '\0';
        int vl = visual_len(ln); free(ln);
        if (vl > maxw) maxw = vl;
        nlines++;
        if (!nl) break;
        q = nl + 1;
    }
    int pad = (int)padding;
    int inner = maxw + 2 + 2 * pad;  /* total horizontal space between side chars */
    int hlen  = (int)strlen(h);
    size_t cap = (size_t)(inner + 4) * (hlen + 1) * 2
               + (size_t)(2 * pad + nlines + 2) * (inner + 120)
               + strlen(content) * 2 + 512;
    char *o = xmalloc(cap); char *p = o;

    /* top border */
    p += sprintf(p, "\033[%sm%s", fc, tl);
    for (int i = 0; i < inner; i++) p += sprintf(p, "%s", h);
    p += sprintf(p, "%s\033[0m\n", tr);

    /* blank rows above content */
    for (int r = 0; r < pad; r++) {
        p += sprintf(p, "\033[%sm%s\033[0m%*s\033[%sm%s\033[0m\n", fc, v, inner, "", fc, v);
    }

    /* content rows: (pad+1) spaces each side, each line left-aligned to maxw */
    for (const char *q = content; ; ) {
        const char *nl = strchr(q, '\n');
        int seg = nl ? (int)(nl - q) : (int)strlen(q);
        char *ln = xmalloc(seg + 1); memcpy(ln, q, seg); ln[seg] = '\0';
        int rfill = maxw - visual_len(ln);
        if (rfill < 0) rfill = 0;
        p += sprintf(p, "\033[%sm%s\033[0m%*s%s%*s%*s\033[%sm%s\033[0m\n",
                     fc, v, pad + 1, "", ln, rfill, "", pad + 1, "", fc, v);
        free(ln);
        if (!nl) break;
        q = nl + 1;
    }

    /* blank rows below content */
    for (int r = 0; r < pad; r++) {
        p += sprintf(p, "\033[%sm%s\033[0m%*s\033[%sm%s\033[0m\n", fc, v, inner, "", fc, v);
    }

    /* bottom border */
    p += sprintf(p, "\033[%sm%s", fc, bl);
    for (int i = 0; i < inner; i++) p += sprintf(p, "%s", h);
    p += sprintf(p, "%s\033[0m", br);

    for (int i = 0; i < nc; i++) free(ch[i]);
    return o;
}

/* ═══════════════════════════════════════════════════════════════
   Layout helpers — return strings for composing layouts
   ═══════════════════════════════════════════════════════════════ */

/* repeat UTF-8 glyph `ch` exactly `n` times */
char *cli_divider(const char *ch, long long n) {
    if (!ch || !*ch) ch = "-";
    if (n <= 0) return strdup("");
    int clen = utf8_seq((unsigned char)*ch);
    char *o = xmalloc((size_t)n * clen + 4); char *p = o;
    for (long long i = 0; i < n; i++) { memcpy(p, ch, clen); p += clen; }
    *p = '\0';
    return o;
}

/* center text in `width` visual columns, padding with spaces */
char *cli_center(const char *text, long long width) {
    if (!text) text = "";
    int vlen = visual_len(text);
    int total = (int)width - vlen;
    if (total <= 0) return strdup(text);
    int lpad = total / 2, rpad = total - lpad;
    size_t cap = strlen(text) + lpad + rpad + 4;
    char *o = xmalloc(cap); char *p = o;
    for (int i = 0; i < lpad; i++) *p++ = ' ';
    memcpy(p, text, strlen(text)); p += strlen(text);
    for (int i = 0; i < rpad; i++) *p++ = ' ';
    *p = '\0';
    return o;
}

/* left-align: pad right with spaces to reach `width` visual columns */
char *cli_ljust(const char *text, long long width) {
    if (!text) text = "";
    int pad = (int)width - visual_len(text);
    if (pad <= 0) return strdup(text);
    size_t cap = strlen(text) + pad + 4;
    char *o = xmalloc(cap);
    memcpy(o, text, strlen(text));
    char *p = o + strlen(text);
    for (int i = 0; i < pad; i++) *p++ = ' ';
    *p = '\0';
    return o;
}

/* right-align: pad left with spaces to reach `width` visual columns */
char *cli_rjust(const char *text, long long width) {
    if (!text) text = "";
    int pad = (int)width - visual_len(text);
    if (pad <= 0) return strdup(text);
    size_t cap = strlen(text) + pad + 4;
    char *o = xmalloc(cap); char *p = o;
    for (int i = 0; i < pad; i++) *p++ = ' ';
    memcpy(p, text, strlen(text)); p += strlen(text);
    *p = '\0';
    return o;
}

/* ═══════════════════════════════════════════════════════════════
   UI components
   ═══════════════════════════════════════════════════════════════ */

/* full-width section header: divider / bold title / divider (multi-line string) */
char *cli_section(const char *title, const char *color) {
    if (!title) title = "";
    long long w = cli_term_width();
    const char *cc = color_code(color && *color ? color : "white");
    size_t cap = (size_t)w * 6 + strlen(title) + 128;
    char *o = xmalloc(cap); char *p = o;
    p += sprintf(p, "\033[%sm", cc);
    for (int i = 0; i < (int)w; i++) { memcpy(p, "─", 3); p += 3; }
    p += sprintf(p, "\033[0m\n\033[1;%sm  %s\033[0m\n\033[%sm", cc, title, cc);
    for (int i = 0; i < (int)w; i++) { memcpy(p, "─", 3); p += 3; }
    p += sprintf(p, "\033[0m");
    return o;
}

/* centered title with ─── on both sides (single-line string) */
char *cli_title(const char *text, const char *color) {
    if (!text) text = "";
    long long w = cli_term_width();
    const char *cc = color_code(color && *color ? color : "white");
    int vlen = visual_len(text);
    int sides = ((int)w - vlen - 2) / 2;
    if (sides < 1) sides = 1;
    int rside = (int)w - sides - vlen - 2;
    if (rside < 1) rside = 1;
    size_t cap = (size_t)(sides + rside) * 3 + strlen(text) + 64;
    char *o = xmalloc(cap); char *p = o;
    p += sprintf(p, "\033[%sm", cc);
    for (int i = 0; i < sides; i++) { memcpy(p, "─", 3); p += 3; }
    p += sprintf(p, " %s ", text);
    for (int i = 0; i < rside; i++) { memcpy(p, "─", 3); p += 3; }
    p += sprintf(p, "\033[0m");
    return o;
}

/* colored alert with icon: type = "info" | "warn" | "error" | "success" */
char *cli_alert(const char *text, const char *type) {
    if (!text) text = "";
    if (!type || !*type) type = "info";
    const char *color, *icon;
    if      (!strcmp(type,"error"))   { color="31"; icon="✗"; }
    else if (!strcmp(type,"warn"))    { color="33"; icon="⚠"; }
    else if (!strcmp(type,"success")) { color="32"; icon="✓"; }
    else                              { color="36"; icon="ℹ"; }
    size_t cap = strlen(text) + 64;
    char *o = xmalloc(cap);
    snprintf(o, cap, "\033[%sm%s  %s\033[0m", color, icon, text);
    return o;
}

/* simple inline prompt + readline — no box, just prints prompt and reads */
char *cli_ask(const char *prompt) {
    if (!prompt) prompt = "";
    if (*prompt) { printf("%s", prompt); fflush(stdout); }
    char buf[4096]; buf[0] = '\0';
    if (fgets(buf, sizeof(buf), stdin)) {
        int l = (int)strlen(buf);
        if (l > 0 && buf[l-1] == '\n') buf[l-1] = '\0';
    }
    return strdup(buf);
}

/* masked prompt: reads a line without echoing it (prints `mask` per char, e.g.
   "*", or nothing if mask==""). Handles backspace. For passwords/secrets.
   Falls back to a plain read when not a TTY. */
char *cli_ask_secret(const char *prompt, const char *mask) {
    if (!prompt) prompt = "";
    if (!mask) mask = "";
    if (*prompt) { printf("%s", prompt); fflush(stdout); }

    if (!is_tty()) {                          /* non-interactive: plain read */
        char buf[4096]; buf[0] = '\0';
        if (fgets(buf, sizeof(buf), stdin)) {
            int l = (int)strlen(buf);
            if (l > 0 && buf[l-1] == '\n') buf[l-1] = '\0';
        }
        return strdup(buf);
    }

    ensure_handlers();
    int entered = tty_raw_enter();
    char buf[4096]; int len = 0;
    for (;;) {
        unsigned char c;
        if (read(STDIN_FILENO, &c, 1) != 1) break;     /* EOF */
        if (c == '\n' || c == '\r') break;
        if (c == 127 || c == 8) {                       /* backspace */
            if (len > 0) { len--; if (*mask) fputs("\b \b", stdout); fflush(stdout); }
            continue;
        }
        if (c == 3) { len = 0; break; }                 /* Ctrl-C-ish: bail empty */
        if (len < (int)sizeof(buf) - 1) {
            buf[len++] = (char)c;
            if (*mask) { fputs(mask, stdout); fflush(stdout); }
        }
    }
    buf[len] = '\0';
    if (entered) tty_raw_leave();
    fputc('\n', stdout); fflush(stdout);
    return strdup(buf);
}

/* y/n confirmation prompt — returns 1 for yes, 0 for no */
long long cli_confirm(const char *question) {
    if (!question) question = "";
    printf("%s [y/N] ", question);
    fflush(stdout);
    char buf[16]; buf[0] = '\0';
    if (fgets(buf, sizeof(buf), stdin))
        return (buf[0] == 'y' || buf[0] == 'Y') ? 1 : 0;
    return 0;
}

/* colored ✓ / ✗ status indicator */
char *cli_status(const char *label, long long ok) {
    if (!label) label = "";
    const char *icon  = ok ? "✓" : "✗";
    const char *color = ok ? "32" : "31";
    size_t cap = strlen(label) + 32;
    char *o = xmalloc(cap);
    snprintf(o, cap, "\033[%sm%s\033[0m %s", color, icon, label);
    return o;
}

/* bold colored badge: [text] */
char *cli_badge(const char *text, const char *color) {
    if (!text) text = "";
    const char *cc = color_code(color);
    size_t cap = strlen(text) + 32;
    char *o = xmalloc(cap);
    snprintf(o, cap, "\033[1;%sm[%s]\033[0m", cc, text);
    return o;
}

/* draw a framed input box (top border, empty middle, bottom border),
   position cursor in the middle, read a line with `prompt`, return it.
   width=0 → use terminal width - 4.  frame_color="" → no color. */
char *cli_inputbox(const char *prompt, long long width, const char *frame_color) {
    if (!prompt) prompt = "";
    if (width <= 0) width = cli_term_width() - 4;
    if (width < 4) width = 4;

    /* build raw border */
    int hlen = 3; /* "─" is 3 UTF-8 bytes */
    char *raw = xmalloc((size_t)width * hlen + 4); char *rp = raw;
    for (long long i = 0; i < width; i++) { memcpy(rp, "─", 3); rp += 3; }
    *rp = '\0';

    /* optionally colorize */
    char *border;
    if (frame_color && *frame_color) {
        const char *fc = color_code(frame_color);
        size_t bcap = strlen(raw) + 24;
        border = xmalloc(bcap);
        snprintf(border, bcap, "\033[%sm%s\033[0m", fc, raw);
        free(raw);
    } else {
        border = raw;
    }

    /* draw: top \n blank \n bottom \n */
    printf("%s\n\n%s\n", border, border);
    fflush(stdout);
    free(border);

    /* move cursor up 2 to the blank middle line */
    if (is_tty()) { printf("\033[2A"); fflush(stdout); }

    /* print prompt and read line */
    if (*prompt) { printf("%s", prompt); fflush(stdout); }
    char buf[4096]; buf[0] = '\0';
    if (fgets(buf, sizeof(buf), stdin)) {
        int l = (int)strlen(buf);
        if (l > 0 && buf[l-1] == '\n') buf[l-1] = '\0';
    }

    /* move cursor past the box */
    if (is_tty()) { printf("\033[1B\r"); fflush(stdout); }
    return strdup(buf);
}

/* ═══════════════════════════════════════════════════════════════
   Templates
   ═══════════════════════════════════════════════════════════════ */
/* render a picker's current state into its value, then redraw if shown */
static void picker_render(CliVar *v) {
    size_t cap = 64;
    for (int i = 0; i < v->nopts; i++) cap += strlen(v->opts[i]) + 24;
    char *buf = xmalloc(cap); buf[0] = '\0'; char *p = buf;
    for (int i = 0; i < v->nopts; i++) {
        int on = (i == v->sel);
        if (v->vertical) {
            if (on) p += sprintf(p, "\033[36m❯ %s\033[0m", v->opts[i]);
            else    p += sprintf(p, "  %s", v->opts[i]);
            if (i < v->nopts - 1) *p++ = '\n';
        } else {
            if (on) p += sprintf(p, "\033[7m %s \033[0m", v->opts[i]);
            else    p += sprintf(p, " %s ", v->opts[i]);
        }
    }
    *p = '\0';
    cli_set(v->name, buf);
    free(buf);
}

/* create a picker (returns its name as a handle).
   `options` is a newline-separated list. dir: "vertical"/"horizontal" */
char *cli_picker(const char *name, const char *dir, const char *options) {
    CliVar *v = get_or_new(name);
    if (!v) return strdup(name ? name : "");
    for (int i = 0; i < v->nopts; i++) free(v->opts[i]);
    v->nopts = 0; v->sel = 0; v->is_picker = 1;
    v->vertical = (dir && strcmp(dir, "horizontal") == 0) ? 0 : 1;
    const char *p = options ? options : "";
    while (*p && v->nopts < MAX_OPTS) {
        const char *nl = strchr(p, '\n');
        int len = nl ? (int)(nl - p) : (int)strlen(p);
        char *o = xmalloc(len + 1); memcpy(o, p, len); o[len] = '\0';
        v->opts[v->nopts++] = o;
        if (!nl) break;
        p = nl + 1;
    }
    picker_render(v);
    return strdup(name);
}
long long cli_picker_down(const char *name) {
    CliVar *v = find(name);
    if (!v || !v->is_picker || v->nopts == 0) return 0;
    v->sel = (v->sel + 1) % v->nopts; picker_render(v); return v->sel;
}
long long cli_picker_up(const char *name) {
    CliVar *v = find(name);
    if (!v || !v->is_picker || v->nopts == 0) return 0;
    v->sel = (v->sel - 1 + v->nopts) % v->nopts; picker_render(v); return v->sel;
}
long long cli_picker_select(const char *name, long long i) {
    CliVar *v = find(name);
    if (!v || !v->is_picker || i < 0 || i >= v->nopts) return 0;
    v->sel = (int)i; picker_render(v); return 1;
}
long long cli_picker_index(const char *name) {
    CliVar *v = find(name);
    return (v && v->is_picker) ? v->sel : -1;
}
char *cli_picker_value(const char *name) {
    CliVar *v = find(name);
    if (!v || !v->is_picker || v->sel < 0 || v->sel >= v->nopts) return strdup("");
    return strdup(v->opts[v->sel]);
}

/* a progress bar value: [#####-----]  42%  — store under `name` */
long long cli_progress(const char *name, long long percent, long long width) {
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    if (width <= 0) width = 20;
    char *buf = xmalloc((size_t)width * 4 + 32);
    char *p = buf; *p++ = '[';
    long long fill = percent * width / 100;
    for (long long i = 0; i < width; i++) p += sprintf(p, "%s", i < fill ? "█" : "░");
    sprintf(p, "] %3lld%%", percent);
    cli_set(name, buf);
    free(buf);
    return 1;
}

/* spinner: advance one frame and store under `name` */
long long cli_spinner(const char *name) {
    static const char *frames[] = {"⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"};
    CliVar *v = get_or_new(name);
    if (!v) return 0;
    int f = (v->sel + 1) % 10; v->sel = f;
    cli_set(name, frames[f]);
    return 0;
}

/* ═══════════════════════════════════════════════════════════════
   Interactive menu — blocking arrow-key chooser
   ═══════════════════════════════════════════════════════════════ */

/* logical keypress codes */
enum {
    KEY_UP = 1001, KEY_DOWN, KEY_RIGHT, KEY_LEFT,
    KEY_HOME, KEY_END, KEY_PGUP, KEY_PGDN, KEY_DEL
};

/* read one logical keypress in raw mode. Returns a KEY_* code for navigation
   keys, '\n' for enter, 27 for ESC, the literal byte otherwise, -1 on EOF.
   Extended sequences (\033[1~, \033[3~, …) are fully consumed so leftover
   bytes never pollute the next read. */
static int read_key(void) {
    unsigned char c;
    if (read(STDIN_FILENO, &c, 1) != 1) return -1;
    if (c == '\033') {                       /* could be ESC or a CSI/SS3 seq */
        struct pollfd pfd = { STDIN_FILENO, POLLIN, 0 };
        if (poll(&pfd, 1, 40) <= 0) return 27;   /* lone ESC */
        unsigned char a;
        if (read(STDIN_FILENO, &a, 1) != 1) return 27;
        if (a == '[' || a == 'O') {
            unsigned char b;
            if (read(STDIN_FILENO, &b, 1) != 1) return 27;
            switch (b) {
                case 'A': return KEY_UP;
                case 'B': return KEY_DOWN;
                case 'C': return KEY_RIGHT;
                case 'D': return KEY_LEFT;
                case 'H': return KEY_HOME;    /* xterm home */
                case 'F': return KEY_END;     /* xterm end  */
            }
            if (b >= '0' && b <= '9') {       /* \033[<num>~ — consume to final */
                unsigned char seq[8]; int si = 0; seq[si++] = b;
                unsigned char d;
                while (si < 7 && read(STDIN_FILENO, &d, 1) == 1) {
                    seq[si++] = d;
                    if (d >= '@' && d <= '~') break;   /* CSI final byte */
                }
                seq[si] = '\0';
                if (seq[si-1] == '~') {
                    if (seq[0] == '1' || seq[0] == '7') return KEY_HOME;
                    if (seq[0] == '4' || seq[0] == '8') return KEY_END;
                    if (seq[0] == '3')                  return KEY_DEL;
                    if (seq[0] == '5')                  return KEY_PGUP;
                    if (seq[0] == '6')                  return KEY_PGDN;
                }
            }
        }
        return 27;
    }
    if (c == '\r') return '\n';
    return c;
}

/* block until one keypress, return its name as a string. Names:
   "up" "down" "left" "right" "enter" "esc" "space" "tab" "backspace",
   any other key as its literal character ("a", "1", ...). "" on EOF.
   Pairs with the easy-API listen()/dispatch() loop in cli.ez. */
char *cli_read_key(void) {
    if (!is_tty()) {                         /* non-interactive: 1 char/line */
        int c = fgetc(stdin);
        if (c == EOF)  return strdup("");
        if (c == '\n') return strdup("enter");
        char b[2] = { (char)c, '\0' };
        return strdup(b);
    }
    ensure_handlers();
    int entered = tty_raw_enter();
    int k = read_key();
    if (entered) tty_raw_leave();

    char buf[8];
    const char *name;
    switch (k) {
        case KEY_UP:    name = "up";        break;
        case KEY_DOWN:  name = "down";      break;
        case KEY_RIGHT: name = "right";     break;
        case KEY_LEFT:  name = "left";      break;
        case KEY_HOME:  name = "home";      break;
        case KEY_END:   name = "end";       break;
        case KEY_PGUP:  name = "pageup";    break;
        case KEY_PGDN:  name = "pagedown";  break;
        case KEY_DEL:   name = "delete";    break;
        case '\n': name = "enter";     break;
        case 27:   name = "esc";       break;
        case ' ':  name = "space";     break;
        case '\t': name = "tab";       break;
        case 8: case 127: name = "backspace"; break;
        case -1:   name = "";          break;
        default:   buf[0] = (char)k; buf[1] = '\0'; name = buf; break;
    }
    return strdup(name);
}

/* draw an interactive vertical menu, let the user move with ↑/↓ (or k/j) and
   pick with Enter; q/ESC cancels. Returns the selected 0-based index, or -1 on
   cancel. `options` is a newline-separated list. Non-TTY → prints and returns 0.
       i = cli_menu("Pick one:", "Apple\nBanana\nCherry") */
long long cli_menu(const char *title, const char *options) {
    char *opts[MAX_OPTS]; int n = 0;
    const char *p = options ? options : "";
    while (*p && n < MAX_OPTS) {
        const char *nl = strchr(p, '\n');
        int len = nl ? (int)(nl - p) : (int)strlen(p);
        char *o = xmalloc(len + 1); memcpy(o, p, len); o[len] = '\0';
        opts[n++] = o;
        if (!nl) break;
        p = nl + 1;
    }
    if (n == 0) return -1;

    if (!is_tty()) {                         /* non-interactive: list + default */
        if (title && *title) printf("%s\n", title);
        for (int i = 0; i < n; i++) printf("  %s\n", opts[i]);
        for (int i = 0; i < n; i++) free(opts[i]);
        return 0;
    }

    ensure_handlers();
    tty_raw_enter();
    tty_hide_cursor();

    if (title && *title) printf("%s\n", title);
    int sel = 0, drawn = 0;
    for (;;) {
        if (drawn) printf("\033[%dA", n);    /* rewind to top of list */
        for (int i = 0; i < n; i++) {
            if (i == sel) printf("\r\033[K\033[36m❯ %s\033[0m\n", opts[i]);
            else          printf("\r\033[K  %s\n", opts[i]);
        }
        drawn = 1;
        fflush(stdout);

        int k = read_key();
        if      (k == KEY_UP   || k == 'k')  sel = (sel - 1 + n) % n;
        else if (k == KEY_DOWN || k == 'j')  sel = (sel + 1) % n;
        else if (k == KEY_HOME || k == KEY_PGUP) sel = 0;
        else if (k == KEY_END  || k == KEY_PGDN) sel = n - 1;
        else if (k == '\n')                  break;
        else if (k == 27 || k == 'q' || k == -1) { sel = -1; break; }
        /* k == -1 (EOF/read error) now cancels instead of spinning forever */
    }

    tty_raw_leave();
    tty_show_cursor();
    for (int i = 0; i < n; i++) free(opts[i]);
    return sel;
}

/* interactive multi-select checklist. ↑/↓ (or k/j) move, Space toggles, Enter
   confirms, q/Esc cancels. Returns a newline-separated list of the checked
   option texts ("" if cancelled or nothing checked). Non-TTY → lists and
   returns "". `options` is a newline-separated list.
       picked = cli_checklist("Toppings:", "Cheese\nHam\nOlives") */
char *cli_checklist(const char *title, const char *options) {
    char *opts[MAX_OPTS]; int n = 0;
    const char *p = options ? options : "";
    while (*p && n < MAX_OPTS) {
        const char *nl = strchr(p, '\n');
        int len = nl ? (int)(nl - p) : (int)strlen(p);
        char *o = xmalloc(len + 1); memcpy(o, p, len); o[len] = '\0';
        opts[n++] = o;
        if (!nl) break;
        p = nl + 1;
    }
    if (n == 0) return strdup("");

    int checked[MAX_OPTS]; for (int i = 0; i < n; i++) checked[i] = 0;

    if (!is_tty()) {
        if (title && *title) printf("%s\n", title);
        for (int i = 0; i < n; i++) printf("  [ ] %s\n", opts[i]);
        for (int i = 0; i < n; i++) free(opts[i]);
        return strdup("");
    }

    ensure_handlers();
    tty_raw_enter();
    tty_hide_cursor();
    if (title && *title) printf("%s\n", title);

    int sel = 0, drawn = 0, cancelled = 0;
    for (;;) {
        if (drawn) printf("\033[%dA", n);
        for (int i = 0; i < n; i++) {
            const char *bx = checked[i] ? "[x]" : "[ ]";
            if (i == sel) printf("\r\033[K\033[36m❯ %s %s\033[0m\n", bx, opts[i]);
            else          printf("\r\033[K  %s %s\n", bx, opts[i]);
        }
        drawn = 1; fflush(stdout);

        int k = read_key();
        if      (k == KEY_UP   || k == 'k') sel = (sel - 1 + n) % n;
        else if (k == KEY_DOWN || k == 'j') sel = (sel + 1) % n;
        else if (k == KEY_HOME || k == KEY_PGUP) sel = 0;
        else if (k == KEY_END  || k == KEY_PGDN) sel = n - 1;
        else if (k == ' ')      checked[sel] = !checked[sel];
        else if (k == '\n')     break;
        else if (k == 27 || k == 'q' || k == -1) { cancelled = 1; break; }
    }

    tty_raw_leave();
    tty_show_cursor();

    char *res;
    if (cancelled) {
        res = strdup("");
    } else {
        size_t cap = 1;
        for (int i = 0; i < n; i++) if (checked[i]) cap += strlen(opts[i]) + 1;
        res = xmalloc(cap); char *rp = res; int first = 1;
        for (int i = 0; i < n; i++) if (checked[i]) {
            if (!first) *rp++ = '\n';
            size_t l = strlen(opts[i]); memcpy(rp, opts[i], l); rp += l;
            first = 0;
        }
        *rp = '\0';
    }
    for (int i = 0; i < n; i++) free(opts[i]);
    return res;
}

/* split `s` on byte `sep` into out[] (each malloc'd), up to `max`; count back */
static int split_into(const char *s, char sep, char **out, int max) {
    int n = 0;
    const char *p = s ? s : "";
    for (;;) {
        if (n >= max) break;
        const char *e = strchr(p, sep);
        int len = e ? (int)(e - p) : (int)strlen(p);
        char *o = xmalloc(len + 1); memcpy(o, p, len); o[len] = '\0';
        out[n++] = o;
        if (!e) break;
        p = e + 1;
    }
    return n;
}

/* render a bordered table as a multi-line string. `header` is a TAB-separated
   row of column titles ("" → no header row). `rows` is newline-separated; each
   row is TAB-separated cells. Columns auto-size to their widest cell.
       cli_table("Name\tAge", "Ada\t36\nGrace\t45") */
char *cli_table(const char *header, const char *rows) {
    enum { TC = 16, TR = 128 };               /* max cols / rows */
    char *hdr[TC]; int nhdr = 0;
    int have_hdr = header && *header;
    if (have_hdr) nhdr = split_into(header, '\t', hdr, TC);

    char *cell[TR][TC]; int rowcols[TR]; int nrow = 0;
    int ncol = nhdr;
    const char *p = rows ? rows : "";
    while (*p && nrow < TR) {
        const char *nl = strchr(p, '\n');
        int len = nl ? (int)(nl - p) : (int)strlen(p);
        char *line = xmalloc(len + 1); memcpy(line, p, len); line[len] = '\0';
        rowcols[nrow] = split_into(line, '\t', cell[nrow], TC);
        free(line);
        if (rowcols[nrow] > ncol) ncol = rowcols[nrow];
        nrow++;
        if (!nl) break;
        p = nl + 1;
    }
    if (ncol == 0) {
        for (int i = 0; i < nhdr; i++) free(hdr[i]);
        return strdup("");
    }

    int w[TC]; for (int c = 0; c < ncol; c++) w[c] = 0;
    if (have_hdr)
        for (int c = 0; c < nhdr; c++) { int v = visual_len(hdr[c]); if (v > w[c]) w[c] = v; }
    for (int r = 0; r < nrow; r++)
        for (int c = 0; c < rowcols[r]; c++) { int v = visual_len(cell[r][c]); if (v > w[c]) w[c] = v; }

    long total_w = 0;
    for (int c = 0; c < ncol; c++) total_w += w[c] + 4;
    size_t cap = (size_t)total_w * 3 * (nrow + 5)
               + strlen(rows ? rows : "") * 2
               + (have_hdr ? strlen(header) * 2 : 0) + 512;
    char *o = xmalloc(cap); char *q = o;

    #define TBL_HLINE(L,M,R) do {                                   \
        q += sprintf(q, "%s", (L));                                 \
        for (int c = 0; c < ncol; c++) {                            \
            for (int i = 0; i < w[c] + 2; i++) { memcpy(q,"─",3); q += 3; } \
            q += sprintf(q, "%s", c < ncol - 1 ? (M) : (R));        \
        }                                                           \
        *q++ = '\n';                                                \
    } while (0)

    TBL_HLINE("┌","┬","┐");
    if (have_hdr) {
        for (int c = 0; c < ncol; c++) {
            const char *t = c < nhdr ? hdr[c] : "";
            int fill = w[c] - visual_len(t); if (fill < 0) fill = 0;
            q += sprintf(q, "│ \033[1m%s\033[0m%*s ", t, fill, "");
        }
        q += sprintf(q, "│\n");
        TBL_HLINE("├","┼","┤");
    }
    for (int r = 0; r < nrow; r++) {
        for (int c = 0; c < ncol; c++) {
            const char *t = c < rowcols[r] ? cell[r][c] : "";
            int fill = w[c] - visual_len(t); if (fill < 0) fill = 0;
            q += sprintf(q, "│ %s%*s ", t, fill, "");
        }
        q += sprintf(q, "│\n");
    }
    TBL_HLINE("└","┴","┘");
    #undef TBL_HLINE
    if (q > o && q[-1] == '\n') q[-1] = '\0'; else *q = '\0';

    for (int i = 0; i < nhdr; i++) free(hdr[i]);
    for (int r = 0; r < nrow; r++)
        for (int c = 0; c < rowcols[r]; c++) free(cell[r][c]);
    return o;
}
