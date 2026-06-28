/* ═══════════════════════════════════════════════════════════════
   os_permissions — central runtime-permission lib (extension of `os`).

   The ONE place permissions are requested. Other capability libs
   (os_gps, os_sensors, camera, …) do NOT each build a permission
   system — user code calls os_perm_request("location") here first.

   Platforms:
     android → JNI: Context.checkSelfPermission / Activity.requestPermissions
               (API 23+). The host app (e.g. swiss) must hand us the
               JavaVM + Activity via os_android_set_context().
     ios     → reserved (per-framework ObjC authorization APIs; needs Xcode)
     desktop → no runtime-permission model → everything reports "granted"

   This lib also owns the Android JNI bridge and EXPORTS it so sibling
   libs (os_gps, …) can reuse the same JavaVM/Context.
   Build: extends "os".
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
  #define PM_WINDOWS 1
#elif defined(__ANDROID__)
  #define PM_ANDROID 1
#elif defined(__APPLE__)
  #include <TargetConditionals.h>
  #if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
    #define PM_IOS 1
  #else
    #define PM_MACOS 1
  #endif
#else
  #define PM_LINUX 1
#endif

/* ─────────────────────────── android JNI bridge ─────────────────────────── */
#ifdef PM_ANDROID
#include <jni.h>
static JavaVM  *g_vm  = NULL;
static jobject  g_ctx = NULL;   /* global ref to the app Activity/Context */

/* the JVM calls this when the .so is loaded (System.loadLibrary) */
JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *reserved) { (void)reserved; g_vm = vm; return JNI_VERSION_1_6; }

/* the host app supplies its JNIEnv + Activity/Context once at startup */
void os_android_set_context(void *env_, void *ctx) {
    JNIEnv *env = (JNIEnv *)env_;
    if (!env) return;
    if (g_ctx) { (*env)->DeleteGlobalRef(env, g_ctx); g_ctx = NULL; }
    if (ctx)   g_ctx = (*env)->NewGlobalRef(env, (jobject)ctx);
}

/* Java-callable bridge so the host wires the Context with one line of Kotlin/Java:
     package org.ezylang.os
     object Bridge { external fun setContext(activity: Any) }
     // after System.loadLibrary("os_permissions"):
     Bridge.setContext(this)            // `this` = your Activity
*/
JNIEXPORT void JNICALL Java_org_ezylang_os_Bridge_setContext(JNIEnv *env, jclass clazz, jobject activity) {
    (void)clazz;
    os_android_set_context(env, activity);
}
/* exported for sibling libs (os_gps, …) to reuse the bridge */
void    *os_android_get_context(void) { return g_ctx; }
JavaVM  *os_android_get_vm(void)      { return g_vm; }
JNIEnv  *os_android_env(void) {
    JNIEnv *e = NULL;
    if (g_vm) (*g_vm)->AttachCurrentThread(g_vm, &e, NULL);
    return e;
}

/* friendly name → Android permission constant */
static const char *perm_to_android(const char *n) {
    if (!strcmp(n, "location"))      return "android.permission.ACCESS_FINE_LOCATION";
    if (!strcmp(n, "camera"))        return "android.permission.CAMERA";
    if (!strcmp(n, "microphone"))    return "android.permission.RECORD_AUDIO";
    if (!strcmp(n, "storage"))       return "android.permission.READ_EXTERNAL_STORAGE";
    if (!strcmp(n, "notifications")) return "android.permission.POST_NOTIFICATIONS";
    if (!strcmp(n, "contacts"))      return "android.permission.READ_CONTACTS";
    if (!strcmp(n, "activity"))      return "android.permission.ACTIVITY_RECOGNITION";
    if (!strcmp(n, "bluetooth"))     return "android.permission.BLUETOOTH_CONNECT";
    return n;   /* allow passing a full "android.permission.X" through */
}
static int android_check(const char *name) {
    JNIEnv *e = os_android_env(); if (!e || !g_ctx) return 0;
    jclass cls = (*e)->GetObjectClass(e, g_ctx);
    jmethodID mid = (*e)->GetMethodID(e, cls, "checkSelfPermission", "(Ljava/lang/String;)I");
    int granted = 0;
    if (mid) {
        jstring js = (*e)->NewStringUTF(e, perm_to_android(name));
        jint r = (*e)->CallIntMethod(e, g_ctx, mid, js);   /* PERMISSION_GRANTED == 0 */
        granted = (r == 0);
        (*e)->DeleteLocalRef(e, js);
    } else (*e)->ExceptionClear(e);
    (*e)->DeleteLocalRef(e, cls);
    return granted;
}
static void android_request(const char *name) {
    JNIEnv *e = os_android_env(); if (!e || !g_ctx) return;
    jclass cls = (*e)->GetObjectClass(e, g_ctx);
    jmethodID mid = (*e)->GetMethodID(e, cls, "requestPermissions", "([Ljava/lang/String;I)V");
    if (mid) {
        jclass scls = (*e)->FindClass(e, "java/lang/String");
        jstring js = (*e)->NewStringUTF(e, perm_to_android(name));
        jobjectArray arr = (*e)->NewObjectArray(e, 1, scls, js);
        (*e)->CallVoidMethod(e, g_ctx, mid, arr, 1);       /* async; result via Activity callback */
        (*e)->DeleteLocalRef(e, arr); (*e)->DeleteLocalRef(e, js); (*e)->DeleteLocalRef(e, scls);
    } else (*e)->ExceptionClear(e);
    (*e)->DeleteLocalRef(e, cls);
}
#endif

/* ═══════════════════════ public API ═══════════════════════ */

/* is the permission currently granted? 1/0 */
long long os_perm_check(const char *name) {
    if (!name) return 0;
#if defined(PM_ANDROID)
    return android_check(name);
#elif defined(PM_IOS)
    return 0;   /* reserved — needs per-framework ObjC authorization */
#else
    return 1;   /* desktop: no runtime-permission model */
#endif
}

/* request the permission (shows the system prompt on mobile). Returns the
   permission state right after asking — on Android the prompt is async, so
   re-check with os_perm_check() once the user has responded. */
long long os_perm_request(const char *name) {
    if (!name) return 0;
#if defined(PM_ANDROID)
    if (android_check(name)) return 1;
    android_request(name);
    return android_check(name);
#elif defined(PM_IOS)
    return 0;   /* reserved */
#else
    return 1;   /* desktop: granted */
#endif
}

/* "granted" / "denied" / "unsupported" */
char *os_perm_status(const char *name) {
#if defined(PM_ANDROID)
    return strdup(android_check(name) ? "granted" : "denied");
#elif defined(PM_IOS)
    (void)name; return strdup("unsupported");
#else
    (void)name; return strdup("granted");
#endif
}

#ifndef PM_ANDROID
/* no-op shims so code/host that calls these still links on non-Android */
void os_android_set_context(void *env, void *ctx) { (void)env; (void)ctx; }
#endif

char *os_permissions_version(void) { return strdup("os_permissions 1.0.0"); }
