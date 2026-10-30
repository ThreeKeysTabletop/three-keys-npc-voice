/* Three Keys NPC Voice — AudioWorklet processors (granular pitch, phase-vocoder pitch+formant, multi-FX). MIT. */

class TKNVPitch extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: "ratio", defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: "k-rate" }]; }
  constructor() {
    super();
    this.size = 16384; this.buf = new Float32Array(this.size); this.w = 0; this.p = 0;
    this.win = Math.round(sampleRate * 0.035); // 35 ms grain => ~35 ms worst-case added latency
  }
  read(d) {
    let pos = this.w - d; while (pos < 0) pos += this.size;
    const i = Math.floor(pos), f = pos - i, b = this.buf;
    return b[i % this.size] * (1 - f) + b[(i + 1) % this.size] * f;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0]?.[0], out = outputs[0];
    if (!out?.length) return true;
    const ratio = params.ratio[0];
    if (!inp) { for (const ch of out) ch.fill(0); return true; }
    const o = out[0];
    if (Math.abs(ratio - 1) < 1e-3) { o.set(inp); }
    else {
      const inc = (1 - ratio) / this.win;
      for (let n = 0; n < inp.length; n++) {
        this.buf[this.w] = inp[n];
        let p2 = this.p + 0.5; if (p2 >= 1) p2 -= 1;
        const g1 = Math.sin(Math.PI * this.p) ** 2, g2 = Math.sin(Math.PI * p2) ** 2;
        o[n] = this.read(this.p * this.win + 1) * g1 + this.read(p2 * this.win + 1) * g2;
        this.w = (this.w + 1) % this.size;
        this.p += inc; if (this.p >= 1) this.p -= 1; else if (this.p < 0) this.p += 1;
      }
      return this.copy(out), true;
    }
    for (let n = 0; n < inp.length; n++) { this.buf[this.w] = inp[n]; this.w = (this.w + 1) % this.size; }
    this.copy(out); return true;
  }
  copy(out) { for (let c = 1; c < out.length; c++) out[c].set(out[0]); }
}
registerProcessor("tknv-pitch", TKNVPitch);

/* ---------------------------------------------------------------------------------------------
 * tknv-pv: phase-vocoder pitch shifter with cepstral spectral-envelope preservation, so pitch and
 * formants move independently. FFT 1024, hop 256 (4x overlap). Algorithmic latency = 1024-256 =
 * 768 samples (16 ms @ 48 kHz) + one 128-sample render quantum. Passes through untouched (0 latency)
 * when pitch and formant are both 0 or the node is inactive.
 * ------------------------------------------------------------------------------------------- */
