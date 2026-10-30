/* Three Keys NPC Voice — Web Audio voice chain (shared by the module and the demo renderer). MIT.
 *
 * input → gain → EQ (hp, lp, presence, tilt, low/high shelf, notch) → EQ trim
 *   → voice layers (main + up to 3 extra, each phase-vocoder pitch+formant → hp/lp → gain; energy-normalised sum)
 *   → vibrato → FX worklet (vocoder, growl rattle, bitcrush, breath/air) → soft drive → ring-mod
 *   → chorus → flanger → phaser → comb (LFO) → tremolo → space (dry / reverb / echo, equal power)
 *   → mix with clean → safety (glue comp → limiter → −1.5 dBFS ceiling)
 */
export const DEFAULTS = {
  gain: 1, pitch: 0, formant: 0, tilt: 0, filter: "none", hp: 20, lp: 20000, peakFreq: 1000, peakGain: 0,
  lowShelf: 0, highShelf: 0, notchFreq: 0, notchQ: 4,
  drive: 0, growl: 0, growlRate: 30, ringFreq: 0, ringMix: 0,
  vocoder: 0, carrier: "saw", carrierFreq: 110, crushBits: 0, crushRate: 1, crushMix: 0, breath: 0, breathTone: 3000,
  chorus: 0, flanger: 0, flangerRate: 0.3, phaser: 0, phaserRate: 0.4, tremolo: 0, tremoloRate: 5, vibrato: 0, vibratoRate: 5,
  comb: 0, combTime: 8, combFeedback: 0.5, combLfo: 0,
  reverb: 0, reverbSize: 1.5, reverbTone: 0, delay: 0, delayTime: 0.2, feedback: 0.3, mix: 1, layers: []
};
export const RANGES = {
  gain: [0, 3, 0.05], pitch: [-24, 24, 0.5], formant: [-12, 12, 0.5], tilt: [-12, 12, 0.5], hp: [20, 3000, 10], lp: [300, 20000, 50],
  peakFreq: [100, 8000, 50], peakGain: [-18, 12, 0.5], lowShelf: [-18, 12, 0.5], highShelf: [-18, 12, 0.5], notchFreq: [0, 8000, 10], notchQ: [0.5, 20, 0.5],
  drive: [0, 1, 0.01], growl: [0, 1, 0.01], growlRate: [5, 90, 1], ringFreq: [0, 1000, 1], ringMix: [0, 1, 0.01],
  vocoder: [0, 1, 0.01], carrierFreq: [30, 600, 1], crushBits: [0, 16, 1], crushRate: [1, 40, 1], crushMix: [0, 1, 0.01], breath: [0, 1, 0.01], breathTone: [300, 10000, 50],
  chorus: [0, 1, 0.01], flanger: [0, 1, 0.01], flangerRate: [0.05, 5, 0.05], phaser: [0, 1, 0.01], phaserRate: [0.05, 5, 0.05],
  tremolo: [0, 1, 0.01], tremoloRate: [0.5, 20, 0.1], vibrato: [0, 1, 0.01], vibratoRate: [0.5, 12, 0.1],
  comb: [0, 1, 0.01], combTime: [1, 30, 0.5], combFeedback: [0, 0.9, 0.01], combLfo: [0, 8, 0.05],
  reverb: [0, 1, 0.01], reverbSize: [0.2, 6, 0.1], reverbTone: [-1, 1, 0.05], delay: [0, 1, 0.01], delayTime: [0.01, 1, 0.01], feedback: [0, 0.9, 0.01], mix: [0, 1, 0.01]
};
export const LAYER_RANGES = { pitch: [-24, 24, 0.5], formant: [-12, 12, 0.5], gain: [0, 1, 0.01], hp: [20, 3000, 10], lp: [300, 20000, 50] };
export const CARRIERS = ["saw", "noise", "chord"];
export const FILTERS = { none: null, telephone: { hp: 400, lp: 3400, peakFreq: 1800, peakGain: 4 },
  radio: { hp: 500, lp: 2800, peakFreq: 1500, peakGain: 6, drive: 0.08 }, cave: { hp: 60, lp: 1200, peakFreq: 400, peakGain: 3 } };
export const MAX_LAYERS = 3;
const clamp = (v, [a, b]) => Math.min(b, Math.max(a, v));

