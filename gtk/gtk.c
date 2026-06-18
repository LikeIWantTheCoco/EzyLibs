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

/* ═══════════════════════════════════════════════════════════════
   Extended widgets
   ═══════════════════════════════════════════════════════════════ */

/* scrolled window — add ONE child (e.g. a box or text view) with gtk_add;
   scrollbars appear automatically when the content overflows */
long long gtk_scrolled(void) {
    GtkWidget *sw = gtk_scrolled_window_new(NULL, NULL);
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(sw),
                                   GTK_POLICY_AUTOMATIC, GTK_POLICY_AUTOMATIC);
    return (long long)(size_t)sw;
}

/* multi-line text area */
long long gtk_textview(void) { return (long long)(size_t)gtk_text_view_new(); }
long long gtk_tv_set_text(long long w, const char *t) {
    GtkTextBuffer *b = gtk_text_view_get_buffer(GTK_TEXT_VIEW(W(w)));
    gtk_text_buffer_set_text(b, t ? t : "", -1);
    return 0;
}
char *gtk_tv_get_text(long long w) {
    GtkTextBuffer *b = gtk_text_view_get_buffer(GTK_TEXT_VIEW(W(w)));
    GtkTextIter s, e;
    gtk_text_buffer_get_bounds(b, &s, &e);
    char *txt = gtk_text_buffer_get_text(b, &s, &e, FALSE);
    char *r = strdup(txt ? txt : "");
    g_free(txt);
    return r;
}

/* dropdown (combo box of text) */
long long gtk_combo(void)              { return (long long)(size_t)gtk_combo_box_text_new(); }
long long gtk_combo_add(long long c, const char *t) {
    gtk_combo_box_text_append_text(GTK_COMBO_BOX_TEXT(W(c)), t ? t : "");
    return 0;
}
long long gtk_combo_index(long long c) { return gtk_combo_box_get_active(GTK_COMBO_BOX(W(c))); }
long long gtk_combo_select(long long c, long long i) {
    gtk_combo_box_set_active(GTK_COMBO_BOX(W(c)), (int)i); return 0;
}
char *gtk_combo_text(long long c) {
    char *t = gtk_combo_box_text_get_active_text(GTK_COMBO_BOX_TEXT(W(c)));
    char *r = strdup(t ? t : "");
    g_free(t);
    return r;
}

/* numeric spin button */
long long gtk_spin(long long min, long long max, long long step) {
    return (long long)(size_t)gtk_spin_button_new_with_range((double)min, (double)max,
                                                             (double)(step > 0 ? step : 1));
}
long long gtk_spin_get(long long w) { return (long long)gtk_spin_button_get_value(GTK_SPIN_BUTTON(W(w))); }
long long gtk_spin_set(long long w, long long v) {
    gtk_spin_button_set_value(GTK_SPIN_BUTTON(W(w)), (double)v); return 0;
}

/* horizontal slider (scale) */
long long gtk_slider(long long min, long long max, long long step) {
    GtkWidget *s = gtk_scale_new_with_range(GTK_ORIENTATION_HORIZONTAL,
                                            (double)min, (double)max, (double)(step > 0 ? step : 1));
    return (long long)(size_t)s;
}
long long gtk_slider_get(long long w) { return (long long)gtk_range_get_value(GTK_RANGE(W(w))); }
long long gtk_slider_set(long long w, long long v) {
    gtk_range_set_value(GTK_RANGE(W(w)), (double)v); return 0;
}

/* progress bar — value is a 0..100 percentage */
long long gtk_progressbar(void) { return (long long)(size_t)gtk_progress_bar_new(); }
long long gtk_progressbar_set(long long w, long long percent) {
    if (percent < 0) percent = 0; if (percent > 100) percent = 100;
    gtk_progress_bar_set_fraction(GTK_PROGRESS_BAR(W(w)), (double)percent / 100.0);
    return 0;
}

/* radio button — group=0 starts a new group; pass the first radio's handle
   as `group` for the rest so they toggle together */
long long gtk_radio(long long group, const char *t) {
    GtkWidget *r = gtk_radio_button_new_with_label_from_widget(
        group ? GTK_RADIO_BUTTON(W(group)) : NULL, t ? t : "");
    return (long long)(size_t)r;
}
/* toggle button (checked()/gtk_is_checked work on it) */
long long gtk_toggle(const char *t) {
    return (long long)(size_t)gtk_toggle_button_new_with_label(t ? t : "");
}
long long gtk_set_checked(long long w, long long on) {
    gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(W(w)), on ? TRUE : FALSE); return 0;
}

/* labeled frame, separator */
long long gtk_frame(const char *label) { return (long long)(size_t)gtk_frame_new(label && *label ? label : NULL); }
long long gtk_separator(long long horizontal) {
    return (long long)(size_t)gtk_separator_new(horizontal ? GTK_ORIENTATION_HORIZONTAL
                                                           : GTK_ORIENTATION_VERTICAL);
}

