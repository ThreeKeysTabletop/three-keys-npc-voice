// Render demo WAVs for each preset pack with the module's own DSP (OfflineAudioContext in Chromium).
// Usage: node tools/render-demos.mjs <source.wav> <out demos dir> <pack.json|dir>...
//   env: FOUNDRY_TESTS (playwright), TARGET_LUFS (-16), ONLY=<pack ids>, PIPER="<piper bin>|<model.onnx>" to announce voice names.
// Per pack: demos/<pack>/<voice>.wav, demos/<pack>.mp3 (1 s gaps), demos/<pack>-announced.mp3, demos/<pack>.cue + <pack>-cues.md.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url)); const mod = dirname(here);
const FT = process.env.FOUNDRY_TESTS || join(mod, '../foundry-test/tests');
const { chromium } = createRequire(join(FT, 'package.json'))('playwright');
const [src, demosDir, ...inputs] = process.argv.slice(2).map(p => resolve(p));
const packFiles = inputs.flatMap(p => p.endsWith('.json') ? [p] : readdirSync(p).filter(f => f.endsWith('.json')).map(f => join(p, f)));
const srv = createServer((q, r) => { const p = q.url === '/' ? null : join(mod, q.url.split('?')[0]);
  if (!p) { r.setHeader('content-type', 'text/html'); return r.end('<html></html>'); }
  try { const b = readFileSync(p); r.setHeader('content-type', extname(p) === '.wav' ? 'audio/wav' : 'text/javascript'); r.end(b); } catch { r.statusCode = 404; r.end(); } }).listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(); const page = await browser.newPage(); await page.goto(base + '/');
const TARGET = Number(process.env.TARGET_LUFS ?? -16);
const lufs = f => { const e = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  return Number(e.slice(e.lastIndexOf('Integrated loudness')).match(/I:\s+(-?[\d.]+)/)[1]); };
const render = async (params, trim) => { const r = await page.evaluate(async ({ b64, params, trim }) => {
      const { buildChain, safetyStage } = await import('/scripts/dsp.mjs');
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const tmp = new OfflineAudioContext(1, 1, 48000); const buf = await tmp.decodeAudioData(bytes.buffer);
      const len = buf.length + Math.round(buf.sampleRate * 2.5);
      const ctx = new OfflineAudioContext(1, len, buf.sampleRate); await ctx.audioWorklet.addModule('/scripts/worklets.js');
      const s = ctx.createBufferSource(); s.buffer = buf; const ch = buildChain(ctx, s); ch.set(params);
      const g = ctx.createGain(); g.gain.value = trim; const safe = safetyStage(ctx, { glue: false });
      ch.output.connect(g).connect(safe.input); safe.output.connect(ctx.destination); s.start();
      const d = (await ctx.startRendering()).getChannelData(0);
      const u8 = new Uint8Array(d.buffer); let bin = ''; for (let i = 0; i < u8.length; i += 32768) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
      return { b: btoa(bin), sr: buf.sampleRate };
    }, { b64: wavB64, params, trim }); const u = Buffer.from(r.b, 'base64'); return { data: new Float32Array(u.buffer, u.byteOffset, u.length / 4), sr: r.sr }; };
const wavB64 = readFileSync(src).toString('base64');
const toWav = (f32, sr) => { const n = f32.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767))), 44 + i * 2); return b; };
const SR = 48000, GAP = 1.0, ANN_GAP = 0.35;
const silence = sec => new Float32Array(Math.round(sec * SR));
const readWav = f => { const d = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 28 }).stdout;
  return new Float32Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.length)); };
const levelTo = (f32, target) => { const tmp = join(demosDir, '.lvl.wav'); writeFileSync(tmp, toWav(f32, SR)); const I = lufs(tmp); execFileSync('rm', [tmp]);
  const g = Math.pow(10, (target - I) / 20); let pk = 0; for (const v of f32) pk = Math.max(pk, Math.abs(v)); const gg = Math.min(g, 0.8 / pk); return f32.map(v => v * gg); };
const announce = name => { if (!process.env.PIPER) return null; const [bin, model] = process.env.PIPER.split('|'); const tmp = join(demosDir, '.ann.wav');
  spawnSync(bin, ['-m', model, '--volume', '0.5', '-f', tmp], { input: name + '.' }); const a = levelTo(readWav(tmp), TARGET - 2); execFileSync('rm', [tmp]); return a; };
