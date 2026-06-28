/* ═══════════════════════════════════════════════════════════════
   os_audio — master output volume / mute (extension of `os`).

   Backends:
     linux  → pactl (PulseAudio/PipeWire), fallback wpctl
     macos  → osascript (get/set volume settings)
     windows→ TODO (IAudioEndpointVolume / COM); returns -1/0 for now
   Mobile (android/ios) reserved.
   Build: extends "os".
   ═══════════════════════════════════════════════════════════════ */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
  #define AU_WINDOWS 1
#elif defined(__ANDROID__)
  #define AU_ANDROID 1
#elif defined(__APPLE__)
  #include <TargetConditionals.h>
  #if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
    #define AU_IOS 1
  #else
    #define AU_MACOS 1
  #endif
#else
  #define AU_LINUX 1
#endif

#ifdef AU_WINDOWS
#define COBJMACROS
#include <initguid.h>
#include <mmdeviceapi.h>
#include <endpointvolume.h>
/* default render endpoint's volume control, or NULL (caller releases + CoUninitialize) */
static IAudioEndpointVolume *au_endpoint(void) {
    IMMDeviceEnumerator *en = NULL; IMMDevice *dev = NULL; IAudioEndpointVolume *vol = NULL;
    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    if (FAILED(CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL,
                                &IID_IMMDeviceEnumerator, (void **)&en))) return NULL;
    if (SUCCEEDED(IMMDeviceEnumerator_GetDefaultAudioEndpoint(en, eRender, eConsole, &dev)))
        IMMDevice_Activate(dev, &IID_IAudioEndpointVolume, CLSCTX_ALL, NULL, (void **)&vol);
    if (dev) IMMDevice_Release(dev);
    IMMDeviceEnumerator_Release(en);
    return vol;
}
#endif

#if defined(AU_LINUX) || defined(AU_MACOS)
static int have(const char *bin) {
    char c[128]; snprintf(c, sizeof c, "command -v %s >/dev/null 2>&1", bin);
    return system(c) == 0;
}
static char *run_capture(const char *cmd) {
    FILE *p = popen(cmd, "r"); if (!p) return strdup("");
    size_t cap = 1024, len = 0; char *b = malloc(cap); size_t n; char t[1024];
    while ((n = fread(t, 1, sizeof t, p)) > 0) { if (len+n+1>cap){while(len+n+1>cap)cap*=2;b=realloc(b,cap);} memcpy(b+len,t,n); len+=n; }
    pclose(p); b[len] = 0; return b;
}
#endif

/* master output volume 0-100, or -1 if unknown */
long long os_volume_get(void) {
#if defined(AU_LINUX)
    if (have("pactl")) {
        char *s = run_capture("pactl get-sink-volume @DEFAULT_SINK@ 2>/dev/null");
        char *pc = strchr(s, '%'); long long v = -1;
        if (pc) { char *q = pc; while (q > s && q[-1] >= '0' && q[-1] <= '9') q--; v = atoll(q); }
        free(s); return v;
    }
    if (have("wpctl")) {
        char *s = run_capture("wpctl get-volume @DEFAULT_AUDIO_SINK@ 2>/dev/null"); /* "Volume: 0.15" */
        double f = 0; char *c = strchr(s, ':'); long long v = -1;
        if (c && sscanf(c + 1, "%lf", &f) == 1) v = (long long)(f * 100 + 0.5);
        free(s); return v;
    }
    return -1;
#elif defined(AU_MACOS)
    char *s = run_capture("osascript -e 'output volume of (get volume settings)' 2>/dev/null");
    long long v = s[0] ? atoll(s) : -1; free(s); return v;
#elif defined(AU_WINDOWS)
    IAudioEndpointVolume *vol = au_endpoint(); if (!vol) { CoUninitialize(); return -1; }
    float f = 0; long long v = -1;
    if (SUCCEEDED(IAudioEndpointVolume_GetMasterVolumeLevelScalar(vol, &f))) v = (long long)(f * 100 + 0.5f);
    IAudioEndpointVolume_Release(vol); CoUninitialize();
    return v;
#else
    return -1;   /* mobile: reserved */
#endif
}