/* tabbed notebook */
long long gtk_notebook(void) { return (long long)(size_t)gtk_notebook_new(); }
long long gtk_notebook_add(long long nb, long long child, const char *tab) {
    gtk_notebook_append_page(GTK_NOTEBOOK(W(nb)), W(child), gtk_label_new(tab ? tab : ""));
    return 0;
}

/* spinner (busy indicator) */
long long gtk_spinner(void)            { return (long long)(size_t)gtk_spinner_new(); }
long long gtk_spinner_run(long long w) { gtk_spinner_start(GTK_SPINNER(W(w))); return 0; }
long long gtk_spinner_halt(long long w){ gtk_spinner_stop(GTK_SPINNER(W(w))); return 0; }

/* file chooser dialogs — return the chosen path, or "" if cancelled */
static char *file_chooser(long long parent, const char *title, GtkFileChooserAction action,
                          const char *ok_label) {
    GtkWidget *d = gtk_file_chooser_dialog_new(
        title ? title : "Select file", parent ? WIN(parent) : NULL, action,
        "_Cancel", GTK_RESPONSE_CANCEL, ok_label, GTK_RESPONSE_ACCEPT, NULL);
    char *r = strdup("");
    if (gtk_dialog_run(GTK_DIALOG(d)) == GTK_RESPONSE_ACCEPT) {
        char *path = gtk_file_chooser_get_filename(GTK_FILE_CHOOSER(d));
        if (path) { free(r); r = strdup(path); g_free(path); }
    }
    gtk_widget_destroy(d);
    return r;
}
char *gtk_file_open(long long parent, const char *title) {
    return file_chooser(parent, title, GTK_FILE_CHOOSER_ACTION_OPEN, "_Open");
}
char *gtk_file_save(long long parent, const char *title) {
    return file_chooser(parent, title, GTK_FILE_CHOOSER_ACTION_SAVE, "_Save");
}

/* ═══════════════════════════════════════════════════════════════
   Widget / window properties
   ═══════════════════════════════════════════════════════════════ */
long long gtk_set_sensitive(long long w, long long on) { gtk_widget_set_sensitive(W(w), on ? TRUE : FALSE); return 0; }
long long gtk_set_visible(long long w, long long on)   { gtk_widget_set_visible(W(w), on ? TRUE : FALSE); return 0; }
long long gtk_set_tooltip(long long w, const char *t)  { gtk_widget_set_tooltip_text(W(w), t ? t : ""); return 0; }
long long gtk_set_size(long long w, long long width, long long height) {
    gtk_widget_set_size_request(W(w), (int)width, (int)height); return 0;
}
long long gtk_set_expand(long long w, long long h, long long v) {
    gtk_widget_set_hexpand(W(w), h ? TRUE : FALSE);
    gtk_widget_set_vexpand(W(w), v ? TRUE : FALSE);
    return 0;
}
long long gtk_set_name(long long w, const char *name) { gtk_widget_set_name(W(w), name ? name : ""); return 0; }
long long gtk_border(long long container, long long px) {
    gtk_container_set_border_width(GTK_CONTAINER((void *)(size_t)container), (guint)px); return 0;
}
long long gtk_resizable(long long win, long long on) { gtk_window_set_resizable(WIN(win), on ? TRUE : FALSE); return 0; }
long long gtk_fullscreen(long long win)              { gtk_window_fullscreen(WIN(win)); return 0; }

/* entry tweaks */
long long gtk_entry_placeholder(long long e, const char *t) {
    gtk_entry_set_placeholder_text(GTK_ENTRY(W(e)), t ? t : ""); return 0;
}
long long gtk_entry_password(long long e, long long on) {
    gtk_entry_set_visibility(GTK_ENTRY(W(e)), on ? FALSE : TRUE); return 0;
}

/* label tweaks */
long long gtk_label_markup(long long l, const char *m) { gtk_label_set_markup(GTK_LABEL(W(l)), m ? m : ""); return 0; }
long long gtk_label_wrap(long long l, long long on)    { gtk_label_set_line_wrap(GTK_LABEL(W(l)), on ? TRUE : FALSE); return 0; }

/* repeating timer: calls cb every `ms` milliseconds; cb returns 1 to keep
   firing, 0 to stop. Useful for progress/animation. */
long long gtk_timeout(long long ms, long long cb) {
    if (cb) return (long long)g_timeout_add((guint)ms, (GSourceFunc)(void *)(size_t)cb, NULL);
    return 0;
}

/* load CSS for the whole app; target widgets by name (#name) or type */
long long gtk_css(const char *css) {
    if (!css) return 0;
    GtkCssProvider *p = gtk_css_provider_new();
    gtk_css_provider_load_from_data(p, css, -1, NULL);
    gtk_style_context_add_provider_for_screen(
        gdk_screen_get_default(), GTK_STYLE_PROVIDER(p),
        GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
    g_object_unref(p);
    return 0;
}
