# Glass Simulator — v3

Physics simulator for glass composition: SiO₂, Na₂O, CaO grains in a 5×4 grid. Melt, fast-cool (amorphous), slow-cool (crystalline).

## Project layout

```
v3/
  meltPhysics.js      — all physics: forces, thermostat, bonds, liberation, cooling
  CompositionView.jsx — RAF loop, grid layout, precompute hooks, console diagnostics
  GlassViewer.jsx     — top-level UI: tabs (melt / glass / sand), controls, sliders
  renderer.js         — canvas drawing: atoms, bond lenses, strain colors, field blur
  sandPhysics.js      — sand/glass blob tab physics (separate system)
  glassPhysics.js     — glass tab rigid-body physics (separate system)
```

`dist/` is the built output. Always run `npm run build` at the repo root (`/Users/jkremer/Projects/glass/`) after any physics or UI change. Build takes ~75ms.

## Key constants

| Constant | Value | Meaning |
|---|---|---|
| `THERMAL_SPEED` | 0.0018 | `v_rms = 0.0018 × √T` px/substep |
| `ENERGY_UNIT` | `THERMAL_SPEED²/2 = 1.62e-6` | `ePerParticle = (T+273) × ENERGY_UNIT` |
| `SUBSTEPS` | 6 | physics substeps per RAF frame |
| `THERMOSTAT_TAU` | 0.10 | Berendsen coupling per substep |
| `FORCE_CUTOFF` | 20 px | early-reject threshold for pairwise forces |
| `ATTRACT_RANGE` | 40 px | long-range cooling attract cutoff |
| `FREE_EXCL` | 2.0 | freed-ion XPBD exclusion = 2× contact radius (all pairs except Si-O) |
| `_sioExclMult` | 1.4 | Si-O freed-pair XPBD exclusion multiplier (tunable via dev slider) |
| `ANCHOR_MELT_TEMP` | 600°C | above this, lattice anchor disabled forever |
| `SLOW_COOL_FRAMES` | 1440 | ~24s wall-clock |
| `FAST_COOL_FRAMES` | 270 | ~4.5s wall-clock |
| Temperature cap | 1800°C | hard ceiling in GlassViewer.jsx |
| `BOND_BREAK_ENERGY` | 1000 × ENERGY_UNIT | energy cost per broken Na-O bond (latent heat) |

## Atom species

| Type | r (px) | typeId | Notes |
|---|---|---|---|
| Si | 3.2 | 0 | hex lattice, a = 2×sioR0 |
| O | 2.3 | 1 | placed at cation midpoints |
| Na | 3.6 | 2 | square lattice, a = 24 px |
| Ca | 4.5 | 3 | square lattice, a = 24 px |

## Bond specs (PAIR_TABLE)

Opposite-charge attractive springs:

| Pair | r0 | k | oneSided | mult | breakStart | breakFull |
|---|---|---|---|---|---|---|
| Si-O | 9 px | 0.061 | true (lifted for freed pairs) | sioMult (temp-dep) | — | — |
| Na-O | 12 px | 0.042 | false (bilateral) | 1.05 | — | — |
| Ca-O | 12 px | 0.28 | false | 1.02 | — | — |

(breakStart/breakFull are obsolete — breaking is strain-based, see "Bond breaking".)

`oneSided: true` means the spring only attracts (d > r0); hard-sphere handles compression. For **freed Si-O pairs**, `oneSided` is lifted unconditionally: `effOneSided = spec.oneSided && !(isSiOSpec && isFreedPair)`.

Na-O has an extra short-range floor for freed pairs: `freeRepR0=7, freeRepK=0.50` — spring pushes apart below 7px when both atoms are freed.

Like-charge repulsion (repOnly, never attractive):

| Pair | r0 | k |
|---|---|---|
| Si-Si | **15.6** (dev slider 10–20, `setSiSiRepR0`) | 0.22 |
| O-O | 8 | 0.32 |
| Na-Na | 8 | 0.45 |
| Ca-Ca | 10 | 0.50 |
| Na-Ca | 9 | 0.38 |

Si-Si r0 = 15.6 keeps the Si-O-Si angle ≥ ~120° (with Si-O r0 = 9). At 12 it could fold to ~84°, letting the melt pack denser than the crystal. Crystal Si-Si spacing is 18 px, so the crystal is unaffected.

## Si-O coordination cap (melt density)

