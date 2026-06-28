/* ═══════════════════════════════════════════════════════════════
   os_tray — system tray icon with a menu (extension of `os`).

   Stateful + needs an event loop, so the API is:
     os_tray_init(icon, tooltip)
     os_tray_add_item(label, callback)   # callback is an Ezy `fn()`
     os_tray_set_tooltip(text)
     os_tray_run()        # blocking — pumps events, fires callbacks
     os_tray_quit()       # stop the loop (call from a callback)

   Backends:
     linux  → GTK3 GtkStatusIcon + gtk_main
     windows→ Shell_NotifyIcon + a hidden window + message loop
     macos  → reserved (NSStatusItem needs Objective-C/Cocoa)
   Mobile (android/ios) reserved.
   Build: extends "os".
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
  #define TR_WINDOWS 1
#elif defined(__ANDROID__)
  #define TR_ANDROID 1
#elif defined(__APPLE__)
  #include <TargetConditionals.h>
  #if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
    #define TR_IOS 1
  #else
    #define TR_MACOS 1
  #endif
#else
  #define TR_LINUX 1
#endif

#define TRAY_MAX 64
typedef void (*tray_cb)(void);
static tray_cb g_cb[TRAY_MAX];
static int g_nit = 0;
static int g_inited = 0;

/* ─────────────────────────── linux (GTK3) ─────────────────────────── */
#if defined(TR_LINUX)
#include <gtk/gtk.h>
static GtkStatusIcon *g_icon;
static GtkWidget *g_menu;

static void on_item(GtkMenuItem *mi, gpointer idx) {
    (void)mi; long i = (long)idx;
    if (i >= 0 && i < g_nit && g_cb[i]) g_cb[i]();
}
static void on_popup(GtkStatusIcon *si, guint button, guint t, gpointer menu) {
    (void)si; (void)button; (void)t;
    gtk_menu_popup_at_pointer(GTK_MENU(menu), NULL);
}

long long os_tray_init(const char *icon, const char *tooltip) {
    if (g_inited) return 1;
    if (!gtk_init_check(NULL, NULL)) return 0;
    if (icon && strchr(icon, '/')) g_icon = gtk_status_icon_new_from_file(icon);
    else g_icon = gtk_status_icon_new_from_icon_name(icon && *icon ? icon : "application-x-executable");
    if (tooltip && *tooltip) gtk_status_icon_set_tooltip_text(g_icon, tooltip);
    g_menu = gtk_menu_new();
    g_signal_connect(g_icon, "popup-menu", G_CALLBACK(on_popup), g_menu);
    g_signal_connect(g_icon, "activate",   G_CALLBACK(on_popup), g_menu);  /* left-click too */
    gtk_status_icon_set_visible(g_icon, TRUE);
    g_inited = 1;
    return 1;
}
long long os_tray_add_item(const char *label, tray_cb cb) {
    if (!g_inited || g_nit >= TRAY_MAX) return 0;
    GtkWidget *mi = gtk_menu_item_new_with_label(label ? label : "");
    g_cb[g_nit] = cb;
    g_signal_connect(mi, "activate", G_CALLBACK(on_item), (gpointer)(long)g_nit);
    gtk_menu_shell_append(GTK_MENU_SHELL(g_menu), mi);
    gtk_widget_show(mi);
    g_nit++;
    return 1;
}
long long os_tray_set_tooltip(const char *t) {
    if (!g_inited) return 0;
    gtk_status_icon_set_tooltip_text(g_icon, t ? t : "");
    return 1;
}
long long os_tray_run(void)  { if (!g_inited) return 0; gtk_main(); return 1; }
long long os_tray_quit(void) { if (!g_inited) return 0; gtk_main_quit(); return 1; }

/* ─────────────────────────── windows ─────────────────────────── */
#elif defined(TR_WINDOWS)
#include <windows.h>
#include <shellapi.h>
#define WM_EZYTRAY (WM_USER + 1)
static HWND g_hwnd;
static NOTIFYICONDATA g_nid;
static HMENU g_menu;

static LRESULT CALLBACK tray_wndproc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_EZYTRAY && (l == WM_RBUTTONUP || l == WM_LBUTTONUP)) {
        POINT p; GetCursorPos(&p); SetForegroundWindow(h);
        int cmd = TrackPopupMenu(g_menu, TPM_RETURNCMD | TPM_NONOTIFY, p.x, p.y, 0, h, NULL);
        if (cmd > 0 && cmd <= g_nit && g_cb[cmd - 1]) g_cb[cmd - 1]();
        return 0;
    }
    if (m == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProc(h, m, w, l);
}
long long os_tray_init(const char *icon, const char *tooltip) {
    if (g_inited) return 1;
    (void)icon;
    WNDCLASS wc; memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = tray_wndproc; wc.hInstance = GetModuleHandle(NULL); wc.lpszClassName = "EzyTrayWnd";
    RegisterClass(&wc);
    g_hwnd = CreateWindow("EzyTrayWnd", "", 0, 0, 0, 0, 0, HWND_MESSAGE, NULL, wc.hInstance, NULL);
    memset(&g_nid, 0, sizeof g_nid);
    g_nid.cbSize = sizeof g_nid; g_nid.hWnd = g_hwnd; g_nid.uID = 1;
    g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP; g_nid.uCallbackMessage = WM_EZYTRAY;
    g_nid.hIcon = LoadIcon(NULL, IDI_APPLICATION);
    if (tooltip) { strncpy(g_nid.szTip, tooltip, sizeof g_nid.szTip - 1); }
    Shell_NotifyIcon(NIM_ADD, &g_nid);
    g_menu = CreatePopupMenu();
    g_inited = 1;
    return 1;
}
long long os_tray_add_item(const char *label, tray_cb cb) {
    if (!g_inited || g_nit >= TRAY_MAX) return 0;
    AppendMenu(g_menu, MF_STRING, g_nit + 1, label ? label : "");
    g_cb[g_nit] = cb; g_nit++;
    return 1;
}
long long os_tray_set_tooltip(const char *t) {
    if (!g_inited) return 0;
    strncpy(g_nid.szTip, t ? t : "", sizeof g_nid.szTip - 1);
    g_nid.uFlags = NIF_TIP; Shell_NotifyIcon(NIM_MODIFY, &g_nid);
    return 1;
}
long long os_tray_run(void) {
    if (!g_inited) return 0;
    MSG m; while (GetMessage(&m, NULL, 0, 0)) { TranslateMessage(&m); DispatchMessage(&m); }
    Shell_NotifyIcon(NIM_DELETE, &g_nid);
    return 1;
}
long long os_tray_quit(void) { if (g_inited) PostMessage(g_hwnd, WM_DESTROY, 0, 0); return 1; }

/* ─────────────────────────── macos / mobile (reserved) ─────────────────────────── */
#else
long long os_tray_init(const char *icon, const char *tooltip) { (void)icon; (void)tooltip; return 0; }
long long os_tray_add_item(const char *label, tray_cb cb) { (void)label; (void)cb; return 0; }
long long os_tray_set_tooltip(const char *t) { (void)t; return 0; }
long long os_tray_run(void)  { return 0; }
long long os_tray_quit(void) { return 0; }
#endif

char *os_tray_version(void) { return strdup("os_tray 1.0.0"); }
