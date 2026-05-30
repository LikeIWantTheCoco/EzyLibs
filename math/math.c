#define _GNU_SOURCE
#include <math.h>
#include <stdlib.h>
#include <stdint.h>

#ifndef M_PI
#define M_PI    3.14159265358979323846
#endif
#ifndef M_E
#define M_E     2.71828182845904523536
#endif
#ifndef M_SQRT2
#define M_SQRT2 1.41421356237309504880
#endif

/* ── Trig ─────────────────────────────────────────────── */
double math_sin(double x)        { return sin(x); }
double math_cos(double x)        { return cos(x); }
double math_tan(double x)        { return tan(x); }
double math_asin(double x)       { return asin(x); }
double math_acos(double x)       { return acos(x); }
double math_atan(double x)       { return atan(x); }
double math_atan2(double y, double x) { return atan2(y, x); }
double math_sinh(double x)       { return sinh(x); }
double math_cosh(double x)       { return cosh(x); }
double math_tanh(double x)       { return tanh(x); }
double math_asinh(double x)      { return asinh(x); }
double math_acosh(double x)      { return acosh(x); }
double math_atanh(double x)      { return atanh(x); }

/* ── Exponential / logarithmic ───────────────────────── */
double math_exp(double x)        { return exp(x); }
double math_exp2(double x)       { return exp2(x); }
double math_expm1(double x)      { return expm1(x); }   /* e^x - 1 (precise near 0) */
double math_log(double x)        { return log(x); }
double math_log2(double x)       { return log2(x); }
double math_log10(double x)      { return log10(x); }
double math_log1p(double x)      { return log1p(x); }   /* log(1+x) (precise near 0) */
double math_pow(double b, double e) { return pow(b, e); }
double math_sqrt(double x)       { return sqrt(x); }
double math_cbrt(double x)       { return cbrt(x); }    /* cube root */
double math_hypot(double a, double b) { return hypot(a, b); }

/* ── Rounding ────────────────────────────────────────── */
double math_floor(double x)      { return floor(x); }
double math_ceil(double x)       { return ceil(x); }
double math_round(double x)      { return round(x); }
double math_trunc(double x)      { return trunc(x); }   /* toward zero */
long long math_lround(double x)  { return llround(x); } /* round to int */

/* ── Absolute value / sign ───────────────────────────── */
double math_abs(double x)        { return fabs(x); }
long long math_iabs(long long x) { return x < 0 ? -x : x; }
long long math_sign(double x)    { return x > 0.0 ? 1 : (x < 0.0 ? -1 : 0); }
long long math_isign(long long x){ return x > 0 ? 1 : (x < 0 ? -1 : 0); }

/* ── Clamp / min / max ───────────────────────────────── */
double    math_clamp(double x, double lo, double hi)
                                 { return x < lo ? lo : (x > hi ? hi : x); }
long long math_iclamp(long long x, long long lo, long long hi)
                                 { return x < lo ? lo : (x > hi ? hi : x); }
double    math_fmax(double a, double b)   { return fmax(a, b); }
double    math_fmin(double a, double b)   { return fmin(a, b); }
long long math_imax(long long a, long long b) { return a > b ? a : b; }
long long math_imin(long long a, long long b) { return a < b ? a : b; }

/* ── Modulo / remainder ──────────────────────────────── */
double math_fmod(double a, double b)  { return fmod(a, b); }
double math_remainder(double a, double b) { return remainder(a, b); } /* IEEE remainder */

/* ── Power helpers ───────────────────────────────────── */
double math_sq(double x)         { return x * x; }
double math_cube(double x)       { return x * x * x; }

/* ── Angle conversion ────────────────────────────────── */
double math_deg2rad(double d)    { return d * (M_PI / 180.0); }
double math_rad2deg(double r)    { return r * (180.0 / M_PI); }

/* ── Constants (returned as float) ──────────────────── */
double math_pi(void)             { return M_PI; }
double math_e(void)              { return M_E; }
double math_tau(void)            { return 2.0 * M_PI; }
double math_phi(void)            { return 1.6180339887498948482; }  /* golden ratio */
double math_inf(void)            { return INFINITY; }
double math_nan(void)            { return NAN; }

/* ── Classification ──────────────────────────────────── */
long long math_isinf(double x)   { return isinf(x) ? 1 : 0; }
long long math_isnan(double x)   { return isnan(x) ? 1 : 0; }
long long math_isfinite(double x){ return isfinite(x) ? 1 : 0; }

/* ── Interpolation ───────────────────────────────────── */
double math_lerp(double a, double b, double t) { return a + t * (b - a); }
double math_smoothstep(double edge0, double edge1, double x) {
    double t = math_clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

/* ── Integer math ────────────────────────────────────── */
long long math_gcd(long long a, long long b) {
    if (a < 0) a = -a;
    if (b < 0) b = -b;
    while (b) { long long t = b; b = a % b; a = t; }
    return a;
}
long long math_lcm(long long a, long long b) {
    long long g = math_gcd(a, b);
    return g ? (a / g) * b : 0;
}
long long math_factorial(long long n) {
    if (n <= 1) return 1;
    long long r = 1;
    for (long long i = 2; i <= n; i++) r *= i;
    return r;
}
long long math_isprime(long long n) {
    if (n < 2) return 0;
    if (n < 4) return 1;
    if (n % 2 == 0 || n % 3 == 0) return 0;
    for (long long i = 5; i * i <= n; i += 6)
        if (n % i == 0 || n % (i + 2) == 0) return 0;
    return 1;
}
long long math_pow2(long long n)  { return 1LL << n; }
long long math_log2i(long long n) {
    if (n <= 0) return -1;
    long long r = 0;
    while (n >>= 1) r++;
    return r;
}
/* next power of two >= n */
long long math_nextpow2(long long n) {
    if (n <= 1) return 1;
    n--;
    n |= n >> 1; n |= n >> 2; n |= n >> 4;
    n |= n >> 8; n |= n >> 16; n |= n >> 32;
    return n + 1;
}

/* ── Statistics helpers ──────────────────────────────── */
double math_map(double x, double in_lo, double in_hi,
                          double out_lo, double out_hi) {
    return out_lo + (x - in_lo) * (out_hi - out_lo) / (in_hi - in_lo);
}
