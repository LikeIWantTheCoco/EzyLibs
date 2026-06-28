# Android integration (os_permissions / os_gps / os_sensors)

Ezy compiles to a native `.so`/binary, but Android's location & permission
APIs are Java and need an app **Context**. So the mobile os_* libs work only
inside an Android app host (e.g. a swiss app), which must do three things.

## 1. Declare the permissions in `AndroidManifest.xml`

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>
<uses-permission android:name="android.permission.ACTIVITY_RECOGNITION"/>
<!-- plus any others you request: CAMERA, RECORD_AUDIO, POST_NOTIFICATIONS, ... -->
```

(`os_sensors` accelerometer/gyroscope need no permission; the step counter
needs `ACTIVITY_RECOGNITION` on Android 10+.)

## 2. Load the lib and hand it the Activity (once, at startup)

`System.loadLibrary` triggers `JNI_OnLoad`, which caches the `JavaVM`; then call
the bridge with your Activity:

```kotlin
package org.ezylang.os
object Bridge { external fun setContext(activity: Any) }

class MainActivity : Activity() {
    override fun onCreate(s: Bundle?) {
        super.onCreate(s)
        System.loadLibrary("os")             // base
        System.loadLibrary("os_permissions") // triggers JNI_OnLoad
        Bridge.setContext(this)              // gives os the Context
        // ... start your Ezy program ...
    }
}
```

(Equivalently, from your own native glue: call the exported C symbol
`os_android_set_context(JNIEnv*, jobject activity)`.)

## 3. Forward permission results (optional but recommended)

`requestPermissions` is async; the dialog result arrives in
`onRequestPermissionsResult`. os_permissions re-checks via
`checkSelfPermission`, so after the user responds, `os_perm_check("location")`
returns the updated state — poll it, or re-call once the callback fires.

## Then, in Ezy

```ezy
import "os_permissions"
import "os_gps"
import "os_sensors"

fn main():
{
    if os_perm_request("location") == 1:
    {
        if os_gps_available() == 1: { print(os_gps_location()) }
    }
    print("accel:", os_accel_x(), os_accel_y(), os_accel_z())
    if os_perm_request("activity") == 1: { print("steps:", os_steps()) }
}
```
