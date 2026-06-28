/* ═══════════════════════════════════════════════════════════════
   os_ui — native desktop dialogs for Ezy (extension of the `os` lib).

   File open/save pickers, folder picker, message/confirm/input boxes.
   Desktop backends:
     linux  → zenity (GTK)            [must be on PATH]
     macos  → osascript (AppleScript)
     windows→ Win32 comdlg32 / shell32 / user32
   Mobile (android/ios) is reserved — the native pickers there need a
   Java/ObjC bridge; these calls return "" / 0 for now.

   Strings returned to Ezy are heap-allocated (the arena owns them).
   Build: extends "os", so os.c is compiled in alongside this file.
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
  #define UI_WINDOWS 1
  #include <windows.h>
  #include <commdlg.h>
  #include <shlobj.h>
#elif defined(__ANDROID__)
  #define UI_ANDROID 1
#elif defined(__APPLE__)
  #include <TargetConditionals.h>
  #if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
    #define UI_IOS 1
  #else
    #define UI_MACOS 1
  #endif
#else
  #define UI_LINUX 1
#endif

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

/* ── shell helpers (linux/macos backends shell out) ── */
#if defined(UI_LINUX) || defined(UI_MACOS)
/* append `in` to `out` single-quoted and escaped, safe for /bin/sh */
static void sh_quote(char *out, size_t cap, const char *in) {
    size_t o = strlen(out);
    if (o + 1 < cap) out[o++] = '\'';
    for (const char *p = in ? in : ""; *p && o + 4 < cap; p++) {
        if (*p == '\'') { memcpy(out + o, "'\\''", 4); o += 4; }
        else out[o++] = *p;
    }
    if (o + 1 < cap) out[o++] = '\'';
    out[o] = 0;
}
/* run a command, return its stdout with the trailing newline stripped */
static char *run_capture(const char *cmd) {
    FILE *p = popen(cmd, "r");
    if (!p) return strdup("");
    size_t cap = 4096, len = 0; char *buf = malloc(cap); size_t n; char tmp[4096];
    while ((n = fread(tmp, 1, sizeof tmp, p)) > 0) {
        if (len + n + 1 > cap) { while (len + n + 1 > cap) cap *= 2; buf = realloc(buf, cap); }
        memcpy(buf + len, tmp, n); len += n;
    }
    int rc = pclose(p);
    while (len && (buf[len-1] == '\n' || buf[len-1] == '\r')) len--;
    buf[len] = 0;
    if (rc != 0 && len == 0) { free(buf); return strdup(""); }   /* cancelled */
    return buf;
}
#endif

/* ── windows: a small modal input box (shared by input + password) ── */
#ifdef UI_WINDOWS
static char win_in_buf[2048];
static int  win_in_ok;
static LRESULT CALLBACK win_in_proc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_COMMAND) {
        if (LOWORD(w) == 1) { GetWindowText(GetDlgItem(h, 100), win_in_buf, sizeof win_in_buf); win_in_ok = 1; DestroyWindow(h); }
        else if (LOWORD(w) == 2) { win_in_ok = 0; DestroyWindow(h); }
        return 0;
    }
    if (m == WM_CLOSE)   { win_in_ok = 0; DestroyWindow(h); return 0; }
    if (m == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProc(h, m, w, l);
}
static char *win_input(const char *title, const char *prompt, const char *deflt, int password) {
    win_in_ok = 0; win_in_buf[0] = 0;
    WNDCLASS wc; memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = win_in_proc; wc.hInstance = GetModuleHandle(NULL);
    wc.lpszClassName = "EzyInputWnd"; wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    RegisterClass(&wc);
    HWND h = CreateWindow("EzyInputWnd", title && *title ? title : "Input",
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, CW_USEDEFAULT, CW_USEDEFAULT, 360, 160,
        NULL, NULL, wc.hInstance, NULL);
    CreateWindow("STATIC", prompt ? prompt : "", WS_CHILD | WS_VISIBLE, 12, 12, 330, 20, h, NULL, wc.hInstance, NULL);
    DWORD est = WS_CHILD | WS_VISIBLE | WS_BORDER | ES_AUTOHSCROLL | (password ? ES_PASSWORD : 0);
    HWND e = CreateWindow("EDIT", deflt ? deflt : "", est, 12, 40, 330, 24, h, (HMENU)100, wc.hInstance, NULL);
    CreateWindow("BUTTON", "OK", WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON, 180, 80, 75, 26, h, (HMENU)1, wc.hInstance, NULL);
    CreateWindow("BUTTON", "Cancel", WS_CHILD | WS_VISIBLE, 267, 80, 75, 26, h, (HMENU)2, wc.hInstance, NULL);
    ShowWindow(h, SW_SHOW); SetFocus(e);
    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) { if (!IsDialogMessage(h, &msg)) { TranslateMessage(&msg); DispatchMessage(&msg); } }
    return strdup(win_in_ok ? win_in_buf : "");
}
#endif

