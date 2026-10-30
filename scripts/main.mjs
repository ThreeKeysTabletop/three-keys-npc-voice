/**
 * Three Keys NPC Voice — live voice changer for the GM's microphone in Foundry VTT's built-in A/V.
 * (c) Three Keys Tabletop, MIT License.
 */
import { BUILTIN } from "./builtins.mjs";
import { buildChain, normalize, DEFAULTS, RANGES, FILTERS, CARRIERS, LAYER_RANGES, MAX_LAYERS, latencyMs } from "./dsp.mjs";

const ID = "three-keys-npc-voice";
const ROOT = `modules/${ID}`;
const L = (k, d) => d ? game.i18n.format(`TKNV.${k}`, d) : game.i18n.localize(`TKNV.${k}`);
const get = k => game.settings.get(ID, k);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slug = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "preset";
const SLOTS = 10;

/* ------------------------------------------------------------------ */
/*  Presets                                                           */
/* ------------------------------------------------------------------ */
export { BUILTIN };

function allPresets() {
  const out = BUILTIN.map(p => ({ id: p.id, name: L(p.nameKey), group: "builtin", params: normalize(p.params) }));
  let custom = {}, packs = {};
  try { custom = get("customPresets") ?? {}; packs = get("packs") ?? {}; } catch (e) { /* settings not ready */ }
  for (const [id, p] of Object.entries(custom)) out.push({ id: `custom.${id}`, name: p.name, group: "custom", params: normalize(p.params) });
  for (const pack of Object.values(packs)) for (const p of pack.presets ?? [])
    out.push({ id: `pack.${pack.id}.${p.id}`, name: p.name, group: `pack.${pack.id}`, pack, params: normalize(p.params) });
  return out;
}
const findPreset = id => allPresets().find(p => p.id === id);
const quickPresets = () => allPresets().filter(p => p.group === "builtin" || p.group === "custom");

