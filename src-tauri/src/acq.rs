use serde::{Deserialize, Serialize};

pub struct XorShift(u32);

impl XorShift {
    pub fn new(seed: u32) -> Self {
        Self(seed.max(1))
    }
    /// [0,1)
    pub fn next(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (self.0 >> 8) as f32 / 16_777_216.0
    }
    /// [-1,1)
    pub fn next_signed(&mut self) -> f32 {
        self.next() * 2.0 - 1.0
    }
}

pub const SAMPLE_RATE_MIN: f64 = 1_000.0;
pub const SAMPLE_RATE_MAX: f64 = 1_000_000_000.0;
pub const BATCH_MS_MIN: u64 = 10;
pub const BATCH_MS_MAX: u64 = 100;
/// 每通道吞吐上限（样本/s），超出后信号时间按实际生成量推进
pub const THROUGHPUT_CAP: f64 = 100_000.0;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SineParams { pub freq_hz: f32, pub amp: f32, pub noise: f32 }

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PulseParams { pub freq_hz: f32, pub duty: f32, pub amp: f32, pub jitter: f32 }

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendParams { pub amp: f32, pub noise: f32 }

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenParams {
    pub sample_rate_hz: f64,
    pub batch_ms: u64,
    pub sine: SineParams,
    pub pulse: PulseParams,
    pub trend: TrendParams,
}

impl Default for GenParams {
    fn default() -> Self {
        Self {
            sample_rate_hz: 1000.0,
            batch_ms: 20,
            sine: SineParams { freq_hz: 5.0, amp: 1.0, noise: 0.15 },
            pulse: PulseParams { freq_hz: 1.0, duty: 0.5, amp: 1.0, jitter: 0.15 },
            trend: TrendParams { amp: 1.0, noise: 0.05 },
        }
    }
}

fn clampf(v: f32, lo: f32, hi: f32) -> f32 {
    v.clamp(lo, hi)
}

impl GenParams {
    /// 把所有字段钳制到安全范围（防前端传非法值）
    pub fn clamped(&self) -> Self {
        Self {
            sample_rate_hz: self.sample_rate_hz.clamp(SAMPLE_RATE_MIN, SAMPLE_RATE_MAX),
            batch_ms: self.batch_ms.clamp(BATCH_MS_MIN, BATCH_MS_MAX),
            sine: SineParams {
                freq_hz: clampf(self.sine.freq_hz, 0.1, 1_000_000.0),
                amp: clampf(self.sine.amp, 0.0, 2.0),
                noise: clampf(self.sine.noise, 0.0, 1.0),
            },
            pulse: PulseParams {
                freq_hz: clampf(self.pulse.freq_hz, 0.1, 100_000.0),
                duty: clampf(self.pulse.duty, 0.05, 0.95),
                amp: clampf(self.pulse.amp, 0.0, 2.0),
                jitter: clampf(self.pulse.jitter, 0.0, 0.5),
            },
            trend: TrendParams {
                amp: clampf(self.trend.amp, 0.1, 2.0),
                noise: clampf(self.trend.noise, 0.0, 0.1),
            },
        }
    }
}

/// 每批实际样本数 = min(rate × batch/1000, CAP × batch/1000)，至少 1
pub fn samples_per_batch(rate_hz: f64, batch_ms: u64) -> usize {
    let batch = batch_ms as f64;
    let want = rate_hz * batch / 1000.0;
    let cap = THROUGHPUT_CAP * batch / 1000.0;
    (want.min(cap).round() as usize).max(1)
}

#[derive(Clone, Serialize)]
pub struct ChannelSamples {
    pub id: String,
    pub samples: Vec<f32>,
}

#[derive(Clone, Serialize)]
pub struct AcqFrame {
    pub seq: u64,
    pub t0_ms: u64,
    pub channels: Vec<ChannelSamples>,
}

pub struct ChannelGen {
    pub id: &'static str,
    kind: WaveKind,
    rng: XorShift,
    level: f32,
    step_until: f32,
}

enum WaveKind {
    Sine { freq_hz: f32, phase: f32, amp: f32, noise: f32 },
    Pulse { freq_hz: f32, duty: f32, amp: f32, jitter: f32 },
    Trend { amp: f32, noise: f32 },
}