Freed Si-O pairs are capped at `COORD_TARGET` (Si ≤ 3 O, O ≤ 2 Si):
- At step start, `liveCount` / `siOCount` / `siOPairs` are built from last frame's `phys.bonds`, **skipping `b.broken`** (broken rigid bonds stay in `phys.bonds` for the pink fade until 40 px apart).
- A freed Si-O pair that isn't already bonded, where either side is full (`siOSat`), gets no spring and no long-range attract. Instead it gets plain repulsion inside r0.
- Dynamic Si-O bonds in `phys.bonds` are accepted nearest-first under the same cap (intact rigid Si-O count first), so the bond list never shows over-coordination.

Measured at 1500°C on the soda preset (headless): atoms within 20 px of each Si went from 6.05 to 5.44 (crystal 4.61), mean Si-Si nearest neighbour from 16.4 to 17.9 px, and over-coordinated Si from 1.6% to 0%.

Null-spec pairs (Na-Si, Ca-Si, etc.) get generic repulsion: `f = -REP_K × (cutoff - d)` where `cutoff = (ri + rj) × REP_MULT (1.8)`.

## Si-O capture range (sioMult)

Temperature-dependent capture multiplier, fades between:
- `SIO_COLD_MULT = 1.15` (below 200°C) — wide recapture, bonds unbreakable in practice
- `_sioHotMult = 1.07` (above 1100°C) — narrower, tunable via dev slider

At 1800°C: capture window = `9 × 1.07 = 9.63 px`. Si-O freed-pair XPBD exclusion = `5.5 × 1.4 = 7.7 px` (default `_sioExclMult = 1.4`). The 1.3 px gap below r₀=9px allows freed pairs to reach and settle at the spring minimum, giving correct thermal equilibrium.

**Resonance trap (avoid `_sioExclMult` 1.5–1.7):** when the XPBD floor falls inside the capture window (floor > r₀=9px but < capture=9.63px), freed Si-O pairs are held in a compression-only resonance band. They oscillate without settling at r₀, inflating KE to ~3.8× target and suppressing bonding to ~65% of atoms. Values ≥1.8 push the floor above the capture radius, disabling the spring entirely (0% bonded, KE = thermostat baseline).

**Calibration sweep at 1800°C, soda preset** (measured after removing freed-atom velocity boost and halved-forces hack):

| excl× | floor (px) | KE/target | SiO2 bonded% |
|-------|------------|-----------|--------------|
| 1.0   | 5.50       | 1.314     | 96%          |
| 1.2   | 6.60       | 1.362     | 97%          |
| **1.4** | **7.70** | **1.321** | **96%**      |
| 1.6   | 8.80       | 3.840     | 65%          |
| 1.8   | 9.90       | 1.037     | 0%           |

## Freed-ion exclusion (XPBD position correction)

Two separate XPBD loops:

**1. Rigid bond projection** (below 900°C only): corrects broken-or-intact rigid bond lengths directly. Skips bonds with `d > 3×r0` to avoid rubber-banding partners that drifted during melt. Disabled above 900°C so the network melts freely.

**2. Freed-ion exclusion** (all temperatures): pushes freed-freed pairs apart to a minimum separation. Unconditionally stable against high-velocity penetration.
- All pairs: `minD = (ri + rj) × FREE_EXCL (2.0)` — Na-O: 11.8px, O-O: 9.2px, etc.
- Si-O: `minD = (ri + rj) × _sioExclMult (1.4) = 7.7 px` — reduced so freed Si-O can reach the spring minimum at r₀=9px and re-bond.

The Si-O pair is identified as `pi.typeId + pj.typeId === 1` (only 0+1 sums to 1).

## Freed atoms (`latticeFreed`)

`phys.latticeFreed` is a `Uint8Array(n)`, set to 1 when an atom leaves the lattice. **Permanent — never cleared once set.**

**Liberation paths:**

1. **Auto-free** (`intactCount[i] === 0`): any atom whose intact rigid bond count drops to zero is freed immediately at the end of each step.
   - Si/O atoms: only auto-freed above 1300°C (below this, edge atoms can have intactCount=0 without being genuinely melted — `crystAnchor[i]` check gates this).
   - Na/Ca atoms: freed at any temperature when all their bonds break.

2. **Contact liberation**: a freed Na2O atom (or a SiO2 atom that has drifted > 4px from its lattice site) liberates any unliberated SiO2 atom within `(ri + rj + 1)` px. The newly freed atom gets a 0.12 px/substep outward kick. Its immediate Si-O rigid-bond partners (non-breakable bonds only — see dead code note) are also freed so the cluster moves together.