function groups() {
  const g = new Map(); let packs = {};
  try { packs = get("packs") ?? {}; } catch (e) { /* not ready */ }
  for (const p of allPresets()) {
    if (!g.has(p.group)) {
      const pk = packs[p.group.slice(5)];
      g.set(p.group, { id: p.group, label: p.group === "builtin" ? L("Group.builtin") : p.group === "custom" ? L("Group.custom") : L("Group.pack", { name: pk.name, version: pk.version, author: pk.author }), pack: pk ?? null, presets: [] });
    }
    g.get(p.group).presets.push(p);
  }
  return [...g.values()];
}
function presetOptions(selected, { inherit = false } = {}) {
  let h = inherit ? `<option value="">${esc(L("Assign.inherit"))}</option>` : "";
  for (const g of groups()) h += `<optgroup label="${esc(g.label)}">${g.presets.map(p => `<option value="${esc(p.id)}" ${p.id === selected ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>`;
  return h;
}

/* ---------- packs & import/export ---------- */
export function validatePack(data) {
  if (typeof data === "string") data = JSON.parse(data);
  if (!data || data.type !== "three-keys-npc-voice-pack") throw new Error(L("Err.notPack"));
  for (const k of ["id", "name", "author", "version"]) if (typeof data[k] !== "string" || !data[k]) throw new Error(L("Err.packField", { field: k }));
  if (!Array.isArray(data.presets) || !data.presets.length) throw new Error(L("Err.packEmpty"));
  const ids = new Set();
  const presets = data.presets.map(p => {
    if (!p?.name) throw new Error(L("Err.presetName"));
    let id = slug(p.id || p.name); while (ids.has(id)) id += "-2"; ids.add(id);
    return { id, name: String(p.name), params: normalize(p.params ?? {}) };
  });
  return { id: slug(data.id), name: data.name, author: data.author, version: data.version, description: String(data.description ?? ""), presets };
}
async function importPack(data) {
  const pack = validatePack(data);
  const packs = foundry.utils.deepClone(get("packs") ?? {});
  packs[pack.id] = pack; await game.settings.set(ID, "packs", packs);
  ui.notifications.info(L("Notify.packImported", { name: pack.name, count: pack.presets.length }));
  refreshUI(); return pack;
}
async function removePack(id) {
  const packs = foundry.utils.deepClone(get("packs") ?? {}); delete packs[id];
  await game.settings.set(ID, "packs", packs); refreshUI();
}
function exportCustom() {
  return { type: "three-keys-npc-voice-presets", version: 1, presets: Object.entries(get("customPresets") ?? {}).map(([id, p]) => ({ id, name: p.name, params: p.params })) };
}
async function importCustom(data) {
  if (typeof data === "string") data = JSON.parse(data);
  if (data?.type === "three-keys-npc-voice-pack") return importPack(data);
  if (data?.type !== "three-keys-npc-voice-presets" || !Array.isArray(data.presets)) throw new Error(L("Err.notPresets"));
  const custom = foundry.utils.deepClone(get("customPresets") ?? {});
  let n = 0;
  for (const p of data.presets) { if (!p?.name) continue; custom[slug(p.id || p.name)] = { name: String(p.name), params: normalize(p.params ?? {}) }; n++; }
  await game.settings.set(ID, "customPresets", custom);
  ui.notifications.info(L("Notify.imported", { count: n })); refreshUI(); return n;
}
async function saveCustom(id, name, params) {
  const custom = foundry.utils.deepClone(get("customPresets") ?? {});
  id = id ? slug(id) : slug(name); if (!id) id = foundry.utils.randomID();
  custom[id] = { name: String(name || id), params: normalize(params) };
  await game.settings.set(ID, "customPresets", custom); refreshUI(); return `custom.${id}`;
}
async function deleteCustom(id) {
  const custom = foundry.utils.deepClone(get("customPresets") ?? {}); delete custom[id.replace(/^custom\./, "")];
  await game.settings.set(ID, "customPresets", custom); if (engine.presetId === id) engine.setPreset("natural"); refreshUI();
}

/* ------------------------------------------------------------------ */
/*  Engine: getUserMedia patch + Web Audio sessions                   */
/* ------------------------------------------------------------------ */
const nativeGUM = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
const engine = {
  ctx: null, workletReady: null, sessions: new Set(), presetId: "natural", bypass: false, monitor: false, preview: null, listeners: new Set(),
  allowed() {
    try { return get("enabled") && (game.user.isGM || get("allowPlayers")); } catch (e) { return false; }
  },
  async ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      this.workletReady = this.ctx.audioWorklet.addModule(`${ROOT}/scripts/worklets.js`).then(() => true, e => { console.warn(`${ID} | voice worklets unavailable, pitch/formant/vocoder disabled`, e); return false; });
      const resume = () => { if (this.ctx.state !== "running") this.ctx.resume().catch(() => {}); };
      for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, resume, { capture: true });
    }
    if (this.ctx.state !== "running") this.ctx.resume().catch(() => {});
    return this.workletReady;
  },
  async wrap(raw) {
    const audio = raw.getAudioTracks();
    if (!audio.length) return raw;
    const worklet = await this.ensureContext();
    const ctx = this.ctx;
    const src = ctx.createMediaStreamSource(new MediaStream(audio));
    const chain = buildChain(ctx, src, { worklet });
    const dest = ctx.createMediaStreamDestination();
    const mon = ctx.createGain(); mon.gain.value = this.monitor ? 1 : 0;
    chain.output.connect(dest); chain.output.connect(mon); mon.connect(ctx.destination);
    const session = { raw, audio, chain, dest, mon };
    const p = findPreset(this.presetId) ?? findPreset("natural");
    chain.set(p.params); chain.setBypass(this.bypass);
    const out = new MediaStream([...dest.stream.getAudioTracks(), ...raw.getVideoTracks()]);
    const processed = dest.stream.getAudioTracks()[0];
    const stop = processed.stop.bind(processed);
    processed.stop = () => { stop(); this.endSession(session); };
    session.processed = processed;
    this.sessions.add(session); this.applyConstraints(); this.emit();
    return out;
  },
  endSession(s) {
    if (!this.sessions.delete(s)) return;
    s.audio.forEach(t => t.stop()); s.chain.dispose(); try { s.mon.disconnect(); } catch (e) { /* gone */ }
    this.emit();
  },
  get active() { for (const s of this.sessions) return s; return null; },
  isNatural() { return this.bypass || this.presetId === "natural"; },
  applyConstraints() {
    let on = false; try { on = get("disableProcessing"); } catch (e) { /* not ready */ }
    if (!on) return;
    const nat = this.isNatural();
    for (const s of this.sessions) for (const t of s.audio)
      t.applyConstraints({ echoCancellation: nat, noiseSuppression: nat, autoGainControl: nat }).catch(() => {});
  },
  setPreset(id, { silent = false } = {}) {
    const p = findPreset(id); if (!p) return false;
    this.presetId = id; for (const s of this.sessions) s.chain.set(p.params);
    this.applyConstraints(); this.emit();
    if (game.ready) game.settings.set(ID, "lastPreset", id).catch(() => {});
    if (!silent && game.ready && get("notifySwitch")) ui.notifications.info(L("Notify.switched", { name: p.name }));
    Hooks.callAll(`${ID}.presetChanged`, id);
    return true;
  },
  previewParams(params) { for (const s of this.sessions) s.chain.set(params); },
  restorePreset() { const p = findPreset(this.presetId); if (p) for (const s of this.sessions) s.chain.set(p.params); },
  setBypass(b) { this.bypass = !!b; for (const s of this.sessions) s.chain.setBypass(this.bypass); this.applyConstraints(); this.emit(); return this.bypass; },
  setMonitor(b) {
    this.monitor = !!b; for (const s of this.sessions) s.mon.gain.setTargetAtTime(this.monitor ? 1 : 0, this.ctx.currentTime, 0.02);
    if (this.monitor) ui.notifications.warn(L("Notify.monitorWarn"));
    this.emit(); return this.monitor;
  },
  level() {
    const s = this.active; if (!s) return null;
    const a = s.chain.analyser, d = new Float32Array(a.fftSize); a.getFloatTimeDomainData(d);
    let sum = 0; for (const v of d) sum += v * v; return Math.sqrt(sum / d.length);
  },
  async startPreview() {
    if (this.preview) return this.preview;
    this.preview = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); this.emit(); return this.preview;
  },
  stopPreview() { this.preview?.getTracks().forEach(t => t.stop()); this.preview = null; this.emit(); },
  emit() { for (const f of this.listeners) try { f(); } catch (e) { console.warn(e); } }
};

if (nativeGUM) {
  navigator.mediaDevices.getUserMedia = async function (constraints) {
    if (!constraints?.audio || !engine.allowed()) return nativeGUM(constraints);
    let c = constraints;
    try {
      if (get("disableProcessing")) {
        const a = typeof c.audio === "object" ? { ...c.audio } : {};
        const nat = engine.isNatural();
        Object.assign(a, { echoCancellation: nat, noiseSuppression: nat, autoGainControl: nat });
        c = { ...c, audio: a };
      }
    } catch (e) { /* settings not ready */ }
    const raw = await nativeGUM(c);
    try { return await engine.wrap(raw); }
    catch (e) { console.warn(`${ID} | could not build voice chain, sending the unprocessed mic`, e); return raw; }
  };
}

/* ------------------------------------------------------------------ */
/*  Token / actor assignment                                          */
/* ------------------------------------------------------------------ */
const presetForToken = doc => doc?.getFlag?.(ID, "preset") || doc?.actor?.getFlag(ID, "preset") || null;
async function setActorPreset(actor, id) {
  id = id || null;
  const update = id ? { [`flags.${ID}.preset`]: id, [`prototypeToken.flags.${ID}.preset`]: id }
    : { [`flags.${ID}.-=preset`]: null, [`prototypeToken.flags.${ID}.-=preset`]: null };
  await actor.update(update); return id;
}
async function setTokenPreset(tokenDoc, id) {
  if (id) await tokenDoc.setFlag(ID, "preset", id); else await tokenDoc.unsetFlag(ID, "preset");
  return id || null;
}
async function assignDialog(current, title) {
  const { DialogV2 } = foundry.applications.api;
  return DialogV2.prompt({
    window: { title }, classes: ["tknv-assign"],
    content: `<p>${esc(L("Assign.hint"))}</p><div class="form-group"><label>${esc(L("Assign.voice"))}</label><select name="preset">${presetOptions(current, { inherit: true })}</select></div>`,
    ok: { label: L("Assign.save"), callback: (ev, btn) => btn.form.elements.preset.value }, rejectClose: false
  });
}
function onControl(token, controlled) {
  if (!engine.allowed() || !get("autoSwitch")) return;
  if (controlled) { const id = presetForToken(token.document); if (id && findPreset(id)) return engine.setPreset(id); if (get("releaseNatural")) engine.setPreset("natural", { silent: true }); return; }
  setTimeout(() => { if (!canvas.tokens?.controlled.length && get("releaseNatural")) engine.setPreset("natural", { silent: true }); }, 0);
}

/* ------------------------------------------------------------------ */
/*  Quick preset bar                                                  */
/* ------------------------------------------------------------------ */
let bar = null, meterRAF = null;
function renderBar() {
  bar?.remove(); bar = null; cancelAnimationFrame(meterRAF);
  if (!engine.allowed() || !get("showBar")) return;
  bar = document.createElement("section"); bar.id = "tknv-bar"; bar.className = "tknv-bar";
  const q = quickPresets();
  const btns = q.map((p, i) => `<button type="button" class="tknv-preset ${p.id === engine.presetId ? "active" : ""}" data-preset="${esc(p.id)}" data-tooltip="${esc(i < SLOTS ? L("Bar.slot", { n: (i + 1) % 10 }) : "")}">${esc(p.name)}</button>`).join("");
  const packOpts = groups().filter(g => g.pack);
  bar.innerHTML = `<span class="tknv-title"><i class="fa-solid fa-masks-theater"></i> ${esc(L("Bar.title"))}</span>${btns}
    ${packOpts.length ? `<select class="tknv-more" data-tooltip="${esc(L("Bar.more"))}"><option value="">${esc(L("Bar.more"))}</option>${packOpts.map(g => `<optgroup label="${esc(g.label)}">${g.presets.map(p => `<option value="${esc(p.id)}" ${p.id === engine.presetId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>`).join("")}</select>` : ""}
    <button type="button" class="tknv-bypass ${engine.bypass ? "on" : ""}" data-tooltip="${esc(L("Bar.bypassTip"))}"><i class="fa-solid fa-power-off"></i> ${esc(L("Bar.bypass"))}</button>
    <button type="button" class="tknv-monitor ${engine.monitor ? "on" : ""}" data-tooltip="${esc(L("Bar.monitorTip"))}"><i class="fa-solid fa-headphones"></i></button>
    <button type="button" class="tknv-test ${engine.preview ? "on" : ""}" data-tooltip="${esc(L("Bar.testTip"))}"><i class="fa-solid fa-microphone"></i></button>
    ${game.user.isGM ? `<button type="button" class="tknv-edit" data-tooltip="${esc(L("Bar.editor"))}"><i class="fa-solid fa-sliders"></i></button>` : ""}
    <span class="tknv-meter" data-tooltip="${esc(L("Bar.meterTip"))}"><span class="tknv-meter-fill"></span></span>
    <span class="tknv-status">${esc(engine.sessions.size ? L("Bar.live") : L("Bar.noMic"))}</span>`;
  bar.addEventListener("click", ev => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.preset) engine.setPreset(b.dataset.preset);
    else if (b.classList.contains("tknv-bypass")) engine.setBypass(!engine.bypass);
    else if (b.classList.contains("tknv-monitor")) engine.setMonitor(!engine.monitor);
    else if (b.classList.contains("tknv-test")) engine.preview ? engine.stopPreview() : engine.startPreview().catch(e => ui.notifications.error(L("Notify.micFail", { error: e.message })));
    else if (b.classList.contains("tknv-edit")) openEditor();
  });
  bar.querySelector(".tknv-more")?.addEventListener("change", ev => { if (ev.target.value) engine.setPreset(ev.target.value); });
  document.body.append(bar);
  const fill = bar.querySelector(".tknv-meter-fill");
  const tick = () => { const l = engine.level(); fill.style.width = `${Math.min(100, (l ?? 0) * 400)}%`; fill.classList.toggle("hot", (l ?? 0) > 0.2); meterRAF = requestAnimationFrame(tick); };
  tick();
}
function refreshUI() { renderBar(); if (editor?.rendered) editor.render(); }
engine.listeners.add(() => { if (game.ready) renderBar(); });

