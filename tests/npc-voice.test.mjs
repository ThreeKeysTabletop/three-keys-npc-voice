// Three Keys NPC Voice end-to-end test (GM client, Chromium fake microphone).
// Usage: tests/run.sh   or   node tests/npc-voice.test.mjs   (env: URL, FOUNDRY_TESTS, OUT, PACKS=<dir of pack json>, VOICE=<wav for fake mic>)
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const FT = process.env.FOUNDRY_TESTS || join(here, '../../foundry-test/tests');
const PACKS = process.env.PACKS || join(here, '../../npc-voice-packs');
const { chromium } = createRequire(join(FT, 'package.json'))('playwright');
const base = process.env.URL || 'http://localhost:30000';
const out = process.env.OUT || join(FT, 'out', 'npc-voice');
mkdirSync(out, { recursive: true });
const ID = 'three-keys-npc-voice';
const results = [], errors = [], shots = [];
let lastStep = 'start';
const ok = (name, pass, detail = '') => { lastStep = name; results.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const voice = process.env.VOICE || join(PACKS, 'demos-source-voice.wav');
const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
if (existsSync(voice)) args.push(`--use-file-for-fake-audio-capture=${voice}`);
const browser = await chromium.launch({ args });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true, permissions: ['microphone', 'camera'], baseURL: base });
await ctx.route(url => !url.toString().startsWith(base), route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push(`console [after: ${lastStep}]: ${m.text()}`); });
page.on('pageerror', e => errors.push(`pageerror [after: ${lastStep}]: ${e.stack || e.message}`));
const shot = async name => { const p = join(out, `${name}.png`); await page.screenshot({ path: p }); shots.push(p); };
const api = (fn, arg) => page.evaluate(([ID, src, arg]) => { const api = game.modules.get(ID).api; return eval(src)(api, arg); }, [ID, fn.toString(), arg]);
const cur = () => page.evaluate(ID => game.modules.get(ID).api.getPreset(), ID);
const join_ = async () => {
  await page.goto(base + '/join'); await page.waitForSelector('select[name="userId"]', { timeout: 60000 });
  const uid = await page.$eval('select[name="userId"]', s => [...s.options].find(o => o.textContent.trim() === 'Gamemaster')?.value);
  await page.selectOption('select[name="userId"]', uid); await page.click('button[name="join"]');
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 120000 }); await sleep(2500);
};
const key = async combo => { await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.press(combo); await sleep(300); };