const N = 1024, OS = 4, HOP = N / OS, HALF = N / 2, LIFTER = 36;
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
class TKNVPV extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [
    { name: "pitch", defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: "k-rate" },
    { name: "formant", defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: "k-rate" },
    { name: "active", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" }]; }
  constructor() {
    super();
    this.win = new Float32Array(N); for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    this.inF = new Float32Array(N); this.outF = new Float32Array(N); this.acc = new Float32Array(2 * N);
    this.lastPh = new Float32Array(HALF + 1); this.sumPh = new Float32Array(HALF + 1);
    this.re = new Float32Array(N); this.im = new Float32Array(N); this.cr = new Float32Array(N); this.ci = new Float32Array(N);
    this.mag = new Float32Array(HALF + 1); this.frq = new Float32Array(HALF + 1); this.env = new Float32Array(HALF + 1);
    this.sMag = new Float32Array(HALF + 1); this.sFrq = new Float32Array(HALF + 1);
    this.rover = N - HOP; this.port.postMessage({ latency: N - HOP });
  }
  frame(pitch, formant) {
    const { re, im, cr, ci, mag, frq, env, sMag, sFrq, win } = this, fpb = sampleRate / N, expct = 2 * Math.PI * HOP / N;
    for (let k = 0; k < N; k++) { re[k] = this.inF[k] * win[k]; im[k] = 0; }
    fft(re, im, false);
    for (let k = 0; k <= HALF; k++) {
      const m = Math.hypot(re[k], im[k]), ph = Math.atan2(im[k], re[k]);
      let t = ph - this.lastPh[k]; this.lastPh[k] = ph; t -= k * expct;
      let q = Math.trunc(t / Math.PI); q += q >= 0 ? (q & 1) : -(q & 1); t -= Math.PI * q;
      frq[k] = k * fpb + (OS * t / (2 * Math.PI)) * fpb; mag[k] = m;
    }
    // Cepstral envelope: log|X| -> real cepstrum -> low-quefrency lifter -> back to a smooth log envelope.
    for (let k = 0; k < N; k++) { const kk = k <= HALF ? k : N - k; cr[k] = Math.log(mag[kk] + 1e-9); ci[k] = 0; }
    fft(cr, ci, true);
    for (let n = 0; n < N; n++) { if (n > LIFTER && n < N - LIFTER) cr[n] = 0; ci[n] = 0; }
    fft(cr, ci, false);
    for (let k = 0; k <= HALF; k++) env[k] = Math.exp(cr[k]);
    sMag.fill(0); sFrq.fill(0);
    for (let k = 0; k <= HALF; k++) { const j = Math.round(k * pitch); if (j > HALF) break; sMag[j] += mag[k] / env[k]; sFrq[j] = frq[k] * pitch; }
    for (let k = 0; k <= HALF; k++) {
      const src = k / formant, i = Math.floor(src), f = src - i;
      const e = i + 1 <= HALF ? env[i] * (1 - f) + env[i + 1] * f : 0;
      const m = sMag[k] * e;
      let t = (sFrq[k] - k * fpb) / fpb; t = 2 * Math.PI * t / OS + k * expct; this.sumPh[k] += t;
      re[k] = m * Math.cos(this.sumPh[k]); im[k] = m * Math.sin(this.sumPh[k]);
    }
    for (let k = HALF + 1; k < N; k++) { re[k] = re[N - k]; im[k] = -im[N - k]; }
    fft(re, im, true);
    for (let k = 0; k < N; k++) this.acc[k] += win[k] * re[k] / 1.5;   // Hann² at 4x overlap sums to 1.5
    for (let k = 0; k < HOP; k++) this.outF[k] = this.acc[k];
    this.acc.copyWithin(0, HOP); this.acc.fill(0, N);
    this.inF.copyWithin(0, HOP);
  }
  process(inputs, outputs, params) {
    const inp = inputs[0]?.[0], o = outputs[0]?.[0]; if (!o) return true;
    const pitch = params.pitch[0], formant = params.formant[0], act = params.active[0] > 0.5;
    if (!act) { o.fill(0); return true; }
    if (!inp) { o.fill(0); return true; }
    if (Math.abs(pitch - 1) < 1e-3 && Math.abs(formant - 1) < 1e-3) { o.set(inp); this.rover = N - HOP; this.acc.fill(0); return true; }
    for (let n = 0; n < inp.length; n++) {
      this.inF[this.rover] = inp[n]; o[n] = this.outF[this.rover - (N - HOP)]; this.rover++;
      if (this.rover >= N) { this.rover = N - HOP; this.frame(pitch, formant); }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(o);
    return true;
  }
}
registerProcessor("tknv-pv", TKNVPV);

/* ---------------------------------------------------------------------------------------------
 * tknv-fx: vocoder (16 bands, saw/noise/chord carrier, auto level-matched), growl/throat rattle
 * (irregular sub-audio amplitude modulation, not distortion), bitcrush/sample-rate reduction and an
 * envelope-follower-driven breath/air layer. Zero algorithmic latency.
 * ------------------------------------------------------------------------------------------- */
const BANDS = 16;
function bpf(f, q) { const w = 2 * Math.PI * f / sampleRate, a = Math.sin(w) / (2 * q), a0 = 1 + a;
  return { b0: a / a0, b2: -a / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - a) / a0, x1: 0, x2: 0, y1: 0, y2: 0 }; }
function run(f, x) { const y = f.b0 * x + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2; f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y; return y; }
class TKNVFX extends AudioWorkletProcessor {
  static get parameterDescriptors() { const p = (name, def, min, max) => ({ name, defaultValue: def, minValue: min, maxValue: max, automationRate: "k-rate" });
    return [p("vocoder", 0, 0, 1), p("carrier", 0, 0, 2), p("carrierFreq", 110, 20, 1000), p("growl", 0, 0, 1), p("growlRate", 30, 1, 120),
      p("crushBits", 0, 0, 16), p("crushRate", 1, 1, 40), p("crushMix", 0, 0, 1), p("breath", 0, 0, 1), p("breathTone", 3000, 200, 10000)]; }
  constructor() {
    super();
    const lo = 150, hi = 7000; this.mod = []; this.car = []; this.env = new Float32Array(BANDS);
    for (let i = 0; i < BANDS; i++) { const f = lo * Math.pow(hi / lo, i / (BANDS - 1)); this.mod.push(bpf(f, 5)); this.car.push(bpf(f, 5)); }
    this.ph = [0, 0, 0]; this.seed = 22222; this.rIn = 1e-4; this.rOut = 1e-4; this.g = 1;
    this.gPh = 0; this.gAmp = 1; this.hold = 0; this.holdN = 0; this.bEnv = 0; this.bLp = 0; this.bBp = 0; this.tone = -1;
    this.aAtt = Math.exp(-1 / (0.004 * sampleRate)); this.aRel = Math.exp(-1 / (0.03 * sampleRate));
    this.bAtt = Math.exp(-1 / (0.005 * sampleRate)); this.bRel = Math.exp(-1 / (0.08 * sampleRate)); this.rms = Math.exp(-1 / (0.3 * sampleRate));
  }
  rnd() { this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff; return this.seed / 0x3fffffff - 1; }
  saw(i, f) { this.ph[i] += f / sampleRate; if (this.ph[i] >= 1) this.ph[i] -= 1; return 2 * this.ph[i] - 1; }
  process(inputs, outputs, P) {
    const inp = inputs[0]?.[0], o = outputs[0]?.[0]; if (!o) return true;
    if (!inp) { o.fill(0); return true; }
    const voc = P.vocoder[0], ct = Math.round(P.carrier[0]), cf = P.carrierFreq[0], gr = P.growl[0], grR = P.growlRate[0];
    const bits = P.crushBits[0], cr = Math.round(P.crushRate[0]), cm = P.crushMix[0], br = P.breath[0], bt = P.breathTone[0];
    const fc = 2 * Math.sin(Math.PI * Math.min(bt, sampleRate / 6) / sampleRate);
    for (let n = 0; n < inp.length; n++) {
      const x = inp[n]; let y = x;
      if (voc > 0) {
        const c = ct === 1 ? this.rnd() * 0.6 : ct === 2 ? (this.saw(0, cf) + this.saw(1, cf * 1.26) + this.saw(2, cf * 1.5)) / 3 : this.saw(0, cf);
        let s = 0;
        for (let b = 0; b < BANDS; b++) { const m = Math.abs(run(this.mod[b], x)); const e = this.env[b]; this.env[b] = m > e ? m + (e - m) * this.aAtt : m + (e - m) * this.aRel; s += run(this.car[b], c) * this.env[b]; }
        this.rIn = this.rIn * this.rms + x * x * (1 - this.rms); this.rOut = this.rOut * this.rms + s * s * (1 - this.rms);
        const tg = Math.min(30, Math.sqrt(this.rIn / (this.rOut + 1e-12))); this.g += (tg - this.g) * 0.001;
        y = x * Math.cos(voc * Math.PI / 2) + s * this.g * Math.sin(voc * Math.PI / 2);
      }
      if (gr > 0) {   // throat rattle: irregular pulses at ~growlRate, amplitude re-randomised every cycle
        this.gPh += grR * (1 + 0.15 * this.rnd()) / sampleRate;
        if (this.gPh >= 1) { this.gPh -= 1; this.gAmp = 0.6 + 0.4 * Math.abs(this.rnd()); }
        const m = Math.pow(0.5 + 0.5 * Math.cos(2 * Math.PI * this.gPh), 2) * this.gAmp;   // mean ≈ 0.3
        y *= (1 - gr * 0.85 * (1 - m)) / (1 - gr * 0.85 * 0.7);
      }
      if (bits > 0 && cm > 0) {
        if (this.holdN <= 0) { const q = Math.pow(2, bits - 1); this.hold = Math.round(y * q) / q; this.holdN = cr; } this.holdN--;
        y = y * (1 - cm) + this.hold * cm;
      }
      if (br > 0) {   // breath/air: noise, band-passed around breathTone, scaled by the input envelope
        const a = Math.abs(x), e = this.bEnv; this.bEnv = a > e ? a + (e - a) * this.bAtt : a + (e - a) * this.bRel;
        const nz = this.rnd(); this.bLp += fc * this.bBp; const hp = nz - this.bLp - 0.7 * this.bBp; this.bBp += fc * hp;
        y += this.bBp * this.bEnv * br * 1.1;
      }
      o[n] = y;
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(o);
    return true;
  }
}
registerProcessor("tknv-fx", TKNVFX);