/* ------------------------------------------------------------------ */
/*  Preset editor                                                     */
/* ------------------------------------------------------------------ */
const SECTIONS = {
  tone: ["gain", "filter", "hp", "lp", "peakFreq", "peakGain", "tilt", "lowShelf", "highShelf", "notchFreq", "notchQ"],
  voice: ["pitch", "formant"],
  character: ["drive", "growl", "growlRate", "ringFreq", "ringMix", "vocoder", "carrier", "carrierFreq", "crushBits", "crushRate", "crushMix", "breath", "breathTone"],
  motion: ["chorus", "flanger", "flangerRate", "phaser", "phaserRate", "tremolo", "tremoloRate", "vibrato", "vibratoRate", "comb", "combTime", "combFeedback", "combLfo"],
  space: ["reverb", "reverbSize", "reverbTone", "delay", "delayTime", "feedback", "mix"]
};
const FIELDS = Object.values(SECTIONS).flat();
let editor = null;
class PresetEditor extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "tknv-editor", classes: ["tknv-editor"], tag: "form",
    window: { title: "TKNV.Editor.title", icon: "fa-solid fa-sliders", resizable: true },
    position: { width: 760, height: 640 },
    form: { submitOnChange: false, closeOnSubmit: false },
    actions: {
      select: PresetEditor.#onSelect, save: PresetEditor.#onSave, saveAs: PresetEditor.#onSaveAs, remove: PresetEditor.#onDelete,
      exportJson: PresetEditor.#onExport, importJson: PresetEditor.#onImportClick, removePack: PresetEditor.#onRemovePack, use: PresetEditor.#onUse
    }
  };
  selected = engine.presetId;
  async _renderHTML() {
    const p = findPreset(this.selected) ?? findPreset("natural"); this.selected = p.id;
    const v = p.params;
    const list = groups().map(g => `<div class="tknv-group" data-group="${esc(g.id)}"><h4>${esc(g.label)}${g.pack ? ` <a data-action="removePack" data-pack="${esc(g.pack.id)}" data-tooltip="${esc(L("Editor.removePack"))}"><i class="fa-solid fa-trash"></i></a>` : ""}</h4>
      ${g.pack?.description ? `<p class="hint">${esc(g.pack.description)}</p>` : ""}
      ${g.presets.map(x => `<a class="tknv-item ${x.id === p.id ? "active" : ""}" data-action="select" data-preset="${esc(x.id)}">${esc(x.name)}</a>`).join("")}</div>`).join("");
    const row = k => {
      if (k === "carrier") return `<div class="form-group"><label>${esc(L(`Field.${k}`))}</label><select name="carrier">${CARRIERS.map(f => `<option value="${f}" ${v.carrier === f ? "selected" : ""}>${esc(L(`Carrier.${f}`))}</option>`).join("")}</select></div>`;
      if (k === "filter") return `<div class="form-group"><label>${esc(L(`Field.${k}`))}</label><select name="filter">${Object.keys(FILTERS).map(f => `<option value="${f}" ${v.filter === f ? "selected" : ""}>${esc(L(`Filter.${f}`))}</option>`).join("")}</select></div>`;
      const [a, b, s] = RANGES[k];
      return `<div class="form-group"><label>${esc(L(`Field.${k}`))}</label><input type="range" name="${k}" min="${a}" max="${b}" step="${s}" value="${v[k]}"><output>${v[k]}</output></div>`;
    };
    const isCustom = p.group === "custom";
    return `<div class="tknv-ed"><nav class="tknv-list">${list}</nav><div class="tknv-form">
      <div class="form-group"><label>${esc(L("Editor.name"))}</label><input type="text" name="name" value="${esc(isCustom ? p.name : L("Editor.copyOf", { name: p.name }))}"></div>
      <p class="tknv-latency">${esc(L("Editor.latency", { ms: latencyMs(v) }))}</p>
      ${Object.entries(SECTIONS).map(([sec, ks]) => `<fieldset><legend>${esc(L(`Section.${sec}`))}</legend>${ks.map(row).join("")}</fieldset>`).join("")}
      <fieldset class="tknv-layers"><legend>${esc(L("Section.layers"))}</legend><p class="hint">${esc(L("Editor.layersHint"))}</p>
      ${Array.from({ length: MAX_LAYERS }, (_, i) => { const l = v.layers[i] ?? { pitch: 0, formant: 0, gain: 0, hp: 20, lp: 20000 };
        return `<div class="tknv-layer" data-layer="${i}"><b>${esc(L("Editor.layer", { n: i + 1 }))}</b>${Object.entries(LAYER_RANGES).map(([k, [a, b, s]]) =>
          `<label>${esc(L(`Layer.${k}`))} <input type="number" name="layer${i}.${k}" min="${a}" max="${b}" step="${s}" value="${l[k]}"></label>`).join("")}</div>`; }).join("")}</fieldset>
      <p class="hint">${esc(L("Editor.liveHint"))}</p></div></div>
      <footer class="form-footer">
        <button type="button" data-action="use"><i class="fa-solid fa-check"></i> ${esc(L("Editor.use"))}</button>
        ${isCustom ? `<button type="button" data-action="save"><i class="fa-solid fa-floppy-disk"></i> ${esc(L("Editor.save"))}</button>` : ""}
        <button type="button" data-action="saveAs"><i class="fa-solid fa-copy"></i> ${esc(L("Editor.saveAs"))}</button>
        ${isCustom ? `<button type="button" data-action="remove"><i class="fa-solid fa-trash"></i> ${esc(L("Editor.delete"))}</button>` : ""}
        <button type="button" data-action="exportJson"><i class="fa-solid fa-file-export"></i> ${esc(L("Editor.export"))}</button>
        <button type="button" data-action="importJson"><i class="fa-solid fa-file-import"></i> ${esc(L("Editor.import"))}</button>
        <input type="file" class="tknv-file" accept=".json,application/json" hidden>
      </footer>`;
  }
  _replaceHTML(html, content) {
    content.innerHTML = html;
    content.addEventListener("input", ev => {
      const el = ev.target; if (el.type === "range") el.nextElementSibling.textContent = el.value;
      const p = this.readParams(); engine.previewParams(p);
      const lat = content.querySelector(".tknv-latency"); if (lat) lat.textContent = L("Editor.latency", { ms: latencyMs(p) });
    });
    content.addEventListener("change", ev => { if (["filter", "carrier"].includes(ev.target.name) || ev.target.type === "number") engine.previewParams(this.readParams()); });
    content.querySelector(".tknv-file").addEventListener("change", async ev => {
      const f = ev.target.files?.[0]; if (!f) return;
      try { await importCustom(await foundry.utils.readTextFromFile(f)); } catch (e) { ui.notifications.error(L("Notify.importFail", { error: e.message })); }
      ev.target.value = "";
    });
  }
  readParams() {
    const p = {}; for (const k of FIELDS) { const el = this.element.querySelector(`[name="${k}"]`); if (el) p[k] = k === "filter" || k === "carrier" ? el.value : Number(el.value); }
    p.layers = [];
    for (let i = 0; i < MAX_LAYERS; i++) { const l = {}; for (const k of Object.keys(LAYER_RANGES)) l[k] = Number(this.element.querySelector(`[name="layer${i}.${k}"]`)?.value ?? 0); if (l.gain > 0) p.layers.push(l); }
    return normalize(p);
  }
  _onClose(o) { super._onClose(o); engine.restorePreset(); }
  static #onSelect(ev, t) { this.selected = t.dataset.preset; engine.restorePreset(); this.render(); }
  static async #onUse() { engine.setPreset(this.selected); }
  static async #onSave() {
    const id = this.selected.replace(/^custom\./, "");
    this.selected = await saveCustom(id, this.element.querySelector("[name=name]").value, this.readParams());
    ui.notifications.info(L("Notify.saved"));
  }
  static async #onSaveAs() {
    const name = this.element.querySelector("[name=name]").value || L("Editor.untitled");
    let id = slug(name); const custom = get("customPresets") ?? {}; while (custom[id]) id += "-2";
    this.selected = await saveCustom(id, name, this.readParams());
    ui.notifications.info(L("Notify.saved"));
  }
  static async #onDelete() { await deleteCustom(this.selected); this.selected = "natural"; this.render(); }
  static #onExport() { foundry.utils.saveDataToFile(JSON.stringify(exportCustom(), null, 2), "application/json", "npc-voice-presets.json"); }
  static #onImportClick() { this.element.querySelector(".tknv-file").click(); }
  static async #onRemovePack(ev, t) {
    const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: L("Editor.removePack") }, content: `<p>${esc(L("Editor.removePackConfirm"))}</p>`, rejectClose: false });
    if (ok) await removePack(t.dataset.pack);
  }
}
function openEditor() {
  if (!game.user.isGM) return ui.notifications.warn(L("Notify.gmOnly"));
  editor ??= new PresetEditor(); editor.selected = engine.presetId; return editor.render({ force: true });
}