export function normalize(p = {}) {
  const o = { ...DEFAULTS, layers: [] };
  for (const [k, d] of Object.entries(DEFAULTS)) {
    if (!(k in p) || k === "layers") continue;
    if (typeof d === "number") { const v = Number(p[k]); if (Number.isFinite(v)) o[k] = clamp(v, RANGES[k]); }
    else if (k === "filter" && p[k] in FILTERS) o[k] = p[k];
    else if (k === "carrier" && CARRIERS.includes(p[k])) o[k] = p[k];
  }
  if (Array.isArray(p.layers)) o.layers = p.layers.slice(0, MAX_LAYERS).map(l => {
    const r = { pitch: 0, formant: 0, gain: 0.5, hp: 20, lp: 20000 };
    for (const k of Object.keys(r)) { const v = Number(l?.[k]); if (Number.isFinite(v)) r[k] = clamp(v, LAYER_RANGES[k]); }
    return r;
  });
  return o;
}
export function effective(p) {
  const o = normalize(p), f = FILTERS[o.filter];
  if (f) for (const [k, v] of Object.entries(f)) o[k] = k === "drive" ? Math.max(o.drive, v) : v;
  return o;
}
const usesPV = (pitch, formant) => Math.abs(pitch) > 1e-3 || Math.abs(formant) > 1e-3;
/** Algorithmic latency in ms added by a preset (on top of the browser's own capture/WebRTC latency). */
export function latencyMs(p, sampleRate = 48000) {
  const e = effective(p);
  const pv = usesPV(e.pitch, e.formant) || e.layers.some(l => l.gain > 0 && usesPV(l.pitch, l.formant));
  return Math.round(((pv ? 768 : 0) + 128) / sampleRate * 1000 + (e.vibrato > 0 ? 6 : 0));
}

function driveCurve(amount) {
  if (amount <= 0) return null;
  const n = 4096, c = new Float32Array(n), k = 1 + amount * 9, w = Math.min(1, amount * 1.5);
  for (let i = 0; i < n; i++) { const x = (i * 2) / (n - 1) - 1; c[i] = (1 - w) * x + w * Math.tanh(k * x) / k; }
  return c;
}
export function ceilingCurve(ceil) {
  const n = 8192, c = new Float32Array(n), knee = 0.75 * ceil;
  for (let i = 0; i < n; i++) { const x = (i * 2) / (n - 1) - 1, a = Math.abs(x);
    c[i] = Math.sign(x) * (a <= knee ? a : knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee))); }
  return c;
}
const dB = v => Math.pow(10, v / 20);
function impulse(ctx, seconds) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds)), b = ctx.createBuffer(2, len, ctx.sampleRate);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch); let e = 0;
    for (let i = 0; i < len; i++) { d[i] = rnd() * Math.pow(1 - i / len, 3); e += d[i] * d[i]; }
    const g = 1 / Math.sqrt(e); for (let i = 0; i < len; i++) d[i] *= g;
  }
  return b;
}

/** Gentle glue compressor -> fast limiter -> oversampled ceiling (-1.5 dBFS sample peak, keeps true peak under -1 dBTP). */
export function safetyStage(ctx, { glue = true } = {}) {
  const comp = ctx.createDynamicsCompressor(), lim = ctx.createDynamicsCompressor(), ceiling = ctx.createWaveShaper();
  Object.entries(glue ? { threshold: -20, knee: 12, ratio: 2.5, attack: 0.01, release: 0.2 } : { threshold: 0, knee: 0, ratio: 1, attack: 0.01, release: 0.2 }).forEach(([k, v]) => comp[k].value = v);
  Object.entries({ threshold: -2, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }).forEach(([k, v]) => lim[k].value = v);
  ceiling.curve = ceilingCurve(dB(-1.5)); ceiling.oversample = "4x";
  // Chromium/WebKit DynamicsCompressor adds automatic makeup gain (measured +4.99 dB glue, +1.14 dB limiter); undo it.
  const compTrim = ctx.createGain(), limTrim = ctx.createGain();
  compTrim.gain.value = glue ? dB(-4.99) : 1; limTrim.gain.value = dB(-1.14);
  comp.connect(compTrim).connect(lim).connect(limTrim).connect(ceiling);
  return { input: comp, output: ceiling, comp, lim, ceiling };
}