try {
  await join_();
  await page.evaluate(async ID => { for (const [k, v] of Object.entries({ customPresets: {}, packs: {}, lastPreset: 'natural', showBar: true, autoSwitch: true, switchOnChat: true, releaseNatural: true })) await game.settings.set(ID, k, v); }, ID);
  await sleep(500);

  // ---------- basics ----------
  const b = await page.evaluate(ID => ({ active: game.modules.get(ID).active, api: !!game.modules.get(ID).api, bar: !!document.querySelector('#tknv-bar'),
    builtins: game.modules.get(ID).api.presets().filter(p => p.group === 'builtin').map(p => p.id), barBtns: document.querySelectorAll('#tknv-bar .tknv-preset').length }), ID);
  ok('Module active, API and quick bar present', b.active && b.api && b.bar, JSON.stringify(b));
  ok('Exactly 4 built-in presets (Natural, Orc, Robot, Radio)', JSON.stringify(b.builtins) === '["natural","orc","robot","radio"]' && b.barBtns === 4, b.builtins.join(','));
  const loc = await page.evaluate(() => { const bad = [...document.querySelectorAll('#tknv-bar *')].map(e => e.childNodes).flatMap(n => [...n]).filter(n => n.nodeType === 3 && /TKNV\./.test(n.textContent)).length; return bad; });
  ok('Bar strings are localized (no raw TKNV.* keys)', loc === 0, `raw keys: ${loc}`);

  // ---------- chain build through the getUserMedia patch ----------
  const ch = await page.evaluate(async ID => {
    const a = game.modules.get(ID).api;
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    let peak = 0; for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 100)); peak = Math.max(peak, a.level() ?? 0); }
    const at = s.getAudioTracks()[0];
    const r = { audio: s.getAudioTracks().length, video: s.getVideoTracks().length, sessions: a.engine.sessions.size, worklet: a.chain?.hasWorklet,
      processedIsNotRaw: !!at && ![...a.engine.sessions][0].audio.includes(at), ctx: a.engine.ctx.state, level: peak,
      ec: [...a.engine.sessions][0].audio[0].getSettings().echoCancellation };
    globalThis.__tknvAV = s; return r;
  }, ID);
  ok('getUserMedia patched: processed audio track + original video track', ch.audio === 1 && ch.video === 1 && ch.processedIsNotRaw && ch.sessions === 1, JSON.stringify(ch));
  const safe = await api(a => ({ c: a.chain.safety?.comp.ratio.value, l: a.chain.safety?.lim.threshold.value, ceil: !!a.chain.safety?.ceiling.curve }));
  ok('Safety stage present (glue compressor, limiter, -1.5 dBFS ceiling)', safe.c === 2.5 && safe.l === -2 && safe.ceil, JSON.stringify(safe));
  ok('Web Audio chain built with pitch AudioWorklet, context running', ch.worklet === true && ch.ctx === 'running');
  ok('Live meter sees signal from fake mic (peak over 3 s)', ch.level > 0.001, `rms=${ch.level?.toFixed(4)}`);
  await shot('01-bar-live');

  // Foundry A/V client path (SimplePeer initializeLocalStream) if available
  const av = await page.evaluate(async ID => {
    const c = game.webrtc?.client; if (!c?.initializeLocalStream) return { skipped: 'no AV client' };
    const a = game.modules.get(ID).api; const before = a.engine.sessions.size;
    try { await game.webrtc.settings.set('client', 'audioSrc', 'default'); } catch (e) { /* ignore */ }
    const st = await c.initializeLocalStream().catch(e => null);
    if (!st) return { skipped: 'AV client could not open media (A/V disabled for this user?)' };
    const r = { audio: st.getAudioTracks().length, sessionsAdded: a.engine.sessions.size - before, label: st.getAudioTracks()[0]?.label ?? '' };
    st.getTracks().forEach(t => t.stop()); c.levelsStream?.getTracks().forEach(t => t.stop()); c.localStream = null; c.levelsStream = null;
    r.sessionsAfterStop = a.engine.sessions.size; return r;
  }, ID);
  ok('Foundry AVClient.initializeLocalStream routes through the chain (or skipped)', av.skipped ? true : av.audio === 1 && av.sessionsAdded === 1 && av.sessionsAfterStop === ch.sessions, JSON.stringify(av));

  // ---------- expanded DSP palette ----------
  const nodes = await api(a => { const n = a.chain.nodes; return { pv: !!n.mainPV, layers: n.layers.length, layerPV: n.layers.every(l => !!l.pv), fx: !!n.fx,
    fxParams: n.fx ? [...n.fx.parameters.keys()].sort().join(',') : '', chorus: !!n.chorus, flanger: !!n.flanger, phaser: !!n.phaser, comb: !!n.comb, vibrato: !!n.vibrato, tremolo: !!n.tremolo, notch: n.notch?.type }; });
  ok('New DSP nodes: phase-vocoder pitch/formant + 3 layer worklets, FX worklet, chorus/flanger/phaser/comb/vibrato/tremolo/notch',
    nodes.pv && nodes.layers === 3 && nodes.layerPV && nodes.fx && nodes.chorus && nodes.flanger && nodes.phaser && nodes.comb && nodes.vibrato && nodes.tremolo && nodes.notch === 'notch'
    && ['breath', 'carrier', 'crushBits', 'growl', 'vocoder'].every(k => nodes.fxParams.includes(k)), JSON.stringify(nodes));
  const heavy = await page.evaluate(async ID => {
    const a = game.modules.get(ID).api, n = a.chain.nodes, out = {};
    const peak = async () => { let m = 0; for (let i = 0; i < 25; i++) { await new Promise(r => setTimeout(r, 100)); const l = a.level(); if (!Number.isFinite(l)) return NaN; m = Math.max(m, l); } return m; };
    a.chain.set({ pitch: -5, formant: 4, layers: [{ pitch: -12, formant: -4, gain: 0.5 }, { pitch: 7, formant: 5, gain: 0.3 }] });
    out.layersLevel = await peak();
    out.layerActive = n.layers.map(l => l.pv.parameters.get('active').value); out.formant = +n.mainPV.parameters.get('formant').value.toFixed(3);
    a.chain.set({ vocoder: 1, carrier: 'chord', growl: 0.5, crushBits: 6, crushRate: 4, crushMix: 0.5, breath: 0.5, chorus: 1, flanger: 1, phaser: 1, comb: 1, combLfo: 2, tremolo: 1, vibrato: 1, notchFreq: 1000, lowShelf: 6, highShelf: 6, reverb: 1, reverbTone: 1, delay: 1, feedback: 0.9 });
    out.fx = ['vocoder', 'carrier', 'growl', 'crushBits', 'breath'].map(k => n.fx.parameters.get(k).value);
    out.allLevel = await peak(); out.latency = a.chain.latencyMs;
    out.lat = { natural: a.latencyMs('natural'), orc: a.latencyMs('orc'), robot: a.latencyMs('robot') };
    a.setPreset(a.getPreset()); return out;
  }, ID);
  ok('Pitch + independent formant + layers: layer worklets activate, signal flows', JSON.stringify(heavy.layerActive) === '[1,1,0]' && heavy.formant === +Math.pow(2, 4 / 12).toFixed(3) && heavy.layersLevel > 0.001, JSON.stringify({ a: heavy.layerActive, f: heavy.formant, l: heavy.layersLevel }));
  ok('Everything-on preset (vocoder, growl, crush, breath, mod FX, comb, shelves/notch, reverb, echo) stays finite and under the -1.5 dBFS ceiling', JSON.stringify(heavy.fx) === '[1,2,0.5,6,0.5]' && heavy.allLevel > 0.001 && heavy.allLevel < 0.85, JSON.stringify({ fx: heavy.fx, l: heavy.allLevel }));
  ok('Latency reporting: natural 3 ms, pitch/formant voices 19 ms', heavy.lat.natural === 3 && heavy.lat.orc === 19 && heavy.lat.robot === 3, JSON.stringify(heavy.lat));

  // ---------- preset switching, bypass, hotkeys ----------
  await api(a => a.setPreset('orc'));
  let pr = await api(a => ({ id: a.getPreset(), pitch: a.chain.params.pitch, drive: a.chain.params.drive, ec: [...a.engine.sessions][0].audio[0].getConstraints().echoCancellation }));
  ok('setPreset(orc) updates chain params', pr.id === 'orc' && pr.pitch === -4 && pr.drive === 0.1, JSON.stringify(pr));
  const ecNat = await api(async a => { a.setPreset('natural'); await new Promise(r => setTimeout(r, 200)); const v = [...a.engine.sessions][0].audio[0].getConstraints().echoCancellation; a.setPreset('orc'); return v; });
  ok('Browser echo cancellation constraint off while effect active, back on for Natural', pr.ec === false && ecNat === true, `orc=${pr.ec} natural=${ecNat}`);
  await page.click('#tknv-bar .tknv-preset[data-preset="robot"]'); await sleep(300);
  ok('Quick bar button switches preset', (await cur()) === 'robot' && await page.$eval('#tknv-bar .tknv-preset[data-preset="robot"]', e => e.classList.contains('active')));
  await key('Alt+Digit4'); const k4 = await cur();
  await key('Alt+Digit2'); const k2 = await cur();
  await key('Alt+Digit1'); const k1 = await cur();
  ok('Hotkeys Alt+4 / Alt+2 / Alt+1 select radio / orc / natural', k4 === 'radio' && k2 === 'orc' && k1 === 'natural', `${k4},${k2},${k1}`);
  await api(a => a.setPreset('orc'));
  await key('Alt+KeyB'); const by1 = await api(a => ({ b: a.engine.bypass, c: a.chain.bypass, btn: document.querySelector('#tknv-bar .tknv-bypass').classList.contains('on') }));
  const lvlBy = await api(async a => { let m = 0; for (let i = 0; i < 25; i++) { await new Promise(r => setTimeout(r, 100)); m = Math.max(m, a.level() ?? 0); } return m; });
  await shot('02-bypass-on');
  await key('Alt+KeyB'); const by2 = await api(a => a.chain.bypass);
  ok('Bypass hotkey (Alt+B) toggles chain bypass and bar state; signal still passes', by1.b && by1.c && by1.btn && by2 === false && lvlBy > 0.001, JSON.stringify(by1) + ` level=${lvlBy?.toFixed(4)}`);
  const kb = await page.evaluate(ID => [...game.keybindings.actions.keys()].filter(k => k.startsWith(ID)).length, ID);
  ok('12 configurable keybindings registered (10 slots, bypass, bar)', kb === 12, `${kb}`);
  await page.click('#tknv-bar .tknv-monitor'); await sleep(300);
  const mon = await api(a => ({ m: a.engine.monitor, g: [...a.engine.sessions][0].mon.gain.value, warn: [...document.querySelectorAll('#notifications li, #notifications .notification')].some(e => /headphones/i.test(e.textContent)) }));
  await page.click('#tknv-bar .tknv-monitor'); await sleep(200);
  ok('Self-monitor toggles with latency/headphone warning', mon.m && mon.warn, JSON.stringify(mon));

  // ---------- actor flags, token control, HUD, header, chat ----------
  const setup = await page.evaluate(async ID => {
    const a = game.modules.get(ID).api;
    const actor = await Actor.create({ name: 'TKNV Test Orc', type: 'npc' });
    await a.setActorPreset(actor, 'orc');
    const actor2 = await Actor.create({ name: 'TKNV Test Plain', type: 'npc' });
    const [t1] = await canvas.scene.createEmbeddedDocuments('Token', [{ ...(await actor.getTokenDocument({ x: 300, y: 300 })).toObject() }]);
    const [t2] = await canvas.scene.createEmbeddedDocuments('Token', [{ ...(await actor2.getTokenDocument({ x: 500, y: 300 })).toObject() }]);
    await new Promise(r => setTimeout(r, 800));
    return { actorId: actor.id, actor2Id: actor2.id, t1: t1.id, t2: t2.id, flag: actor.getFlag(ID, 'preset'), proto: actor.prototypeToken.flags?.[ID]?.preset, tokFlag: t1.getFlag(ID, 'preset') };
  }, ID);
  ok('Actor flag + prototype token flag set; new token inherits it', setup.flag === 'orc' && setup.proto === 'orc' && setup.tokFlag === 'orc', JSON.stringify(setup));
  await api(a => a.setPreset('natural'));
  const ctl = await page.evaluate(async ([ID, s]) => {
    const a = game.modules.get(ID).api, w = () => new Promise(r => setTimeout(r, 300)), r = {};
    canvas.tokens.get(s.t1).control({ releaseOthers: true }); await w(); r.onOrc = a.getPreset();
    canvas.tokens.get(s.t2).control({ releaseOthers: true }); await w(); r.onPlain = a.getPreset();
    await canvas.tokens.get(s.t2).document.setFlag(ID, 'preset', 'robot');
    canvas.tokens.get(s.t1).control({ releaseOthers: true }); await w(); canvas.tokens.get(s.t2).control({ releaseOthers: true }); await w(); r.onTokenOverride = a.getPreset();
    canvas.tokens.releaseAll(); await w(); r.released = a.getPreset();
    return r;
  }, [ID, setup]);
  ok('controlToken switches to token voice (orc), plain token -> Natural', ctl.onOrc === 'orc' && ctl.onPlain === 'natural', JSON.stringify(ctl));
  ok('Token-level override (robot) wins over actor voice', ctl.onTokenOverride === 'robot');
  ok('Release all -> Natural (setting)', ctl.released === 'natural');
  const hud = await page.evaluate(async ([ID, s]) => {
    const t = canvas.tokens.get(s.t1); t.control({ releaseOthers: true }); await canvas.hud.token.bind(t); await new Promise(r => setTimeout(r, 800));
    const b = document.querySelector('#token-hud .tknv-hud'); return { btn: !!b, tip: b?.dataset.tooltip };
  }, [ID, setup]);
  ok('Token HUD has NPC Voice button showing current voice', hud.btn && /Orc/.test(hud.tip), JSON.stringify(hud));
  await shot('03-token-hud');
  await page.click('#token-hud .tknv-hud'); await page.waitForSelector('.tknv-assign select[name="preset"]', { timeout: 5000 });
  await page.selectOption('.tknv-assign select[name="preset"]', 'radio'); await shot('04-assign-dialog');
  await page.click('.tknv-assign button[data-action="ok"]'); await sleep(800);
  const hudSet = await page.evaluate(([ID, s]) => ({ flag: canvas.scene.tokens.get(s.t1).getFlag(ID, 'preset'), cur: game.modules.get(ID).api.getPreset() }), [ID, setup]);
  ok('Assigning via token HUD sets token flag and switches live voice', hudSet.flag === 'radio' && hudSet.cur === 'radio', JSON.stringify(hudSet));
  await page.evaluate(async ([ID, s]) => { await canvas.scene.tokens.get(s.t1).unsetFlag(ID, 'preset'); canvas.hud.token.close(); canvas.tokens.releaseAll(); }, [ID, setup]); await sleep(400);
  const hdr = await page.evaluate(async ([ID, s]) => {
    const sh = game.actors.get(s.actor2Id).sheet; await sh.render({ force: true }); await new Promise(r => setTimeout(r, 1500));
    const c = [...sh._headerControlButtons()].find(c => c.action === 'tknvVoice'); return { found: !!c, label: c && game.i18n.localize(c.label), sheet: sh.constructor.name, id: sh.id };
  }, [ID, setup]);
  ok('Actor sheet header control present', hdr.found && hdr.label === 'NPC Voice', JSON.stringify(hdr));
  await shot('05-actor-sheet');
  // use the header control through its onClick
  const hdrP = page.evaluate(([ID, s]) => { const sh = game.actors.get(s.actor2Id).sheet; [...sh._headerControlButtons()].find(c => c.action === 'tknvVoice').onClick(new Event('click')); }, [ID, setup]);
  await page.waitForSelector('.tknv-assign select[name="preset"]', { timeout: 5000 }); await hdrP;
  await page.selectOption('.tknv-assign select[name="preset"]', 'robot'); await page.click('.tknv-assign button[data-action="ok"]'); await sleep(800);
  const hdrSet = await page.evaluate(([ID, s]) => { const a = game.actors.get(s.actor2Id); a.sheet.close(); return { f: a.getFlag(ID, 'preset'), p: a.prototypeToken.flags?.[ID]?.preset }; }, [ID, setup]);
  ok('Header control dialog saves actor + prototype token voice', hdrSet.f === 'robot' && hdrSet.p === 'robot', JSON.stringify(hdrSet));
  const chat = await page.evaluate(async ([ID, s]) => {
    const a = game.modules.get(ID).api; a.setPreset('natural');
    const actor = game.actors.get(s.actorId);
    const m = await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: 'Me smash!' }); await new Promise(r => setTimeout(r, 500));
    const r = a.getPreset(); await m.delete(); return r;
  }, [ID, setup]);
  ok('Chat message as actor switches voice (createChatMessage)', chat === 'orc', chat);

  // ---------- preset editor ----------
  await api(a => a.openEditor()); await page.waitForSelector('#tknv-editor .tknv-form', { timeout: 10000 });
  await page.click('#tknv-editor .tknv-item[data-preset="orc"]'); await sleep(400);
  await page.$eval('#tknv-editor input[name="pitch"]', e => { e.value = '-9'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  const prev = await api(a => a.chain.params.pitch);
  await page.fill('#tknv-editor input[name="layer0.pitch"]', '-12'); await page.fill('#tknv-editor input[name="layer0.gain"]', '0.4');
  await page.$eval('#tknv-editor input[name="layer0.gain"]', e => e.dispatchEvent(new Event('input', { bubbles: true })));
  await page.selectOption('#tknv-editor select[name="carrier"]', 'noise');
  const edLat = await page.$eval('#tknv-editor .tknv-latency', e => e.textContent);
  await page.fill('#tknv-editor input[name="name"]', 'Swamp Orc');
  await page.click('#tknv-editor button[data-action="saveAs"]'); await sleep(800);
  const saved = await page.evaluate(ID => game.settings.get(ID, 'customPresets'), ID);
  ok('Editor live-previews slider changes on the chain', prev === -9, `pitch=${prev}`);
  ok('Editor shows sections, layer inputs, carrier and latency', /19 ms/.test(edLat) && saved['swamp-orc']?.params.layers?.[0]?.pitch === -12 && saved['swamp-orc'].params.layers[0].gain === 0.4 && saved['swamp-orc'].params.carrier === 'noise', edLat + ' ' + JSON.stringify(saved['swamp-orc']?.params.layers));
  ok('Editor "Save as new" stores custom preset in world settings', saved['swamp-orc']?.name === 'Swamp Orc' && saved['swamp-orc'].params.pitch === -9 && saved['swamp-orc'].params.drive === 0.1, JSON.stringify(saved).slice(0, 160));
  ok('Custom preset appears in quick bar as slot 5', await page.$eval('#tknv-bar .tknv-preset:nth-of-type(5)', e => e.dataset.preset).catch(() => '') === 'custom.swamp-orc');
  await key('Alt+Digit5'); ok('Hotkey Alt+5 selects the custom preset', (await cur()) === 'custom.swamp-orc');
  let [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('#tknv-editor button[data-action="exportJson"]')]);
  const exp = JSON.parse(readFileSync(await dl.path(), 'utf8')); writeFileSync(join(out, 'exported-presets.json'), JSON.stringify(exp, null, 2));
  ok('Export JSON contains custom preset', exp.type === 'three-keys-npc-voice-presets' && exp.presets.some(p => p.name === 'Swamp Orc'), dl.suggestedFilename());
  const impFile = join(out, 'import-presets.json');
  writeFileSync(impFile, JSON.stringify({ type: 'three-keys-npc-voice-presets', version: 1, presets: [{ id: 'cave-troll', name: 'Cave Troll', params: { pitch: -7, filter: 'cave', reverb: 0.4 } }, { name: 'Clamped', params: { pitch: 99 } }] }));
  await page.setInputFiles('#tknv-editor input.tknv-file', impFile); await sleep(1200);
  const imp = await page.evaluate(ID => game.settings.get(ID, 'customPresets'), ID);
  ok('Import JSON (file input) adds presets, clamps out-of-range values', imp['cave-troll']?.params.filter === 'cave' && imp.clamped?.params.pitch === 24, Object.keys(imp).join(','));
  await shot('06-editor-custom');

  // ---------- preset packs ----------
  const packFiles = existsSync(PACKS) ? readdirSync(PACKS).filter(f => f.endsWith('.json')) : [];
  ok('Preset pack files found', packFiles.length === 3, packFiles.join(', '));
  for (const f of packFiles) {
    const raw = JSON.parse(readFileSync(join(PACKS, f), 'utf8'));
    await page.setInputFiles('#tknv-editor input.tknv-file', join(PACKS, f)); await sleep(1200);
    const r = await page.evaluate(([ID, id]) => { const p = game.settings.get(ID, 'packs')[id]; const g = game.modules.get(ID).api.groups().find(g => g.id === 'pack.' + id);
      const h = document.querySelector(`#tknv-editor .tknv-group[data-group="pack.${id}"] h4`)?.textContent ?? '';
      return { n: p?.presets.length, author: p?.author, version: p?.version, desc: !!p?.description, gn: g?.presets.length, h, items: document.querySelectorAll(`#tknv-editor .tknv-group[data-group="pack.${id}"] .tknv-item`).length }; }, [ID, raw.id]);
    ok(`Pack ${f} imports via editor: ${raw.presets.length} voices, grouped with author/version`, r.n === raw.presets.length && r.gn === r.n && r.items === r.n && r.author === 'Three Keys Tabletop' && r.version === raw.version && r.desc && r.h.includes(raw.name) && r.h.includes('Three Keys Tabletop'), JSON.stringify(r));
  }
  await shot('07-editor-packs');
  const pk = await page.evaluate(async ([ID, dragon]) => {
    const a = game.modules.get(ID).api; const r = {};
    await a.removePack('dragon-pack'); r.removed = !game.settings.get(ID, 'packs')['dragon-pack'];
    const p = await a.importPack(dragon); r.api = p.presets.length;
    r.set = a.setPreset('pack.dragon-pack.ancient'); r.pitch = a.chain.params.pitch;
    try { a.validatePack({ type: 'nope' }); r.bad = 'accepted'; } catch (e) { r.bad = 'rejected'; }
    try { a.validatePack({ type: 'three-keys-npc-voice-pack', id: 'x', name: 'x', author: 'x', version: '1', presets: [] }); r.empty = 'accepted'; } catch (e) { r.empty = 'rejected'; }
    r.barSelect = document.querySelectorAll('#tknv-bar select.tknv-more optgroup').length;
    return r;
  }, [ID, readFileSync(join(PACKS, 'dragon-pack.json'), 'utf8')]);
  ok('api.importPack / removePack; pack voice usable (Ancient Wyrm pitch -11); invalid packs rejected', pk.removed && pk.api === 13 && pk.set && pk.pitch === -11 && pk.bad === 'rejected' && pk.empty === 'rejected', JSON.stringify(pk));
  ok('Quick bar offers pack voices grouped by pack', pk.barSelect === 3, `${pk.barSelect} groups`);
  await page.selectOption('#tknv-bar select.tknv-more', 'pack.undead-spirits-pack.banshee'); await sleep(300);
  ok('Selecting pack voice from bar dropdown', (await cur()) === 'pack.undead-spirits-pack.banshee');
  await page.evaluate(() => { for (const a of foundry.applications.instances.values()) if (a.id === 'tknv-editor') a.close(); }); await sleep(400);
  await shot('08-bar-packs');

  // ---------- persistence after reload ----------
  await join_();
  const per = await page.evaluate(([ID, s]) => ({ f: game.actors.get(s.actorId)?.getFlag(ID, 'preset'), c: Object.keys(game.settings.get(ID, 'customPresets')).length, p: Object.keys(game.settings.get(ID, 'packs')).length, last: game.modules.get(ID).api.getPreset() }), [ID, setup]);
  ok('After reload: actor flag, custom presets, packs and last voice persist', per.f === 'orc' && per.c === 3 && per.p === 3 && per.last === 'pack.undead-spirits-pack.banshee', JSON.stringify(per));

  // ---------- cleanup ----------
  await page.evaluate(async ([ID, s]) => {
    await canvas.scene.deleteEmbeddedDocuments('Token', [s.t1, s.t2].filter(id => canvas.scene.tokens.get(id)));
    await Actor.deleteDocuments([s.actorId, s.actor2Id]);
    for (const [k, v] of Object.entries({ customPresets: {}, packs: {}, lastPreset: 'natural' })) await game.settings.set(ID, k, v);
  }, [ID, setup]);
} catch (e) { ok('Unexpected exception', false, e.stack || e.message); await shot('99-exception').catch(() => {}); }
ok('Zero console errors', errors.length === 0, errors.join('\n'));
await browser.close();
const pass = results.filter(r => r.pass).length;
writeFileSync(join(out, 'results.json'), JSON.stringify({ pass, total: results.length, results, errors, shots }, null, 2));
console.log(`\n${pass}/${results.length} passed`); console.log('Screenshots:\n ' + shots.join('\n '));
process.exit(pass === results.length ? 0 : 1);
