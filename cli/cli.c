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

#define MAX_VARS 256
#define MAX_OPTS 64

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

static CliVar *find(const char *name) {
    if (!name) return NULL;
    for (int i = 0; i < MAX_VARS; i++)
        if (g_vars[i].used && strcmp(g_vars[i].name, name) == 0) return &g_vars[i];
    return NULL;
}
static CliVar *get_or_new(const char *name) {
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
    struct termios old, raw;
    if (tcgetattr(STDIN_FILENO, &old) != 0) return 0;
    raw = old;
    raw.c_lflag &= ~(unsigned)(ICANON | ECHO);
    tcsetattr(STDIN_FILENO, TCSANOW, &raw);
    if (write(STDOUT_FILENO, "\033[6n", 4) != 4) { tcsetattr(STDIN_FILENO, TCSANOW, &old); return 0; }
    char buf[32]; int i = 0;
    struct pollfd pfd = { STDIN_FILENO, POLLIN, 0 };
    while (i < 31) {
        if (poll(&pfd, 1, 120) <= 0) break;       /* timeout → give up */
        char c; if (read(STDIN_FILENO, &c, 1) != 1) break;
        buf[i++] = c;
        if (c == 'R') break;
    }
    buf[i] = '\0';
    tcsetattr(STDIN_FILENO, TCSANOW, &old);
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
    for (int e = line; e < old_lines; e++)     /* clear leftover old lines */
        printf("\033[%d;%dH\033[K", row + e, col);
    fputs("\033[u", stdout);                   /* restore cursor */
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
long long cli_cursor_hide(void) { if (is_tty()) { fputs("\033[?25l", stdout); fflush(stdout);} return 0; }
long long cli_cursor_show(void) { if (is_tty()) { fputs("\033[?25h", stdout); fflush(stdout);} return 0; }
long long cli_move(long long row, long long col) {
    if (is_tty()) { printf("\033[%lld;%lldH", row, col); fflush(stdout); }
    return 0;
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
char *cli_color(const char *text, const char *color) {
    if (!text) text = "";
    size_t n = strlen(text) + 24;
    char *o = malloc(n);
    snprintf(o, n, "\033[%sm%s\033[0m", color_code(color), text);
    return o;
}
char *cli_bold(const char *text) {
    if (!text) text = "";
    size_t n = strlen(text) + 12; char *o = malloc(n);
    snprintf(o, n, "\033[1m%s\033[0m", text); return o;
}
char *cli_dim(const char *text) {
    if (!text) text = "";
    size_t n = strlen(text) + 12; char *o = malloc(n);
    snprintf(o, n, "\033[2m%s\033[0m", text); return o;
}

/* visual width of a string: strips ANSI escape sequences and counts
   UTF-8 lead bytes only (continuation bytes 0x80–0xBF are skipped) */
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

/* wrap pre-styled content in a unicode box whose frame uses frame_color.
   content can already carry its own ANSI styling (cli_color, cli_bold, …);
   visual width is measured correctly so the border aligns.
       cli_make_box(cli_color("Hello", "white"), "blue") */
char *cli_make_box(const char *content, const char *frame_color) {
    if (!content) content = "";
    const char *fc = color_code(frame_color);
    int w = visual_len(content);
    size_t cap = (size_t)(w + 4) * 4 + strlen(content) + 256;
    char *o = malloc(cap); char *p = o;
    p += sprintf(p, "\033[%sm┌", fc);
    for (int i = 0; i < w + 2; i++) p += sprintf(p, "─");
    p += sprintf(p, "┐\033[0m\n");
    p += sprintf(p, "\033[%sm│\033[0m %s \033[%sm│\033[0m\n", fc, content, fc);
    p += sprintf(p, "\033[%sm└", fc);
    for (int i = 0; i < w + 2; i++) p += sprintf(p, "─");
    p += sprintf(p, "┘\033[0m");
    return o;
}

/* ═══════════════════════════════════════════════════════════════
   Templates
   ═══════════════════════════════════════════════════════════════ */
/* render a picker's current state into its value, then redraw if shown */
static void picker_render(CliVar *v) {
    size_t cap = 64;
    for (int i = 0; i < v->nopts; i++) cap += strlen(v->opts[i]) + 24;
    char *buf = malloc(cap); buf[0] = '\0'; char *p = buf;
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
        char *o = malloc(len + 1); memcpy(o, p, len); o[len] = '\0';
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
    char *buf = malloc((size_t)width * 4 + 32);
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