/* ════════════════════════ file open ════════════════════════ */
/* `filter` is an optional space-separated glob list, e.g. "*.png *.jpg" ("" = any) */
char *os_ui_open_file(const char *title, const char *filter) {
#if defined(UI_LINUX)
    char cmd[2048] = "zenity --file-selection --title=";
    sh_quote(cmd, sizeof cmd, title && *title ? title : "Open file");
    if (filter && *filter) { strncat(cmd, " --file-filter=", sizeof cmd - strlen(cmd) - 1); sh_quote(cmd, sizeof cmd, filter); }
    strncat(cmd, " 2>/dev/null", sizeof cmd - strlen(cmd) - 1);
    return run_capture(cmd);
#elif defined(UI_MACOS)
    (void)filter;
    char cmd[2048] = "osascript -e 'POSIX path of (choose file with prompt ";
    char t[1024] = ""; sh_quote(t, sizeof t, title && *title ? title : "Open file");
    /* AppleScript needs the prompt as an AS string; pass via a quoted arg */
    snprintf(cmd, sizeof cmd, "osascript -e 'POSIX path of (choose file with prompt \"%s\")' 2>/dev/null",
             title && *title ? title : "Open file");
    return run_capture(cmd);
#elif defined(UI_WINDOWS)
    (void)filter;
    char buf[PATH_MAX] = "";
    OPENFILENAME ofn; memset(&ofn, 0, sizeof ofn);
    ofn.lStructSize = sizeof ofn; ofn.lpstrFile = buf; ofn.nMaxFile = sizeof buf;
    ofn.lpstrTitle = (title && *title) ? title : "Open file";
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    return strdup(GetOpenFileName(&ofn) ? buf : "");
#else
    (void)title; (void)filter; return strdup("");   /* android/ios: reserved */
#endif
}

/* ════════════════════════ file save ════════════════════════ */
char *os_ui_save_file(const char *title, const char *default_name) {
#if defined(UI_LINUX)
    char cmd[2048] = "zenity --file-selection --save --confirm-overwrite --title=";
    sh_quote(cmd, sizeof cmd, title && *title ? title : "Save file");
    if (default_name && *default_name) { strncat(cmd, " --filename=", sizeof cmd - strlen(cmd) - 1); sh_quote(cmd, sizeof cmd, default_name); }
    strncat(cmd, " 2>/dev/null", sizeof cmd - strlen(cmd) - 1);
    return run_capture(cmd);
#elif defined(UI_MACOS)
    char cmd[2048];
    snprintf(cmd, sizeof cmd,
        "osascript -e 'POSIX path of (choose file name with prompt \"%s\" default name \"%s\")' 2>/dev/null",
        title && *title ? title : "Save file", default_name ? default_name : "untitled");
    return run_capture(cmd);
#elif defined(UI_WINDOWS)
    char buf[PATH_MAX] = "";
    if (default_name) { strncpy(buf, default_name, sizeof buf - 1); buf[sizeof buf - 1] = 0; }
    OPENFILENAME ofn; memset(&ofn, 0, sizeof ofn);
    ofn.lStructSize = sizeof ofn; ofn.lpstrFile = buf; ofn.nMaxFile = sizeof buf;
    ofn.lpstrTitle = (title && *title) ? title : "Save file";
    ofn.Flags = OFN_OVERWRITEPROMPT | OFN_NOCHANGEDIR;
    return strdup(GetSaveFileName(&ofn) ? buf : "");
#else
    (void)title; (void)default_name; return strdup("");
#endif
}