Freed atoms:
- Bypass the crystal anchor spring and displacement clamp
- Run KMT (ballistic velocity) with thermostat speed boost above 650°C: `vTarget × (1 + (T−650)/400)`. At 1600°C: multiplier = 3.375, KE per freed atom ≈ 11.4× bonded atoms.
- Have all forces halved at integration: `fx[i] *= 0.5`
- Are subject to the freed-ion exclusion XPBD

**`latticeFreed` vs. currently-bonded:** these are different. A freed atom can re-bond dynamically in the melt (`latticeFreed=1` but `isBonded=1`). `meltDebug()` reports both as separate columns (`liberated%` and `free%`).

## intactCount and bond break PE

At the end of each step, `intactCount[i]` = number of non-broken rigid bonds on atom i. Updated each step by scanning `phys.rigidBonds`.

Broken Na-O bonds accumulate `bondBreakPE = brokenNaO × BOND_BREAK_ENERGY`. This is subtracted from the thermostat target temperature:
```js
phys.latticeTemp = ePerParticle / ENERGY_UNIT - 273 - bondBreakPE / (n × ENERGY_UNIT)
```
Effect: as Na-O bonds break between 650–1130°C, the displayed temperature lags behind the slider — the energy is "absorbed" into breaking bonds rather than heating the system. This is the latent-heat effect.

## Freed Si-O bonding (hot liquid)

Two mechanisms active for freed Si-O pairs:

1. **Bilateral spring**: `effOneSided = false` for freed Si-O — creates a stable well at r0=9px. With XPBD exclusion at 8.8px, freed pairs can reach the 9.63px capture window and settle near 9px.
2. **Long-range attract** (always-on, not gated on coolingMode):
   ```js
   if (isSiOSpec && isFreedPair && _freeAttractSiOMult > 0 && d > spec.r0 * effMult && d < ATTRACT_RANGE) {
     f = _freeAttractSiOMult * 0.004 * spec.r0 / d
   }
   ```
   Pulls freed Si-O together from up to 40px. `_freeAttractSiOMult` (default 1.0) is tunable via dev slider.

The cooling attract loop (used by Na/Ca during cooling) is gated on `coolingMode !== null`. The freed Si-O attract above runs regardless — intentional.

## Bond breaking (strain-based, with feedback)

Each rigid bond has its own `breakStrain` (Si-O `_breakStrain` 0.07, Na-O `_naBreakStrain` 0.04) and `projectionCutoff` (Si-O 1700°C, Na/Ca-O 650°C), each varied by a random factor of ±`_breakStrainSpread` (0.15).

```js
effThreshold = rb.breakStrain × (1 + GAIN × _feedbackGainMult × fBroken)   // _feedbackGainMult default 100
break  when avgStrain > effThreshold   (avgStrain = EMA α=0.1 if _useEmaStrain, else instantaneous)
reform when strain ≤ _reformStrain (0)
```
GAIN interpolates from `FEEDBACK_GAIN_SILICA` (0.112) at 100% SiO₂ to `FEEDBACK_GAIN_SODA` (0.437) at 70% SiO₂. Their comments give the f=0/f=1 temperatures for a multiplier of 1; at 100 those temperatures no longer apply.

**Severance:** a freed Na/Ca (intactCount 0) within `_sevTriggerDist` (13 px) of either end of an intact Si-O rigid bond breaks it.

## Heating and cooling modes

Set via the `coolingMode` prop on `CompositionView`. Managed in `GlassViewer.jsx`.

| Mode | Mechanism | Duration | End target |
|---|---|---|---|
| `null` | thermostat holds at `meltTemp` slider | — | — |
| `'fastHeat'` | linear energy ramp | 270 frames (~4.5s) | 1500°C |
| `'slowHeat'` | linear energy ramp | 1440 frames (~24s) | 1500°C |
| `'fast'` | energy ramp + half-strength motif bias, no alignment | 270 frames | 200°C |
| `'slow'` | energy ramp + full motif bias with orientation alignment (+ hex-directed attract if attractK > 0) | 1440 frames | 200°C |

**Cooling gate:** Slow/Fast Cool are disabled unless `meltLocalTemp ≥ COOL_MIN_TEMP` (1500°C, `GlassViewer.jsx`). An active mode can still be clicked to turn it off. `startCooling` sets `energyInput = 0`, so `CompositionView`'s ramp is the only thing driving temperature (`onTempUpdate` syncs the LCD).

