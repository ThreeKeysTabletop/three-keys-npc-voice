#!/usr/bin/env python3
"""Distinctness check for rendered demos (reference/measurement only, not shipped).
Features per demo: MFCC 1-19 mean+std, spectral centroid/bandwidth/flatness/rolloff, median f0 (pyin), modulation (RMS-envelope std).
Each feature is z-scored across all demos; distance = RMS of z-differences. Pairs closer than FLAG x the median pairwise distance are flagged.
Usage: python distinctness.py <demos dir> [--flag 0.5] [--json out.json]"""
import sys, os, json, itertools, numpy as np, librosa
d = sys.argv[1]; FLAG = float(sys.argv[sys.argv.index("--flag") + 1]) if "--flag" in sys.argv else 0.5
files = sorted((p, f) for p in os.listdir(d) if os.path.isdir(os.path.join(d, p)) for f in os.listdir(os.path.join(d, p)) if f.endswith(".wav"))
feats, names = [], []
for p, f in files:
    y, sr = librosa.load(os.path.join(d, p, f), sr=22050, mono=True)
    yt, _ = librosa.effects.trim(y, top_db=45)
    m = librosa.feature.mfcc(y=yt, sr=sr, n_mfcc=20)[1:]
    cen = librosa.feature.spectral_centroid(y=yt, sr=sr)[0]; bw = librosa.feature.spectral_bandwidth(y=yt, sr=sr)[0]
    fl = librosa.feature.spectral_flatness(y=yt)[0]; ro = librosa.feature.spectral_rolloff(y=yt, sr=sr)[0]
    f0, vf, _ = librosa.pyin(yt, fmin=30, fmax=1000, sr=sr); f0m = np.nanmedian(f0) if np.any(~np.isnan(f0)) else 30.0
    rms = librosa.feature.rms(y=yt)[0]
    v = np.concatenate([m.mean(1), m.std(1), [np.log(cen.mean()), np.log(bw.mean()), np.log(fl.mean() + 1e-6), np.log(ro.mean()), np.log(f0m) * 3, np.std(rms) / (np.mean(rms) + 1e-9), np.nanmean(vf) if vf is not None else 0]])
    feats.append(v); names.append((p, f[:-4], float(cen.mean()), float(f0m)))
X = np.array(feats); Z = (X - X.mean(0)) / (X.std(0) + 1e-9)
D = np.sqrt(((Z[:, None, :] - Z[None, :, :]) ** 2).mean(-1))
iu = np.triu_indices(len(names), 1); med = float(np.median(D[iu])); thr = FLAG * med
same_pack = [(i, j) for i, j in zip(*iu) if names[i][0] == names[j][0]]
flags = [(names[i][0], names[i][1], names[j][1], float(D[i, j])) for i, j in same_pack if D[i, j] < thr]
cross = [(f"{names[i][0]}/{names[i][1]}", f"{names[j][0]}/{names[j][1]}", float(D[i, j])) for i, j in zip(*iu) if names[i][0] != names[j][0] and D[i, j] < thr]
print(f"demos={len(names)} median pairwise distance={med:.3f} flag threshold={thr:.3f} ({FLAG} x median)")
for pk in sorted(set(n[0] for n in names)):
    idx = [k for k, n in enumerate(names) if n[0] == pk]; sub = [(D[a, b], names[a][1], names[b][1]) for a, b in itertools.combinations(idx, 2)]
    mn = min(sub); print(f"\n[{pk}] closest pair: {mn[1]} ~ {mn[2]} = {mn[0]:.3f}; mean within-pack = {np.mean([s[0] for s in sub]):.3f}")
    for k in idx:
        nn = min((D[k, j], names[j][1]) for j in idx if j != k)
        print(f"  {names[k][1]:<18} centroid {names[k][2]:7.0f} Hz  f0 {names[k][3]:6.1f} Hz  nearest: {nn[1]:<18} {nn[0]:.3f}")
print(f"\nFLAGGED within-pack pairs (< {thr:.3f}): {len(flags)}"); [print("  ", f) for f in flags]
print(f"Cross-pack pairs under threshold (info): {len(cross)}"); [print("  ", c) for c in cross[:15]]
if "--json" in sys.argv:
    json.dump({"median": med, "threshold": thr, "flags": flags, "cross": cross, "voices": names,
               "nearest": {f"{names[k][0]}/{names[k][1]}": min((float(D[k, j]), f"{names[j][0]}/{names[j][1]}") for j in range(len(names)) if j != k) for k in range(len(names))}},
              open(sys.argv[sys.argv.index("--json") + 1], "w"), indent=1)