const ts = sec => { const m = Math.floor(sec / 60), s2 = sec - m * 60; return `${String(m).padStart(2, '0')}:${s2.toFixed(2).padStart(5, '0')}`; };
const cueTs = sec => { const m = Math.floor(sec / 60), s2 = Math.floor(sec % 60), f = Math.floor((sec % 1) * 75); return `${String(m).padStart(2, '0')}:${String(s2).padStart(2, '0')}:${String(f).padStart(2, '0')}`; };
const encode = (f32, mp3) => { const tmp = mp3.replace(/\.mp3$/, '.tmp.wav'); writeFileSync(tmp, toWav(f32, SR));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-codec:a', 'libmp3lame', '-b:a', '192k', mp3]); execFileSync('rm', [tmp]); };
const cat = parts => { const n = parts.reduce((a, p) => a + p.length, 0), o = new Float32Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
mkdirSync(demosDir, { recursive: true });
for (const f of packFiles) {
  const pack = JSON.parse(readFileSync(f, 'utf8')); if (process.env.ONLY && !process.env.ONLY.split(',').includes(pack.id)) continue;
  const out = join(demosDir, pack.id); mkdirSync(out, { recursive: true });
  const plain = [], ann = [], cues = []; let tPlain = 0, tAnn = 0;
  for (const p of pack.presets) {
    // Pass 1 at unity to measure loudness, then re-render with a trim before a second safety stage to land at TARGET LUFS.
    let trim = 1, data, sr, I = null;
    for (let pass = 0; pass < 3; pass++) {
      ({ data, sr } = await render(p.params, trim));
      const tmp = join(out, `.${p.id}.tmp.wav`); writeFileSync(tmp, toWav(data, sr)); I = lufs(tmp); execFileSync('rm', [tmp]);
      if (Math.abs(I - TARGET) < 0.5) break;
      trim *= Math.pow(10, (TARGET - I) / 20);
    }
    const file = join(out, `${p.id}.wav`); writeFileSync(file, toWav(data, sr)); console.log(`${file}  trim=${(20 * Math.log10(trim)).toFixed(1)} dB  I=${I}`);
    const d = sr === SR ? Float32Array.from(data) : readWav(file);
    const a = announce(p.name);
    cues.push({ name: p.name, id: p.id, plain: tPlain, ann: tAnn, annVoice: tAnn + (a ? a.length / SR + ANN_GAP : 0) });
    plain.push(d, silence(GAP)); tPlain += d.length / SR + GAP;
    if (a) { ann.push(a, silence(ANN_GAP)); tAnn += a.length / SR + ANN_GAP; }
    ann.push(d, silence(GAP)); tAnn += d.length / SR + GAP;
  }
  const mp3 = join(demosDir, `${pack.id}.mp3`); encode(cat(plain), mp3); console.log(mp3);
  if (process.env.PIPER) { const m2 = join(demosDir, `${pack.id}-announced.mp3`); encode(cat(ann), m2); console.log(m2); }
  const cueLines = [`PERFORMER "${pack.author ?? 'Three Keys Tabletop'}"`, `TITLE "${pack.name} demo"`, `FILE "${pack.id}.mp3" MP3`];
  cues.forEach((c, i) => cueLines.push(`  TRACK ${String(i + 1).padStart(2, '0')} AUDIO`, `    TITLE "${c.name}"`, `    INDEX 01 ${cueTs(c.plain)}`));
  writeFileSync(join(demosDir, `${pack.id}.cue`), cueLines.join('\n') + '\n');
  const md = [`# ${pack.name} demo cue sheet`, '', `| # | Voice | ${pack.id}.mp3 | ${pack.id}-announced.mp3 (name) | announced (voice starts) |`, '|---|---|---|---|---|',
    ...cues.map((c, i) => `| ${i + 1} | ${c.name} | ${ts(c.plain)} | ${process.env.PIPER ? ts(c.ann) : '-'} | ${process.env.PIPER ? ts(c.annVoice) : '-'} |`)];
  writeFileSync(join(demosDir, `${pack.id}-cues.md`), md.join('\n') + '\n');
}
await browser.close(); srv.close();