/* ------------------------------------------------------------------ */
/*  Hooks                                                             */
/* ------------------------------------------------------------------ */
Hooks.once("init", () => {
  const reg = (k, o) => game.settings.register(ID, k, { name: `TKNV.Settings.${k}.name`, hint: `TKNV.Settings.${k}.hint`, ...o });
  reg("enabled", { scope: "client", config: true, type: Boolean, default: true, requiresReload: true });
  reg("allowPlayers", { scope: "world", config: true, type: Boolean, default: false, requiresReload: true });
  reg("showBar", { scope: "client", config: true, type: Boolean, default: true, onChange: () => renderBar() });
  reg("autoSwitch", { scope: "client", config: true, type: Boolean, default: true });
  reg("switchOnChat", { scope: "client", config: true, type: Boolean, default: true });
  reg("releaseNatural", { scope: "client", config: true, type: Boolean, default: true });
  reg("disableProcessing", { scope: "client", config: true, type: Boolean, default: true });
  reg("notifySwitch", { scope: "client", config: true, type: Boolean, default: false });
  reg("customPresets", { scope: "world", config: false, type: Object, default: {}, onChange: () => refreshUI() });
  reg("packs", { scope: "world", config: false, type: Object, default: {}, onChange: () => refreshUI() });
  reg("lastPreset", { scope: "client", config: false, type: String, default: "natural" });

  const kb = (name, o) => game.keybindings.register(ID, name, { precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL, ...o });
  for (let i = 0; i < SLOTS; i++) kb(`slot${i + 1}`, {
    name: game.i18n.format("TKNV.Keys.slot", { n: i + 1 }), hint: "TKNV.Keys.slotHint",
    editable: [{ key: `Digit${(i + 1) % 10}`, modifiers: ["Alt"] }],
    onDown: () => { if (!engine.allowed()) return false; const p = quickPresets()[i]; if (p) engine.setPreset(p.id); return !!p; }
  });
  kb("bypass", { name: "TKNV.Keys.bypass", editable: [{ key: "KeyB", modifiers: ["Alt"] }], onDown: () => { if (!engine.allowed()) return false; engine.setBypass(!engine.bypass); return true; } });
  kb("toggleBar", { name: "TKNV.Keys.toggleBar", editable: [{ key: "KeyV", modifiers: ["Alt"] }], onDown: () => { if (!engine.allowed()) return false; game.settings.set(ID, "showBar", !get("showBar")); return true; } });
});