**Energy ramp**: `ePerParticle` interpolates linearly from `coolingStartERef` (energy at mode entry) to the end target each frame. `coolingStartERef` is captured at mode entry, so the ramp always starts from current temperature.

**Motif bias** (`buildMotif` / `applyMotifForces` in meltPhysics.js) uses *relative* targets, not absolute positions. Each step, each Si with 2–3 bonded O gets a best-fit 3-fold orientation φ, and its O are assigned to unique slots at φ + k·120°, distance r0. A soft spring pulls each O toward its slot, with an equal and opposite force on the Si. Each 2-coordinated O is pulled toward the midpoint of its two Si, which straightens Si-O-Si. Strength = `_motifStrength` (0.004) × ramp (0 at 1500°C → 1 at 600°C), halved for fast. In slow, each Si's φ moves `_motifAlign` (0.5) of the way toward its neighbours' orientation mod 60° (both honeycomb sublattices share φ mod 60°), so domains spread.

**Other cooling fixes:**
- Freed-atom kick multiplier fades from `_freedSpeedMult` to `_latticeSpeedMult` as the target T drops 1300 → 600°C.
- During cooling, the freed exclusion for Na-O / Ca-O pairs is `min(FREE_EXCL·(ri+rj), 0.9·r0)`. Otherwise Ca-O could never bond: 13.6 px floor vs 12 px r0.
- Re-integration counts *live* bonds (rigid or dynamic, `liveCount`), needing `min(_reintBondN, COORD_TARGET)` of them. Before, it needed rigid bonds, which only reform with original partners, so nothing ever re-integrated. On re-integration, `promoteBonds` turns the atom's dynamic bonds into new rigid bonds (`promoted: true`, r0 = spec.r0), so XPBD holds the new solid. The per-bond measurement arrays in CompositionView (`wasIntact` etc.) are sized at init, so they don't track promoted bonds.
- `attractK` now defaults to 0. At 0.10 the cooled solid over-densified: local density 7–8 vs crystal 4.6, and 70–100 Si-Si pairs inside r0.

**Unused:** `computeAmorphousTargets`, `computeSlowCoolTargets`, `initPrecompute`, `stepPrecompute`, `crystallize` are exported but never called.

**Headless results** (soda, 1500°C melt then cooling, attractK 0, motif 0.004, single seed): fast cool ends at local order 0.55, ψ6 0.60; slow cool at 0.72, 0.73. O-Si-O angle error goes from ~15° in the melt to ~11° after either cool. Only ~60% of atoms are freed at 1500°C, so the melt keeps some memory of the grains.

**Mode baseline**: when entering any non-null cooling/heating mode, `GlassViewer.jsx` captures the current bond counts as `modeBondCounts`. The COUNT display shows a "Run Δ" row (signed) from this snapshot. Cleared on reset or return to null mode.

## Bond count display (COUNT view)

Toggled by the "Count"/"Graph" button in the right panel. Reads from `phys.bonds` via `countBonds(phys)`, throttled to ~3×/s (300ms minimum interval).

**`countBonds(phys)`** iterates `phys.rigidBonds` and counts intact vs total, classified by atom typeId:
- Si-O: `(ti===0 || tj===0) && (ti===1 || tj===1)`
- Na-O: `ti===2 || tj===2`
- Ca-O: `ti===3 || tj===3`

Counts both intact rigid bonds AND dynamic bonds formed between freed atoms. Excludes broken rigid bonds (still in `phys.bonds` as pink entries until atoms are >40px apart).

**Display rows:**

| Row | Description |
|---|---|
| Before | `initialBondCounts` — captured on first RAF call after physics settles; reflects fully-loaded structure |
| Now | current live count |
| Broken | `max(0, before − now)` — clamped; net losses from the starting structure |
| Total | percentage of total broken bonds accounted for by this type |
| Run Δ | signed delta from `modeBondCounts` (mode entry snapshot); green = forming, red = breaking; only shown when a cooling/heating mode is active |

Na-O and Ca-O columns only appear if `initial.nao.total > 0` / `initial.cao.total > 0`.

**Bond numbers on atoms** (`bondNums`): when GRAPH is off, the bond count per atom is drawn as a label on the canvas. Toggled by "Bond #s" checkbox in dev panel.

## Bond rendering

`phys.bonds` is rebuilt each step. Two sources:

1. **Rigid bonds** (`phys.rigidBonds`): always rendered until atoms are >40 px apart. Broken rigid bonds continue rendering (strain increases as atoms separate → pink fade). Entry includes `broken: rb.broken` flag.
2. **Dynamic soft bonds**: scanned each frame for Si-O/Na-O/Ca-O pairs not in rigidBonds, within `r0 × renderMult`.

Strain color: `strainColorRGB(strain, breakStrain=0.25)`: `t=0` = warm grey, `t=1` = hot pink.

## Temperature display pipeline

**UI readout** (`phys.latticeTemp`):
```js
phys.latticeTemp = ePerParticle / ENERGY_UNIT - 273 - bondBreakPE / (n × ENERGY_UNIT)
// → smoothed via 0.08 EMA in CompositionView RAF loop
```
This is the **thermostat target**, not a kinetic measurement. During heating modes, it tracks the ramp. During null mode, it tracks the slider minus bond-break PE.

**`meltDebug()` system table** shows three temperature rows:
- `tempC (target)` — `d.totalEnergy` = `ePerParticle / ENERGY_UNIT − 273`, matches UI
- `tempC (total KE)` — `computeKE(phys) / (n × ENERGY_UNIT) − 273`; inflated by freed-atom velocity boost (~11× at 1600°C)
- `tempC (KE÷boost est.)` — total KE with each freed atom's `v²` divided by `freeMult²` before summing; approximate debiased kinetic temperature

## Console diagnostics

**`meltStructure()`** prints one table: mean Si/O coordination, % of Si with >3 or <3 O, Si-Si pairs closer than the repulsion r0, mean Si-Si nearest-neighbour distance, atoms within 20 px per Si, global hex order ψ6, local order (mean cos 6Δφ between Si that share an O), O-Si-O angle error, plus the relevant r0s and the current motif k. Run it at startup as the crystal reference.

**`measureStrain95()`** prints p50/p95 strain over intact rigid bonds.

**`meltDebug()`** — three tables:

1. **System table**: temperatures (three rows), KE, bondedKE, KE/bondedKE ratio, bond break PE, cumulative KE, total energy added, anchor state.

2. **Per-species table**: for SiO2/Na2O/CaO — atom count, `bonded%` (in at least one live bond from `phys.bonds`), `free%` (100 − bonded%), `liberated%` (latticeFreed — permanent, can differ from free%), cation count, `whole%` (cations with no ever-broken intra-grain rigid bond), `meanLifeFr` (mean frames between break and reform; ∞ if no bond has completed a full break-reform-break cycle).

3. **Bond break stats** (from `d.bonds` snapshot): per bond-type total/broken/broken%, breakStart, breakFull.

4. **Intra-grain vs inter-grain**: reads from `phys.bonds` (non-broken only), classifies by `chunkIdx`. Same-chunk = intra (all original bonds). Different-chunk = inter (dynamic melt bonds only). Inter% > 0 means cross-grain Si-O bonds have formed in the liquid.

**`bondAudit()`** — freed-pair bonds: shows `r0s_orig`, `actualD`, `bondStrain`, `renderedStrain`. After the renderer fix, `renderedStrain` should match `bondStrain` for all freed-pair bonds.

**`window.sandStats()`** — sand particle speed histogram.

## Dev sliders (type "dev" to show/hide)

All in the melt tab:

| Slider | Range | Effect |
|---|---|---|
| Si-O r₀ | 5–15 px | equilibrium Si-O bond distance |
| Attract K | 0–0.02 | cooling attract strength (used during cooling modes only) |
| Attract falloff | 1–4 | exponent for cooling attract: `f ∝ r0 / d^falloff` |
| Speed × | 0.5–4.0 | `speedMult` passed to thermostat |
| Si-O hot capture × | 1.01–1.50 | `_sioHotMult`; widens Si-O spring capture window at high temp |
| Freed Si-O long-range attract | 0–4 | `_freeAttractSiOMult`; scales always-on attract for freed Si-O pairs |
| Si-O freed excl × | 1.0–2.0 | `_sioExclMult` (default 1.4); XPBD exclusion for freed Si-O pairs; shows live minD in px |
| Si-Si repulsion r₀ | 10–20 px | `PAIR_TABLE[0][0].r0` (default 15.6); shows the resulting minimum Si-O-Si angle |
| Motif strength | 0–0.02 | `_motifStrength` (default 0.004) |
| Motif align (slow) | 0–1 | `_motifAlign` (default 0.5) |
| Feedback gain × | 0–200 | `_feedbackGainMult` (default 100) |
| Break strain spread | 0–0.2 | `_breakStrainSpread` |
| Sev trigger dist | 5–20 px | `_sevTriggerDist` |
| Pre-Compute | checkbox | enables precomputed targets for fast/slow cool |
| Bond #s | checkbox | shows per-atom bond count labels when GRAPH is off |