/* ════════════════════════ folder picker ════════════════════════ */
char *os_ui_pick_folder(const char *title) {
#if defined(UI_LINUX)
    char cmd[2048] = "zenity --file-selection --directory --title=";
    sh_quote(cmd, sizeof cmd, title && *title ? title : "Choose folder");
    strncat(cmd, " 2>/dev/null", sizeof cmd - strlen(cmd) - 1);
    return run_capture(cmd);
#elif defined(UI_MACOS)
    char cmd[2048];
    snprintf(cmd, sizeof cmd, "osascript -e 'POSIX path of (choose folder with prompt \"%s\")' 2>/dev/null",
             title && *title ? title : "Choose folder");
    return run_capture(cmd);
#elif defined(UI_WINDOWS)
    BROWSEINFO bi; memset(&bi, 0, sizeof bi);
    bi.lpszTitle = (title && *title) ? title : "Choose folder";
    bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
    LPITEMIDLIST pidl = SHBrowseForFolder(&bi);
    if (!pidl) return strdup("");
    char path[PATH_MAX] = "";
    SHGetPathFromIDList(pidl, path);
    CoTaskMemFree(pidl);
    return strdup(path);
#else
    (void)title; return strdup("");
#endif
}

/* ════════════════════════ message / confirm / input ════════════════════════ */
/* informational alert; returns 1 */
long long os_ui_message(const char *title, const char *text) {
#if defined(UI_LINUX)
    char cmd[2048] = "zenity --info --title=";
    sh_quote(cmd, sizeof cmd, title && *title ? title : "Message");
    strncat(cmd, " --text=", sizeof cmd - strlen(cmd) - 1); sh_quote(cmd, sizeof cmd, text ? text : "");
    strncat(cmd, " 2>/dev/null", sizeof cmd - strlen(cmd) - 1);
    free(run_capture(cmd)); return 1;
#elif defined(UI_MACOS)
    char cmd[2048];
    snprintf(cmd, sizeof cmd, "osascript -e 'display dialog \"%s\" with title \"%s\" buttons {\"OK\"} default button 1' >/dev/null 2>&1",
             text ? text : "", title && *title ? title : "Message");
    free(run_capture(cmd)); return 1;
#elif defined(UI_WINDOWS)
    MessageBox(NULL, text ? text : "", (title && *title) ? title : "Message", MB_OK | MB_ICONINFORMATION);
    return 1;
#else
    (void)title; (void)text; return 0;
#endif
}
/* yes/no question; returns 1 for yes, 0 for no/cancel */
long long os_ui_confirm(const char *title, const char *text) {
#if defined(UI_LINUX)
    char cmd[2048] = "zenity --question --title=";
    sh_quote(cmd, sizeof cmd, title && *title ? title : "Confirm");
    strncat(cmd, " --text=", sizeof cmd - strlen(cmd) - 1); sh_quote(cmd, sizeof cmd, text ? text : "");
    strncat(cmd, " >/dev/null 2>&1; echo $?", sizeof cmd - strlen(cmd) - 1);
    char *r = run_capture(cmd); int yes = (r[0] == '0'); free(r); return yes ? 1 : 0;
#elif defined(UI_MACOS)
    char cmd[2048];
    snprintf(cmd, sizeof cmd,
        "osascript -e 'button returned of (display dialog \"%s\" with title \"%s\" buttons {\"No\",\"Yes\"} default button 2)' 2>/dev/null",
        text ? text : "", title && *title ? title : "Confirm");
    char *r = run_capture(cmd); int yes = !strcmp(r, "Yes"); free(r); return yes ? 1 : 0;
#elif defined(UI_WINDOWS)
    int r = MessageBox(NULL, text ? text : "", (title && *title) ? title : "Confirm", MB_YESNO | MB_ICONQUESTION);
    return r == IDYES ? 1 : 0;
#else
    (void)title; (void)text; return 0;
#endif
}
/* text entry; returns the entered text ("" if cancelled) */
char *os_ui_input(const char *title, const char *prompt, const char *deflt) {
#if defined(UI_LINUX)
    char cmd[2048] = "zenity --entry --title=";
    sh_quote(cmd, sizeof cmd, title && *title ? title : "Input");
    strncat(cmd, " --text=", sizeof cmd - strlen(cmd) - 1); sh_quote(cmd, sizeof cmd, prompt ? prompt : "");
    if (deflt && *deflt) { strncat(cmd, " --entry-text=", sizeof cmd - strlen(cmd) - 1); sh_quote(cmd, sizeof cmd, deflt); }
    strncat(cmd, " 2>/dev/null", sizeof cmd - strlen(cmd) - 1);
    return run_capture(cmd);
#elif defined(UI_MACOS)
    char cmd[2048];
    snprintf(cmd, sizeof cmd,
        "osascript -e 'text returned of (display dialog \"%s\" with title \"%s\" default answer \"%s\")' 2>/dev/null",
        prompt ? prompt : "", title && *title ? title : "Input", deflt ? deflt : "");
    return run_capture(cmd);
#elif defined(UI_WINDOWS)
    return win_input(title, prompt, deflt, 0);
#else
    (void)title; (void)prompt; (void)deflt; return strdup("");   /* mobile: reserved */
#endif
}

