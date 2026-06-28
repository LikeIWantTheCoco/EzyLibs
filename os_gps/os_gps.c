/* ═══════════════════════════════════════════════════════════════
   os_gps — device location for Ezy (extension of `os`).

     android → JNI: Context.getSystemService("location") →
               LocationManager.getLastKnownLocation(provider). Needs the
               app Context (provided by the host via os_permissions'
               os_android_set_context) AND the "location" permission, which
               user code requests through os_permissions FIRST.
     ios     → reserved (CoreLocation / CLLocationManager, ObjC; needs Xcode)
     desktop → reserved (no GPS) → unavailable

   Depends on os_permissions: reuses its JNI bridge and the permission gate.
   Build: extends "os", dependencies ["os_permissions"].
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(__ANDROID__)
  #define GP_ANDROID 1
#elif defined(_WIN32)
  #define GP_WINDOWS 1
#elif defined(__APPLE__)
  #include <TargetConditionals.h>
  #if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
    #define GP_IOS 1
  #else
    #define GP_MACOS 1
  #endif
#else
  #define GP_LINUX 1
#endif

#ifdef GP_ANDROID
#include <jni.h>
/* provided by libos_permissions.so (this lib depends on it) */
extern JNIEnv  *os_android_env(void);
extern void    *os_android_get_context(void);
extern long long os_perm_check(const char *name);

/* read the last known location into lat/lon; 1 on success */
static int gps_last(double *lat, double *lon) {
    if (!os_perm_check("location")) return 0;          /* permission gate */
    JNIEnv *e = os_android_env();
    jobject ctx = (jobject)os_android_get_context();
    if (!e || !ctx) return 0;

    jclass ctxcls = (*e)->GetObjectClass(e, ctx);
    jmethodID gss = (*e)->GetMethodID(e, ctxcls, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;");
    if (!gss) { (*e)->ExceptionClear(e); (*e)->DeleteLocalRef(e, ctxcls); return 0; }
    jstring svc = (*e)->NewStringUTF(e, "location");
    jobject lm = (*e)->CallObjectMethod(e, ctx, gss, svc);
    (*e)->DeleteLocalRef(e, svc); (*e)->DeleteLocalRef(e, ctxcls);
    if (!lm) return 0;

    jclass lmcls = (*e)->GetObjectClass(e, lm);
    jmethodID glk = (*e)->GetMethodID(e, lmcls, "getLastKnownLocation", "(Ljava/lang/String;)Landroid/location/Location;");
    int ok = 0;
    if (glk) {
        const char *providers[] = { "gps", "fused", "network", "passive" };
        for (int i = 0; i < 4 && !ok; i++) {
            jstring p = (*e)->NewStringUTF(e, providers[i]);
            jobject loc = (*e)->CallObjectMethod(e, lm, glk, p);
            (*e)->DeleteLocalRef(e, p);
            if ((*e)->ExceptionCheck(e)) { (*e)->ExceptionClear(e); continue; }   /* provider not enabled */
            if (loc) {
                jclass lc = (*e)->GetObjectClass(e, loc);
                jmethodID gla = (*e)->GetMethodID(e, lc, "getLatitude",  "()D");
                jmethodID glo = (*e)->GetMethodID(e, lc, "getLongitude", "()D");
                if (gla && glo) { *lat = (*e)->CallDoubleMethod(e, loc, gla); *lon = (*e)->CallDoubleMethod(e, loc, glo); ok = 1; }
                (*e)->DeleteLocalRef(e, lc); (*e)->DeleteLocalRef(e, loc);
            }
        }
    } else (*e)->ExceptionClear(e);
    (*e)->DeleteLocalRef(e, lmcls); (*e)->DeleteLocalRef(e, lm);
    return ok;
}
#endif

/* is a location fix currently obtainable? (android + permission + provider) */
long long os_gps_available(void) {
#ifdef GP_ANDROID
    double a, b; return gps_last(&a, &b) ? 1 : 0;
#else
    return 0;
#endif
}

double os_gps_lat(void) {
#ifdef GP_ANDROID
    double lat = 0, lon = 0; gps_last(&lat, &lon); return lat;
#else
    return 0;
#endif
}
double os_gps_lon(void) {
#ifdef GP_ANDROID
    double lat = 0, lon = 0; gps_last(&lat, &lon); return lon;
#else
    return 0;
#endif
}
/* "lat,lon" or "" if unavailable */
char *os_gps_location(void) {
#ifdef GP_ANDROID
    double lat = 0, lon = 0;
    if (!gps_last(&lat, &lon)) return strdup("");
    char b[64]; snprintf(b, sizeof b, "%.7f,%.7f", lat, lon); return strdup(b);
#else
    return strdup("");   /* desktop/ios reserved */
#endif
}

char *os_gps_version(void) { return strdup("os_gps 1.0.0"); }