Hooks.once("ready", () => {
  const last = get("lastPreset"); if (findPreset(last)) engine.presetId = last;
  game.modules.get(ID).api = {
    engine, presets: allPresets, groups, getPreset: () => engine.presetId, setPreset: id => engine.setPreset(id),
    setBypass: b => engine.setBypass(b), setMonitor: b => engine.setMonitor(b), level: () => engine.level(),
    startPreview: () => engine.startPreview(), stopPreview: () => engine.stopPreview(),
    setActorPreset, setTokenPreset, presetForToken, openEditor, saveCustom, deleteCustom,
    exportPresets: exportCustom, importPresets: importCustom, importPack, removePack, validatePack,
    latencyMs: id => latencyMs((findPreset(id ?? engine.presetId) ?? findPreset("natural")).params),
    get chain() { return engine.active?.chain ?? null; }
  };
  renderBar();
});

Hooks.on("controlToken", onControl);

Hooks.on("createChatMessage", msg => {
  if (!engine.allowed() || !get("switchOnChat") || msg.author?.id !== game.user.id) return;
  const sp = msg.speaker ?? {};
  const tok = sp.token ? (game.scenes.get(sp.scene)?.tokens.get(sp.token)) : null;
  const id = tok ? presetForToken(tok) : game.actors.get(sp.actor)?.getFlag(ID, "preset");
  if (id && id !== engine.presetId && findPreset(id)) engine.setPreset(id);
});