/* set master output volume (0-100); 1 on success */
long long os_volume_set(long long pct) {
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
#if defined(AU_LINUX)
    char cmd[128];
    if (have("pactl")) { snprintf(cmd, sizeof cmd, "pactl set-sink-volume @DEFAULT_SINK@ %lld%% >/dev/null 2>&1", pct); return system(cmd)==0?1:0; }
    if (have("wpctl")) { snprintf(cmd, sizeof cmd, "wpctl set-volume @DEFAULT_AUDIO_SINK@ %lld%% >/dev/null 2>&1", pct); return system(cmd)==0?1:0; }
    return 0;
#elif defined(AU_MACOS)
    char cmd[128]; snprintf(cmd, sizeof cmd, "osascript -e 'set volume output volume %lld' >/dev/null 2>&1", pct);
    return system(cmd) == 0 ? 1 : 0;
#elif defined(AU_WINDOWS)
    IAudioEndpointVolume *vol = au_endpoint(); if (!vol) { CoUninitialize(); return 0; }
    HRESULT hr = IAudioEndpointVolume_SetMasterVolumeLevelScalar(vol, (float)pct / 100.0f, NULL);
    IAudioEndpointVolume_Release(vol); CoUninitialize();
    return SUCCEEDED(hr) ? 1 : 0;
#else
    return 0;
#endif
}

/* mute (on=1) or unmute (on=0); 1 on success */
long long os_volume_mute(long long on) {
#if defined(AU_LINUX)
    char cmd[128];
    if (have("pactl")) { snprintf(cmd, sizeof cmd, "pactl set-sink-mute @DEFAULT_SINK@ %d >/dev/null 2>&1", on?1:0); return system(cmd)==0?1:0; }
    if (have("wpctl")) { snprintf(cmd, sizeof cmd, "wpctl set-mute @DEFAULT_AUDIO_SINK@ %d >/dev/null 2>&1", on?1:0); return system(cmd)==0?1:0; }
    return 0;
#elif defined(AU_MACOS)
    char cmd[128]; snprintf(cmd, sizeof cmd, "osascript -e 'set volume output muted %s' >/dev/null 2>&1", on?"true":"false");
    return system(cmd) == 0 ? 1 : 0;
#elif defined(AU_WINDOWS)
    IAudioEndpointVolume *vol = au_endpoint(); if (!vol) { CoUninitialize(); return 0; }
    HRESULT hr = IAudioEndpointVolume_SetMute(vol, on ? TRUE : FALSE, NULL);
    IAudioEndpointVolume_Release(vol); CoUninitialize();
    return SUCCEEDED(hr) ? 1 : 0;
#else
    (void)on; return 0;
#endif
}

/* 1 if muted, 0 if not, -1 if unknown */
long long os_is_muted(void) {
#if defined(AU_LINUX)
    if (have("pactl")) {
        char *s = run_capture("pactl get-sink-mute @DEFAULT_SINK@ 2>/dev/null"); /* "Mute: yes/no" */
        int m = strstr(s, "yes") ? 1 : (strstr(s, "no") ? 0 : -1); free(s); return m;
    }
    return -1;
#elif defined(AU_MACOS)
    char *s = run_capture("osascript -e 'output muted of (get volume settings)' 2>/dev/null");
    int m = strstr(s, "true") ? 1 : (strstr(s, "false") ? 0 : -1); free(s); return m;
#elif defined(AU_WINDOWS)
    IAudioEndpointVolume *vol = au_endpoint(); if (!vol) { CoUninitialize(); return -1; }
    BOOL mute = FALSE; long long m = -1;
    if (SUCCEEDED(IAudioEndpointVolume_GetMute(vol, &mute))) m = mute ? 1 : 0;
    IAudioEndpointVolume_Release(vol); CoUninitialize();
    return m;
#else
    return -1;
#endif
}

char *os_audio_version(void) { return strdup("os_audio 1.0.0"); }