impl ChannelGen {
    pub fn sine() -> Self {
        Self {
            id: "sine",
            kind: WaveKind::Sine { freq_hz: 5.0, phase: 0.0, amp: 1.0, noise: 0.15 },
            rng: XorShift::new(0x9E37_79B9),
            level: 0.0,
            step_until: 0.0,
        }
    }
    pub fn pulse() -> Self {
        Self {
            id: "pulse",
            kind: WaveKind::Pulse { freq_hz: 1.0, duty: 0.5, amp: 1.0, jitter: 0.15 },
            rng: XorShift::new(0x243F_6A88),
            level: 0.0,
            step_until: 0.0,
        }
    }
    pub fn trend() -> Self {
        Self {
            id: "trend",
            kind: WaveKind::Trend { amp: 1.0, noise: 0.05 },
            rng: XorShift::new(0x85A3_08D3),
            level: 0.0,
            step_until: 0.0,
        }
    }

    /// 生成全局样本序号 [t0_index, t0_index+n) 的样本，t = 序号/rate_hz
    pub fn gen(&mut self, t0_index: u64, n: usize, rate_hz: f64) -> Vec<f32> {
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let t = (t0_index + i as u64) as f64 / rate_hz;
            out.push(self.sample(t));
        }
        out
    }

    /// 热更新波形参数；trend 的内部状态（level/step_until）不受影响
    pub fn apply(&mut self, p: &GenParams) {
        match &mut self.kind {
            WaveKind::Sine { freq_hz, amp, noise, .. } => {
                *freq_hz = p.sine.freq_hz;
                *amp = p.sine.amp;
                *noise = p.sine.noise;
            }
            WaveKind::Pulse { freq_hz, duty, amp, jitter } => {
                *freq_hz = p.pulse.freq_hz;
                *duty = p.pulse.duty;
                *amp = p.pulse.amp;
                *jitter = p.pulse.jitter;
            }
            WaveKind::Trend { amp, noise } => {
                *amp = p.trend.amp;
                *noise = p.trend.noise;
            }
        }
    }

    fn sample(&mut self, t: f64) -> f32 {
        match &mut self.kind {
            WaveKind::Sine { freq_hz, phase, amp, noise } => {
                let v = (2.0 * std::f32::consts::PI * *freq_hz * t as f32 + *phase).sin() * *amp;
                v + self.rng.next_signed() * *noise
            }
            WaveKind::Pulse { freq_hz, duty, amp, jitter } => {
                let period = 1.0 / *freq_hz;
                let ph = (t as f32 % period) / period;
                let base = if ph < *duty { 1.0 } else { -1.0 };
                let to_edge = (ph - *duty).abs().min(ph).min(1.0 - ph);
                (if to_edge < *jitter && self.rng.next_signed() > 0.0 {
                    1.0
                } else {
                    base
                }) * *amp
            }
            WaveKind::Trend { amp, noise } => {
                if self.step_until > 0.0 {
                    self.step_until -= 1.0;
                } else if self.rng.next() < 0.002 {
                    self.level += self.rng.next_signed() * 0.8;
                    self.step_until = 200.0;
                }
                self.level += self.rng.next_signed() * 0.004;
                self.level = self.level.clamp(-*amp, *amp);
                self.level + self.rng.next_signed() * *noise
            }
        }
    }
}

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter as _;

pub struct AcqEngine {
    pub running: Arc<AtomicBool>,
    pub params: Arc<std::sync::Mutex<GenParams>>,
}