Hooks.on("getHeaderControlsActorSheetV2", (app, controls) => {
  if (!engine.allowed() || !app.document?.isOwner) return;
  controls.push({ icon: "fa-solid fa-masks-theater", label: "TKNV.Assign.button", action: "tknvVoice",
    onClick: async () => { const id = await assignDialog(app.document.getFlag(ID, "preset"), L("Assign.titleActor", { name: app.document.name })); if (id !== null && id !== undefined) await setActorPreset(app.document, id); } });
});

Hooks.on("renderTokenHUD", (hud, html) => {
  if (!engine.allowed()) return;
  const el = html instanceof HTMLElement ? html : html[0];
  const col = el.querySelector(".col.right"); if (!col) return;
  const doc = hud.document;
  const cur = presetForToken(doc);
  const b = document.createElement("button");
  b.type = "button"; b.className = "control-icon tknv-hud"; b.dataset.tooltip = L("Assign.hudTip", { name: findPreset(cur)?.name ?? L("Preset.none") });
  b.innerHTML = `<i class="fa-solid fa-masks-theater"></i>`;
  b.addEventListener("click", async ev => {
    ev.preventDefault(); ev.stopPropagation();
    const id = await assignDialog(doc.getFlag(ID, "preset") ?? "", L("Assign.titleToken", { name: doc.name }));
    if (id === null || id === undefined) return;
    await setTokenPreset(doc, id);
    if (doc.object?.controlled) { const p = presetForToken(doc); engine.setPreset(p && findPreset(p) ? p : "natural"); }
  });
  col.append(b);
});