/* ════════════════════════ color / date / list / password ════════════════════════ */
/* pick a color → "#rrggbb" ("" if cancelled) */
char *os_ui_pick_color(const char *title) {
#if defined(UI_LINUX)
    char cmd[1024] = "zenity --color-selection --title=";
    sh_quote(cmd, sizeof cmd, title && *title ? title : "Pick a color");
    strncat(cmd, " 2>/dev/null", sizeof cmd - strlen(cmd) - 1);
    char *s = run_capture(cmd);
    if (!s[0]) return s;
    int r = 0, g = 0, b = 0;                 /* zenity returns rgb(r,g,b) or rgba(...) */
    if (sscanf(s, "rgb(%d,%d,%d", &r, &g, &b) >= 3 || sscanf(s, "rgba(%d,%d,%d", &r, &g, &b) >= 3) {
        free(s); char *hex = malloc(8); snprintf(hex, 8, "#%02x%02x%02x", r & 255, g & 255, b & 255); return hex;
    }
    return s;   /* already #hex or other form */
#elif defined(UI_MACOS)
    (void)title;
    /* AppleScript `choose color` returns three 16-bit components */
    char *s = run_capture("osascript -e 'set c to choose color' "
                          "-e 'return (item 1 of c as text) & \",\" & (item 2 of c as text) & \",\" & (item 3 of c as text)' 2>/dev/null");
    int r = 0, g = 0, b = 0;
    if (sscanf(s, "%d,%d,%d", &r, &g, &b) == 3) {
        free(s); char *hex = malloc(8);
        snprintf(hex, 8, "#%02x%02x%02x", (r / 257) & 255, (g / 257) & 255, (b / 257) & 255);
        return hex;
    }
    return s;
#elif defined(UI_WINDOWS)
    (void)title;
    static COLORREF custom[16];
    CHOOSECOLOR cc; memset(&cc, 0, sizeof cc);
    cc.lStructSize = sizeof cc; cc.lpCustColors = custom; cc.Flags = CC_FULLOPEN | CC_RGBINIT;
    if (!ChooseColor(&cc)) return strdup("");
    char *hex = malloc(8);
    snprintf(hex, 8, "#%02x%02x%02x", GetRValue(cc.rgbResult), GetGValue(cc.rgbResult), GetBValue(cc.rgbResult));
    return hex;
#else
    (void)title; return strdup("");   /* mobile: reserved */
#endif
}
/* pick a date → "YYYY-MM-DD" ("" if cancelled) */
char *os_ui_pick_date(const char *title) {
#if defined(UI_LINUX)
    char cmd[1024] = "zenity --calendar --date-format=%Y-%m-%d --title=";
    sh_quote(cmd, sizeof cmd, title && *title ? title : "Pick a date");
    strncat(cmd, " 2>/dev/null", sizeof cmd - strlen(cmd) - 1);
    return run_capture(cmd);
#else
    (void)title; return strdup("");
#endif
}
/* choose one of `items` (newline-separated) → the chosen item ("" if cancelled) */
char *os_ui_pick_item(const char *title, const char *items) {
#if defined(UI_LINUX)
    char cmd[4096] = "zenity --list --hide-header --column= --title=";
    sh_quote(cmd, sizeof cmd, title && *title ? title : "Choose");
    char *copy = strdup(items ? items : "");
    for (char *tok = strtok(copy, "\n"); tok; tok = strtok(NULL, "\n")) {
        strncat(cmd, " ", sizeof cmd - strlen(cmd) - 1);
        sh_quote(cmd, sizeof cmd, tok);
    }
    free(copy);
    strncat(cmd, " 2>/dev/null", sizeof cmd - strlen(cmd) - 1);
    return run_capture(cmd);
#elif defined(UI_MACOS)
    char list[3072] = ""; char *copy = strdup(items ? items : ""); int first = 1;
    for (char *tok = strtok(copy, "\n"); tok; tok = strtok(NULL, "\n")) {
        if (!first) strncat(list, ",", sizeof list - strlen(list) - 1);
        strncat(list, "\"", sizeof list - strlen(list) - 1);
        strncat(list, tok, sizeof list - strlen(list) - 1);
        strncat(list, "\"", sizeof list - strlen(list) - 1);
        first = 0;
    }
    free(copy);
    char cmd[4096];
    snprintf(cmd, sizeof cmd, "osascript -e 'choose from list {%s} with prompt \"%s\"' 2>/dev/null",
             list, title && *title ? title : "Choose");
    char *r = run_capture(cmd);
    if (!strcmp(r, "false")) { free(r); return strdup(""); }   /* cancelled */
    return r;
#else
    (void)title; (void)items; return strdup("");
#endif
}
/* password entry (hidden input) → the text ("" if cancelled) */
char *os_ui_password(const char *title, const char *prompt) {
#if defined(UI_LINUX)
    char cmd[1024] = "zenity --password --title=";
    sh_quote(cmd, sizeof cmd, title && *title ? title : (prompt ? prompt : "Password"));
    strncat(cmd, " 2>/dev/null", sizeof cmd - strlen(cmd) - 1);
    return run_capture(cmd);
#elif defined(UI_MACOS)
    char cmd[2048];
    snprintf(cmd, sizeof cmd,
        "osascript -e 'text returned of (display dialog \"%s\" with title \"%s\" default answer \"\" with hidden answer)' 2>/dev/null",
        prompt ? prompt : "Password:", title && *title ? title : "Password");
    return run_capture(cmd);
#elif defined(UI_WINDOWS)
    return win_input(title, prompt, "", 1);
#else
    (void)title; (void)prompt; return strdup("");
#endif
}

char *os_ui_version(void) { return strdup("os_ui 1.1.0"); }
