/* ═══════════════════════════════════════════════════════════════
   os_sensors — motion sensors (accelerometer / gyroscope) for Ezy.

     android → NDK native ASensorManager (<android/sensor.h>), pure C,
               no JNI/Context needed (-landroid). Accelerometer & gyro
               need no runtime permission; step/activity does → request it
               via os_permissions first.
     ios     → reserved (CoreMotion / CMMotionManager, ObjC; needs Xcode)
     desktop → reserved (no motion sensors) → 0 / unavailable

   Pull model: each getter pumps queued events and returns the latest value.
   Build: extends "os".
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(__ANDROID__)
  #define SN_ANDROID 1
#elif defined(_WIN32)
  #define SN_WINDOWS 1
#elif defined(__APPLE__)
  #include <TargetConditionals.h>
  #if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
    #define SN_IOS 1
  #else
    #define SN_MACOS 1
  #endif
#else
  #define SN_LINUX 1
#endif

#ifdef SN_ANDROID
#include <android/sensor.h>
#include <android/looper.h>
static ASensorManager   *g_mgr = NULL;
static ASensorEventQueue *g_q   = NULL;
static const ASensor *g_accel = NULL, *g_gyro = NULL, *g_step = NULL;
static double g_ax, g_ay, g_az, g_gx, g_gy, g_gz;
static long long g_steps = -1;
static int g_inited = 0;

#ifndef ASENSOR_TYPE_STEP_COUNTER
#define ASENSOR_TYPE_STEP_COUNTER 19
#endif

static int sn_init(void) {
    if (g_inited) return g_mgr != NULL;
    g_inited = 1;
#if __ANDROID_API__ >= 26
    g_mgr = ASensorManager_getInstanceForPackage("org.ezylang.app");
#else
    g_mgr = ASensorManager_getInstance();
#endif
    if (!g_mgr) return 0;
    ALooper *looper = ALooper_prepare(ALOOPER_PREPARE_ALLOW_NON_CALLBACKS);
    g_q = ASensorManager_createEventQueue(g_mgr, looper, 3, NULL, NULL);
    g_accel = ASensorManager_getDefaultSensor(g_mgr, ASENSOR_TYPE_ACCELEROMETER);
    g_gyro  = ASensorManager_getDefaultSensor(g_mgr, ASENSOR_TYPE_GYROSCOPE);
    g_step  = ASensorManager_getDefaultSensor(g_mgr, ASENSOR_TYPE_STEP_COUNTER);
    if (g_accel) { ASensorEventQueue_enableSensor(g_q, g_accel); ASensorEventQueue_setEventRate(g_q, g_accel, 50000); }
    if (g_gyro)  { ASensorEventQueue_enableSensor(g_q, g_gyro);  ASensorEventQueue_setEventRate(g_q, g_gyro, 50000); }
    if (g_step)  { ASensorEventQueue_enableSensor(g_q, g_step); }   /* on-change; needs ACTIVITY_RECOGNITION (API29+) */
    return 1;
}
static void sn_pump(void) {
    if (!g_q) return;
    ASensorEvent e;
    while (ASensorEventQueue_getEvents(g_q, &e, 1) > 0) {
        if (e.type == ASENSOR_TYPE_ACCELEROMETER) { g_ax = e.data[0]; g_ay = e.data[1]; g_az = e.data[2]; }
        else if (e.type == ASENSOR_TYPE_GYROSCOPE) { g_gx = e.data[0]; g_gy = e.data[1]; g_gz = e.data[2]; }
        else if (e.type == ASENSOR_TYPE_STEP_COUNTER) { g_steps = (long long)e.data[0]; }
    }
}
#endif

/* 1 if motion sensors are available */
long long os_sensors_available(void) {
#ifdef SN_ANDROID
    return sn_init() ? 1 : 0;
#else
    return 0;   /* desktop/ios reserved */
#endif
}

/* accelerometer (m/s^2) */
double os_accel_x(void) {
#ifdef SN_ANDROID
    if (!sn_init()) return 0; sn_pump(); return g_ax;
#else
    return 0;
#endif
}
double os_accel_y(void) {
#ifdef SN_ANDROID
    if (!sn_init()) return 0; sn_pump(); return g_ay;
#else
    return 0;
#endif
}
double os_accel_z(void) {
#ifdef SN_ANDROID
    if (!sn_init()) return 0; sn_pump(); return g_az;
#else
    return 0;
#endif
}
/* gyroscope (rad/s) */
double os_gyro_x(void) {
#ifdef SN_ANDROID
    if (!sn_init()) return 0; sn_pump(); return g_gx;
#else
    return 0;
#endif
}
double os_gyro_y(void) {
#ifdef SN_ANDROID
    if (!sn_init()) return 0; sn_pump(); return g_gy;
#else
    return 0;
#endif
}
double os_gyro_z(void) {
#ifdef SN_ANDROID
    if (!sn_init()) return 0; sn_pump(); return g_gz;
#else
    return 0;
#endif
}

/* cumulative step count since boot, or -1 if unavailable.
   Needs the "activity" permission (ACTIVITY_RECOGNITION) on Android 10+;
   request it via os_permissions first. */
long long os_steps(void) {
#ifdef SN_ANDROID
    if (!sn_init()) return -1; sn_pump(); return g_steps;
#else
    return -1;
#endif
}

char *os_sensors_version(void) { return strdup("os_sensors 1.1.0"); }