/** Equal-power wet/dry insert: in → (dry, wet path) → out. Returns { dry, wet, out, set(amount, wetTrim) }. */
function insert(ctx, input, wetIn, wetOut) {
  const dry = ctx.createGain(), wet = ctx.createGain(), out = ctx.createGain();
  input.connect(dry).connect(out); input.connect(wetIn); wetOut.connect(wet).connect(out);
  return { out, dry, wet, set(a, t, trim = 1) { t(dry.gain, Math.cos(a * Math.PI / 2)); t(wet.gain, Math.sin(a * Math.PI / 2) * trim); } };
}
const lfo = (ctx, type = "sine") => { const o = ctx.createOscillator(); o.type = type; const g = ctx.createGain(); g.gain.value = 0; o.connect(g); o.start(); return { osc: o, amt: g }; };

/** Build the voice chain after `input`. Returns { output, analyser, set(params), setBypass(bool), dispose(), nodes, latencyMs }. */
export function buildChain(ctx, input, { worklet = true } = {}) {
  const N = () => ctx.createGain(), BQ = type => { const f = ctx.createBiquadFilter(); f.type = type; return f; };
  const disposers = [];
  // ---- EQ ----
  const inG = N(), hp = BQ("highpass"), lp = BQ("lowpass"), pk = BQ("peaking"), ls = BQ("lowshelf"), hs = BQ("highshelf");
  const ls2 = BQ("lowshelf"), hs2 = BQ("highshelf"), notch = BQ("notch"), eqTrim = N();
  ls.frequency.value = 300; hs.frequency.value = 2500; pk.Q.value = 1.2; ls2.frequency.value = 200; hs2.frequency.value = 4000;
  input.connect(inG); inG.connect(hp).connect(lp).connect(pk).connect(ls).connect(hs).connect(ls2).connect(hs2).connect(notch).connect(eqTrim);
  // ---- voice layers ----
  const mk = name => { if (!worklet) return null; try { return new AudioWorkletNode(ctx, name, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }); } catch (e) { return null; } };
  const voiceSum = N();
  const mainPV = mk("tknv-pv"), mainG = N();
  eqTrim.connect(mainPV ?? mainG); if (mainPV) mainPV.connect(mainG); mainG.connect(voiceSum);
  const layers = [];
  for (let i = 0; i < MAX_LAYERS; i++) {
    const pv = mk("tknv-pv"), lhp = BQ("highpass"), llp = BQ("lowpass"), g = N(); g.gain.value = 0;
    if (pv) { pv.parameters.get("active").value = 0; eqTrim.connect(pv).connect(lhp); } else eqTrim.connect(lhp);
    lhp.connect(llp).connect(g).connect(voiceSum); layers.push({ pv, hp: lhp, lp: llp, g });
  }
  // ---- vibrato (modulated delay) ----
  const vibD = ctx.createDelay(0.05), vib = lfo(ctx); vib.amt.connect(vibD.delayTime);
  const vibIns = N(); voiceSum.connect(vibIns);
  const vibBypass = N(), vibWet = N(), vibOut = N();
  vibIns.connect(vibBypass).connect(vibOut); vibIns.connect(vibD).connect(vibWet).connect(vibOut);
  // ---- FX worklet ----
  const fx = mk("tknv-fx"); const fxOut = N();
  if (fx) vibOut.connect(fx).connect(fxOut); else vibOut.connect(fxOut);
  // ---- drive, ring ----
  const shaper = ctx.createWaveShaper(); shaper.oversample = "4x"; fxOut.connect(shaper);
  const ringDry = N(), ringWet = N(), ringMod = N(), ringOsc = ctx.createOscillator(), ringSum = N();
  ringMod.gain.value = 0; ringOsc.connect(ringMod.gain); ringOsc.start();
  shaper.connect(ringDry).connect(ringSum); shaper.connect(ringMod).connect(ringWet).connect(ringSum);
  // ---- chorus (two modulated taps) ----
  const chIn = N(), chOut = N(), chD1 = ctx.createDelay(0.1), chD2 = ctx.createDelay(0.1), chL1 = lfo(ctx), chL2 = lfo(ctx);
  chD1.delayTime.value = 0.018; chD2.delayTime.value = 0.026; chL1.osc.frequency.value = 0.8; chL2.osc.frequency.value = 1.13;
  chL1.amt.gain.value = 0.003; chL2.amt.gain.value = 0.004; chL1.amt.connect(chD1.delayTime); chL2.amt.connect(chD2.delayTime);
  chIn.connect(chD1).connect(chOut); chIn.connect(chD2).connect(chOut);
  const chorus = insert(ctx, ringSum, chIn, chOut);
  // ---- flanger ----
  const flD = ctx.createDelay(0.05), flFb = N(), flL = lfo(ctx), flIn = N(), flOut = N(); flD.delayTime.value = 0.003; flL.amt.gain.value = 0.0022;
  flL.amt.connect(flD.delayTime); flIn.connect(flD).connect(flOut); flD.connect(flFb).connect(flD);
  const flanger = insert(ctx, chorus.out, flIn, flOut);
  // ---- phaser (4 all-pass stages swept by one LFO) ----
  const phIn = N(), phL = lfo(ctx), aps = [0, 1, 2, 3].map(() => { const a = BQ("allpass"); a.frequency.value = 900; a.Q.value = 0.7; phL.amt.connect(a.frequency); return a; });
  phL.amt.gain.value = 600; aps.reduce((n, a) => n.connect(a), phIn);
  const phaser = insert(ctx, flanger.out, phIn, aps[3]);
  // ---- comb (short delay with feedback, LFO-swept = wet gurgle) ----
  const cbD = ctx.createDelay(0.1), cbFb = N(), cbL = lfo(ctx), cbIn = N(), cbOut = N();
  cbL.amt.connect(cbD.delayTime); cbIn.connect(cbD).connect(cbOut); cbD.connect(cbFb).connect(cbD);
  const comb = insert(ctx, phaser.out, cbIn, cbOut);
  // ---- tremolo ----
  const trem = N(), trL = lfo(ctx); trL.amt.connect(trem.gain); comb.out.connect(trem);
  // ---- space: dry / reverb / echo ----
  const dryG = N(), conv = ctx.createConvolver(); conv.normalize = false;
  const revTone = BQ("highshelf"), revLow = BQ("lowshelf"), revG = N(); revTone.frequency.value = 3000; revLow.frequency.value = 400;
  const del = ctx.createDelay(2), fb = N(), delG = N(), fxSum = N();
  trem.connect(dryG).connect(fxSum); trem.connect(conv).connect(revTone).connect(revLow).connect(revG).connect(fxSum);
  trem.connect(del); del.connect(fb).connect(del); del.connect(delG).connect(fxSum);
  // ---- mix, safety ----
  const fxG = N(), cleanG = N(), master = N(), analyser = ctx.createAnalyser(), output = N();
  analyser.fftSize = 1024;
  fxSum.connect(fxG).connect(master); input.connect(cleanG).connect(master);
  const { comp, lim, ceiling } = safetyStage(ctx);
  master.connect(comp); ceiling.connect(output); ceiling.connect(analyser);

  let irKey = null, params = normalize({}), bypass = false;
  const t = (param, v) => param.setTargetAtTime(v, ctx.currentTime, 0.015);
  const setV = (param, v) => { if (param) param.setValueAtTime(v, ctx.currentTime); };
  function apply() {
    const p = effective(params);
    t(inG.gain, p.gain); t(hp.frequency, p.hp); t(lp.frequency, p.lp); t(pk.frequency, p.peakFreq); t(pk.gain, p.peakGain);
    t(ls.gain, -p.tilt * 0.6); t(hs.gain, p.tilt); t(ls2.gain, p.lowShelf); t(hs2.gain, p.highShelf);
    t(notch.frequency, p.notchFreq > 0 ? p.notchFreq : ctx.sampleRate * 0.49); t(notch.Q, p.notchFreq > 0 ? p.notchQ : 40);   // off = razor-thin notch parked at Nyquist
    // EQ makeup: trim by half of every positive boost.
    const boost = Math.max(0, p.peakGain) + Math.max(0, p.tilt) + Math.max(0, -p.tilt) * 0.6 + Math.max(0, p.lowShelf) + Math.max(0, p.highShelf);
    t(eqTrim.gain, dB(-boost / 2));
    // Voice layers: energy-normalised so stacking never sums hot.
    const lg = layers.map((L, i) => p.layers[i]?.gain ?? 0), norm = 1 / Math.sqrt(1 + lg.reduce((a, g) => a + g * g, 0));
    setV(mainPV?.parameters.get("pitch"), Math.pow(2, p.pitch / 12)); setV(mainPV?.parameters.get("formant"), Math.pow(2, p.formant / 12));
    t(mainG.gain, norm);
    layers.forEach((L, i) => { const l = p.layers[i];
      setV(L.pv?.parameters.get("active"), l && l.gain > 0 ? 1 : 0);
      if (l) { setV(L.pv?.parameters.get("pitch"), Math.pow(2, l.pitch / 12)); setV(L.pv?.parameters.get("formant"), Math.pow(2, l.formant / 12)); t(L.hp.frequency, l.hp); t(L.lp.frequency, l.lp); }
      t(L.g.gain, (l?.gain ?? 0) * norm); });
    // Vibrato: depth 1 ≈ ±60 cents.
    const vr = p.vibratoRate, vd = p.vibrato > 0 ? (Math.pow(2, 0.6 * p.vibrato / 12) - 1) / (2 * Math.PI * vr) : 0;
    t(vib.osc.frequency, vr); t(vib.amt.gain, vd); vibD.delayTime.value = 0.006;
    t(vibBypass.gain, p.vibrato > 0 ? 0 : 1); t(vibWet.gain, p.vibrato > 0 ? 1 : 0);
    if (fx) { const P = k => fx.parameters.get(k);
      for (const k of ["vocoder", "carrierFreq", "growl", "growlRate", "crushBits", "crushRate", "crushMix", "breath", "breathTone"]) setV(P(k), p[k]);
      setV(P("carrier"), CARRIERS.indexOf(p.carrier)); }
    shaper.curve = driveCurve(p.drive);
    const ring = p.ringFreq > 0 ? p.ringMix : 0;
    t(ringOsc.frequency, Math.max(1, p.ringFreq)); t(ringDry.gain, 1 - ring); t(ringWet.gain, ring * Math.SQRT2);
    chorus.set(p.chorus * 0.7, t, 0.75);
    t(flL.osc.frequency, p.flangerRate); t(flFb.gain, 0.6 * p.flanger); flanger.set(p.flanger * 0.6, t, Math.sqrt(1 - Math.pow(0.6 * p.flanger, 2)));
    t(phL.osc.frequency, p.phaserRate); phaser.set(p.phaser * 0.5, t);
    t(cbD.delayTime, p.combTime / 1000); t(cbL.osc.frequency, Math.max(0.01, p.combLfo)); t(cbL.amt.gain, p.combLfo > 0 ? p.combTime / 1000 * 0.4 : 0);
    t(cbFb.gain, p.combFeedback); comb.set(p.comb * 0.8, t, Math.sqrt(1 - p.combFeedback * p.combFeedback));
    t(trL.osc.frequency, p.tremoloRate); t(trem.gain, 1 - p.tremolo * 0.4); t(trL.amt.gain, p.tremolo * 0.4);
    const key = p.reverb > 0 ? p.reverbSize.toFixed(1) : null;
    if (key && key !== irKey) { conv.buffer = impulse(ctx, p.reverbSize); irKey = key; }
    t(revTone.gain, p.reverbTone * 9); t(revLow.gain, -p.reverbTone * 6);
    const dl = p.delay * Math.sqrt(1 - p.feedback * p.feedback);
    const wetE = p.reverb * p.reverb + dl * dl, n2 = 1 / Math.sqrt(1 + wetE);
    t(revG.gain, p.reverb * n2 * dB(-Math.abs(p.reverbTone) * 3)); t(dryG.gain, n2);
    t(del.delayTime, p.delayTime); t(fb.gain, p.feedback); t(delG.gain, dl * n2);
    t(fxG.gain, bypass ? 0 : p.mix); t(cleanG.gain, bypass ? 1 : 1 - p.mix);
  }
  apply();
  const oscs = [ringOsc, vib.osc, chL1.osc, chL2.osc, flL.osc, phL.osc, cbL.osc, trL.osc];
  return {
    output, analyser, hasWorklet: !!mainPV && !!fx, safety: { comp, lim, ceiling },
    nodes: { mainPV, layers, fx, chorus, flanger, phaser, comb, vibrato: vibD, tremolo: trem, notch, lowShelf: ls2, highShelf: hs2, reverbTone: revTone },
    get params() { return { ...params, layers: params.layers.map(l => ({ ...l })) }; }, get bypass() { return bypass; },
    get latencyMs() { return latencyMs(params, ctx.sampleRate); },
    set(p) { params = normalize(p); apply(); },
    setBypass(b) { bypass = !!b; apply(); },
    dispose() { try { oscs.forEach(o => o.stop()); input.disconnect(); output.disconnect(); master.disconnect(); } catch (e) { /* already gone */ } }
  };
}