impl AcqEngine {
    pub fn spawn(app: tauri::AppHandle) -> Arc<Self> {
        let params = Arc::new(std::sync::Mutex::new(GenParams::default()));
        let engine = Arc::new(AcqEngine {
            running: Arc::new(AtomicBool::new(true)),
            params: params.clone(),
        });
        let engine2 = Arc::clone(&engine);
        std::thread::spawn(move || {
            let mut gens: Vec<ChannelGen> =
                vec![ChannelGen::sine(), ChannelGen::pulse(), ChannelGen::trend()];
            let mut t0_index: u64 = 0;
            let mut seq: u64 = 0;
            let mut last = Instant::now();
            loop {
                let p = params.lock().unwrap().clone();
                for g in gens.iter_mut() {
                    g.apply(&p);
                }
                let n = samples_per_batch(p.sample_rate_hz, p.batch_ms);
                let channels = gens
                    .iter_mut()
                    .map(|g| ChannelSamples {
                        id: g.id.to_string(),
                        samples: g.gen(t0_index, n, p.sample_rate_hz),
                    })
                    .collect();
                t0_index += n as u64;
                if engine2.running.load(Ordering::Relaxed) {
                    // t0_ms 为信号时间（前端未使用该字段，语义对齐即可）
                    let t0_ms = (t0_index as f64 / p.sample_rate_hz * 1000.0) as u64;
                    let _ = app.emit(
                        "wave-data",
                        AcqFrame { seq, t0_ms, channels },
                    );
                    seq = seq.wrapping_add(1);
                }
                let now = Instant::now();
                let elapsed = now.duration_since(last);
                if elapsed < Duration::from_millis(p.batch_ms) {
                    std::thread::sleep(Duration::from_millis(p.batch_ms) - elapsed);
                }
                last = now;
            }
        });
        engine
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_size_matches_requested_count() {
        let mut g = ChannelGen::sine();
        assert_eq!(g.gen(0, 20, 1000.0).len(), 20);
        assert_eq!(g.gen(1000, 3, 1000.0).len(), 3);
    }

    #[test]
    fn sine_values_within_range_and_finite() {
        let mut g = ChannelGen::sine();
        for v in g.gen(0, 500, 1000.0) {
            assert!(v.is_finite());
            assert!((-1.2..1.2).contains(&v), "sine out of range: {v}");
        }
    }

    #[test]
    fn sine_phase_advances_continuously() {
        // 5Hz，t=0 起前 25ms（1/8 周期）内单调上升
        let mut g = ChannelGen::sine();
        let s = g.gen(0, 25, 1000.0);
        for w in s.windows(2) {
            assert!(w[1] >= w[0] - 0.4, "phase jump: {} -> {}", w[0], w[1]);
        }
    }

    #[test]
    fn trend_stays_within_amplitude() {
        let mut g = ChannelGen::trend();
        for v in g.gen(0, 2000, 1000.0) {
            assert!(v.is_finite());
            assert!((-1.5..1.5).contains(&v), "trend out of range: {v}");
        }
    }

    #[test]
    fn deterministic_seed_reproduces_sequence() {
        let mut a = ChannelGen::sine();
        let mut b = ChannelGen::sine();
        assert_eq!(a.gen(0, 100, 1000.0), b.gen(0, 100, 1000.0));
    }

    use super::{samples_per_batch, SineParams, TrendParams, PulseParams, GenParams, SAMPLE_RATE_MAX, BATCH_MS_MIN};

    #[test]
    fn clamped_pulls_out_of_range_values() {
        let p = GenParams {
            sample_rate_hz: 5e9,
            batch_ms: 5,
            sine: SineParams { freq_hz: 2e6, amp: 9.0, noise: -1.0 },
            pulse: PulseParams { freq_hz: -1.0, duty: 0.0, amp: -3.0, jitter: 9.0 },
            trend: TrendParams { amp: 0.0, noise: 5.0 },
        };
        let c = p.clamped();
        assert_eq!(c.sample_rate_hz, SAMPLE_RATE_MAX);
        assert_eq!(c.batch_ms, BATCH_MS_MIN);
        assert_eq!(c.sine.freq_hz, 1_000_000.0);
        assert_eq!(c.sine.amp, 2.0);
        assert_eq!(c.sine.noise, 0.0);
        assert_eq!(c.pulse.freq_hz, 0.1);
        assert_eq!(c.pulse.duty, 0.05);
        assert_eq!(c.pulse.amp, 0.0);
        assert_eq!(c.pulse.jitter, 0.5);
        assert_eq!(c.trend.amp, 0.1);
        assert_eq!(c.trend.noise, 0.1);
    }

    #[test]
    fn samples_per_batch_caps_at_throughput() {
        assert_eq!(samples_per_batch(1000.0, 20), 20);
        assert_eq!(samples_per_batch(5000.0, 20), 100);
        assert_eq!(samples_per_batch(1e9, 20), 2000); // CAP×20/1000
        assert_eq!(samples_per_batch(100_000.0, 100), 10_000);
    }

    #[test]
    fn gen_at_high_rate_yields_finite_samples() {
        let mut g = ChannelGen::sine();
        for v in g.gen(123_456, 1000, 1e9) {
            assert!(v.is_finite());
        }
    }

    #[test]
    fn higher_sine_freq_raises_zero_crossings() {
        let mut lo = ChannelGen::sine();
        lo.apply(&GenParams {
            sine: SineParams { freq_hz: 5.0, amp: 1.0, noise: 0.0 },
            ..GenParams::default()
        });
        let mut hi = ChannelGen::sine();
        hi.apply(&GenParams {
            sine: SineParams { freq_hz: 50.0, amp: 1.0, noise: 0.0 },
            ..GenParams::default()
        });
        let zc = |v: Vec<f32>| v.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
        assert!(zc(hi.gen(0, 10_000, 1000.0)) > zc(lo.gen(0, 10_000, 1000.0)) * 3);
    }
}