UI toggles (always visible, not dev-only):

| Button | Effect |
|---|---|
| CHARGE | toggles `showCharge` — draws radial charge halos on atoms (blue for Si/Ca/Na, orange for O) |
| Count / Graph | switches the right panel between bond count table (`bondView='count'`) and energy graph (`bondView='graph'`) |

## Grid layout

`buildGrid` does a seeded shuffle, then `declumpGrid` makes up to 3 SiO2↔Na2O swaps. Each swap is the one that most reduces orthogonal like-type adjacency, with ties broken by the seeded rand, so the layout is stable for each composition.

## Module-level mutable params (ES module singleton)

```js
// meltPhysics.js
let _sioHotMult        = 1.07  // set via setSioHotMult(v)
let _freeAttractSiOMult = 1.0  // set via setFreeAttractSiOMult(v)
let _sioExclMult        = 1.4  // set via setSioExclMult(v)
```

All three are exported setters, called from `GlassViewer.jsx` slider `onChange` handlers.

## ⚠️ Dead code — freeRep springs (meltPhysics.js lines 442–445)

`freeRepR0` springs for freed Na-O, Ca-O, and O-O pairs never fire. The XPBD freed-ion exclusion zone (`FREE_EXCL = 2.0`) pushes these pairs apart to a minimum distance that exceeds `freeRepR0` for every pair type:

| Pair  | XPBD minD (px)            | freeRepR0 (px) | Result        |
|-------|---------------------------|----------------|---------------|
| Na-O  | (3.6+2.3)×2.0 = **11.8** | 7              | spring dead   |
| Ca-O  | (4.5+2.3)×2.0 = **13.6** | 8              | spring dead   |
| O-O   | (2.3+2.3)×2.0 = **9.2**  | 6              | spring dead   |

The XPBD hard floor always supersedes the spring trigger. Do not remove yet — the intent (preventing tight ionic pairs) is documented here and may inform a future redesign.

## ⚠️ Dead code after bond-breakable change

Line numbers below are stale; search for the code.

Contact liberation of cluster partners checks `if (rb.broken || rb.breakable) continue`. Since all Si-O bonds are now `breakable: true`, this entire cluster-liberation loop is dead. Freed atoms' bond partners are never co-liberated. The intent (keeping the bonded cluster moving together) no longer fires.

`hasSiOBond` is set by `if (!rb.breakable)`. With all bonds breakable, `hasSiOBond` is never set. The displacement clamp `hasSiOBond[i] ? 5 : LOOSE_WANDER` no longer tightly clamps Si atoms — all atoms use the loose wander limit.

## ⚠️ Stale comments to fix

- `meltPhysics.js:341–343`: says "Si-O breaks only above 1700°C" — now breaks at 1300–1800°C
- `meltPhysics.js:358–362`: crystAnchor loop sets crystAnchor from non-breakable rigid bonds — with all bonds breakable, this loop adds nothing to crystAnchor

## Known conflicts with SPEC.md

These are recorded observations, not fixed. Do not resolve them silently.

**(a) UI temperature is the thermostat target, not a kinetic measurement.**
The UI readout derives from `phys.latticeTemp = ePerParticle / ENERGY_UNIT − 273` (the target driven by the slider), smoothed via 0.08 EMA. It does not measure actual particle velocities. At melt temperature with the freed-atom velocity boost active, the true mean kinetic temperature of the system is ~11× the target. Students see the slider value, not the actual thermal state.

**(b) `computeBondedKE` is not a usable temperature measurement at melt temperature.**
At high temperature, nearly all atoms are freed. `computeBondedKE` counts only atoms with `intactCount > 0`. At 1600°C this can be as few as 2 atoms, making the result statistically meaningless and vulnerable to the freed-atom velocity boost (freed atoms with reformed bonds are counted as "bonded" but carry boosted velocity).

**(c) [obsolete — stochastic model replaced by strain breaking]** SPEC.md's ~70% SiO₂ whole at 1800°C has not been re-checked against the strain model. Headless at 1800°C: ~96% of atoms freed and mean Si coordination 1.1, so it currently is not met.
