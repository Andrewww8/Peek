// Native selective scan (Mamba SSM recurrence) for CPU, multithreaded with GCD.
//   h_t = exp(dt_t * A) * h_{t-1} + dt_t * u_t * B_t ;  y_t = <C_t, h_t> + D * u_t
// Layouts (all float32, C-contiguous):
//   u, dt, y : (b, d, L)      dt is already softplus(delta + bias)
//   A        : (d, n)         n must be 16
//   Bm, Cm   : (b, g, L, n)   channel c uses group c / (d / g)
//   D        : (d) or NULL
#include <dispatch/dispatch.h>
#include <stddef.h>
#include <math.h>

#define N 16

static inline float fast_exp(float x) {
    // x <= 0 expected; clamp to avoid denormals/underflow
    x = x < -80.0f ? -80.0f : x;
    float kf = nearbyintf(x * 1.44269504088896341f);
    float r = x - kf * 0.693359375f;
    r = r - kf * -2.12194440e-4f;
    float p = 1.9875691500e-4f;
    p = p * r + 1.3981999507e-3f;
    p = p * r + 8.3334519073e-3f;
    p = p * r + 4.1665795894e-2f;
    p = p * r + 1.6666665459e-1f;
    p = p * r + 5.0000001201e-1f;
    p = p * r * r + r + 1.0f;
    union { int i; float f; } s;
    s.i = ((int)kf + 127) << 23;
    return p * s.f;
}

void sscan(const float *u, const float *dt, const float *A, const float *Bm,
           const float *Cm, const float *D, float *y,
           int b, int d, int g, int L) {
    int rep = d / g;
    dispatch_apply((size_t)b * d, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^(size_t idx) {
        int bi = (int)(idx / d), c = (int)(idx % d);
        const float *uu = u + idx * (size_t)L;
        const float *dd = dt + idx * (size_t)L;
        float *yy = y + idx * (size_t)L;
        const float *a = A + (size_t)c * N;
        const float *Bt = Bm + ((size_t)bi * g + c / rep) * (size_t)L * N;
        const float *Ct = Cm + ((size_t)bi * g + c / rep) * (size_t)L * N;
        float Dc = D ? D[c] : 0.0f;
        float h[N];
        for (int k = 0; k < N; k++) h[k] = 0.0f;
        for (int t = 0; t < L; t++) {
            float dlt = dd[t], x = dlt * uu[t];
            const float *bt = Bt + (size_t)t * N, *ct = Ct + (size_t)t * N;
            float acc = 0.0f;
            for (int k = 0; k < N; k++) {
                h[k] = fast_exp(dlt * a[k]) * h[k] + x * bt[k];
                acc += h[k] * ct[k];
            }
            yy[t] = acc + Dc * uu[t];
        }
    });
}
