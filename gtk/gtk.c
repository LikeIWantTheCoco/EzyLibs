/* ═══════════════════════════════════════════════════════════════
   gtk — easy GTK3 desktop UI for Ezy.

   Every GTK object is handed back to Ezy as an opaque integer handle
   (a pointer stored in a long long). Widgets are created, packed into
   containers, wired to callbacks, and shown — no GObject bookkeeping
   leaks into Ezy code.

       win = gtk_app("Hello", 320, 120)   # init + top-level window
       lbl = gtk_label("Hi there")
       gtk_add(win, lbl)
       gtk_run(win)                        # show all + event loop

   Signal callbacks are plain Ezy functions (passed as fn values). GTK
   invokes them with extra arguments which Ezy callbacks simply ignore.

   Build: gcc -shared -fPIC gtk.c -o libezygtk.so $(pkg-config --cflags --libs gtk+-3.0)
   ═══════════════════════════════════════════════════════════════ */
#include <gtk/gtk.h>
#include <string.h>

#define W(h)  ((GtkWidget *)(size_t)(h))
#define WIN(h) (GTK_WINDOW((void *)(size_t)(h)))

/* ── lifecycle ── */
long long gtk_app_init(void) { gtk_init(NULL, NULL); return 0; }

long long gtk_window(const char *title, long long w, long long h) {
    GtkWidget *win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    if (title) gtk_window_set_title(GTK_WINDOW(win), title);
    gtk_window_set_default_size(GTK_WINDOW(win), (int)w, (int)h);
    gtk_window_set_position(GTK_WINDOW(win), GTK_WIN_POS_CENTER);
    /* closing the window ends the event loop */
    g_signal_connect(win, "destroy", G_CALLBACK(gtk_main_quit), NULL);
    return (long long)(size_t)win;
}

/* init + a ready-to-use top-level window in one call */
long long gtk_app(const char *title, long long w, long long h) {
    gtk_init(NULL, NULL);
    return gtk_window(title, w, h);
}

long long gtk_run(long long win)  { gtk_widget_show_all(W(win)); gtk_main(); return 0; }
long long gtk_quit(void)          { gtk_main_quit(); return 0; }
long long gtk_show(long long w)   { gtk_widget_show_all(W(w)); return 0; }
long long gtk_hide(long long w)   { gtk_widget_hide(W(w)); return 0; }

/* ── widgets (return handles) ── */
long long gtk_label(const char *t)  { return (long long)(size_t)gtk_label_new(t ? t : ""); }
long long gtk_button(const char *t) { return (long long)(size_t)gtk_button_new_with_label(t ? t : ""); }
long long gtk_entry(void)           { return (long long)(size_t)gtk_entry_new(); }
long long gtk_check(const char *t)  { return (long long)(size_t)gtk_check_button_new_with_label(t ? t : ""); }
long long gtk_image(const char *path){ return (long long)(size_t)gtk_image_new_from_file(path ? path : ""); }

/* ── layout containers ── */
long long gtk_vbox(long long spacing) {
    return (long long)(size_t)gtk_box_new(GTK_ORIENTATION_VERTICAL, (int)spacing);
}
long long gtk_hbox(long long spacing) {
    return (long long)(size_t)gtk_box_new(GTK_ORIENTATION_HORIZONTAL, (int)spacing);
}
long long gtk_grid(void) { return (long long)(size_t)gtk_grid_new(); }

long long gtk_add(long long container, long long child) {
    gtk_container_add(GTK_CONTAINER((void *)(size_t)container), W(child));
    return 0;
}
/* pack into a box; expand!=0 lets the child grow with the box */
long long gtk_pack(long long box, long long child, long long expand, long long padding) {
    gtk_box_pack_start(GTK_BOX((void *)(size_t)box), W(child),
                       expand ? TRUE : FALSE, expand ? TRUE : FALSE, (guint)padding);
    return 0;
}
long long gtk_attach(long long grid, long long child, long long col, long long row,
                     long long wspan, long long hspan) {
    gtk_grid_attach(GTK_GRID((void *)(size_t)grid), W(child),
                    (int)col, (int)row, (int)(wspan > 0 ? wspan : 1), (int)(hspan > 0 ? hspan : 1));
    return 0;
}
long long gtk_margin(long long w, long long m) {
    gtk_widget_set_margin_start(W(w), (int)m);  gtk_widget_set_margin_end(W(w), (int)m);
    gtk_widget_set_margin_top(W(w), (int)m);    gtk_widget_set_margin_bottom(W(w), (int)m);
    return 0;
}

/* ── signals: connect an Ezy fn value (a C function pointer) ── */
long long gtk_on(long long widget, const char *signal, long long cb) {
    if (cb) g_signal_connect(W(widget), signal ? signal : "clicked",
                             G_CALLBACK((void *)(size_t)cb), NULL);
    return 0;
}

/* ── text get/set: works on label / entry / button ── */
long long gtk_set_text(long long w, const char *t) {
    GtkWidget *x = W(w);
    if (!t) t = "";
    if (GTK_IS_LABEL(x))       gtk_label_set_text(GTK_LABEL(x), t);
    else if (GTK_IS_ENTRY(x))  gtk_entry_set_text(GTK_ENTRY(x), t);
    else if (GTK_IS_BUTTON(x)) gtk_button_set_label(GTK_BUTTON(x), t);
    return 0;
}
char *gtk_get_text(long long w) {
    GtkWidget *x = W(w);
    const char *s = "";
    if (GTK_IS_ENTRY(x))       s = gtk_entry_get_text(GTK_ENTRY(x));
    else if (GTK_IS_LABEL(x))  s = gtk_label_get_text(GTK_LABEL(x));
    else if (GTK_IS_BUTTON(x)) s = gtk_button_get_label(GTK_BUTTON(x));
    return strdup(s ? s : "");
}

/* checkbox state */
long long gtk_is_checked(long long w) {
    return gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(W(w))) ? 1 : 0;
}

long long gtk_title(long long win, const char *t) {
    gtk_window_set_title(WIN(win), t ? t : "");
    return 0;
}

/* ── modal message dialog ── */
long long gtk_dialog(long long parent, const char *title, const char *msg) {
    GtkWidget *d = gtk_message_dialog_new(parent ? WIN(parent) : NULL,
                                          GTK_DIALOG_MODAL, GTK_MESSAGE_INFO,
                                          GTK_BUTTONS_OK, "%s", msg ? msg : "");
    if (title) gtk_window_set_title(GTK_WINDOW(d), title);
    gtk_dialog_run(GTK_DIALOG(d));
    gtk_widget_destroy(d);
    return 0;
}
