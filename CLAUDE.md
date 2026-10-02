# Glass Simulator — v3

Physics simulator for glass composition, built for teaching. Si, O, Na, Ca atoms laid out as
grains in a 5×4 grid; the student heats the grid to a melt and cools it fast (amorphous) or
slow (crystalline).

**This file is the ground truth for agents working here. If you change a constant, a default,
or a mechanism, update this file in the same commit.** The previous version of this file drifted
several commits behind the code and sent readers to tuning numbers that no longer existed.

Last verified against the tree at commit `ddcfe89` (2026-10-01), re-verified 2026-10-02.

## Project layout

```
v3/
  meltPhysics.js      — all melt-tab physics: forces, thermostat, bonds, breaking, liberation, cooling
  CompositionView.jsx — grid layout, RAF loop, energy/heat-capacity model, graph, console diagnostics
  GlassViewer.jsx     — top-level UI: tabs (melt / glass / sand), toolbar, dev panel, box-sim RAF loop
  renderer.js         — melt-tab canvas drawing: atoms, bond lenses, strain field, grain outlines
  sandPhysics.js      — sand-tab grain + Na-blob physics (separate system)
  glassPhysics.js     — glass-tab SPH / rigid-body physics (separate system)
  MicroPanel.jsx      — DEAD. not imported anywhere in v3.
  NetworksView.jsx    — DEAD. not imported anywhere in v3.
```

`v1/`, `v2/`, `v5/`, `src/` are older snapshots. `src/` is not an entry point; `vite.config.js`
builds `index.html`, `v3/index.html`, `v5/index.html` only. Don't edit the old copies.

## Build and verify

```
npm run build     # vite, ~0.9 s, 3 entry points
npm run lint      # oxlint — warnings only today, no errors. Keep it that way.
```

`npm run lint` currently emits **82 warnings, 0 errors** — 45 of them in `v3/`, the rest
unused-vars in the `v1/`, `v2/` and `src/` snapshots. Two of the `v3/` ones are flagged in this
file as real: the unused `peNow` in `stepPhysics`. (The `no-constant-condition` warning for the
`if (true)` box-sim gate is gone — that gate is now a real tab check.)
New warnings in `v3/` are yours.

To look at it running: `npx vite preview` then open `/glass/v3/index.html`.

---

# ⚡ Performance — read this before touching the hot paths

**The sim does not hit 60 fps.** Measured in headless Chromium (Playwright + Chromium 1194,
`requestAnimationFrame` interval sampling over 5 s, first 5 frames discarded), soda preset at
~1500 °C, default `simSpeed` 0.5. **4× CPU throttle** (Chrome DevTools `Emulation.setCPUThrottlingRate`)
is the stand-in for an old education Chromebook: those are roughly 3–4× slower single-thread than
this container, and passively cooled, so sustained they behave like 4–6×.

| panel dpr | CPU | tier | Particles and Fields | Bulk Material |
|---|---|---|---|---|
| 1 | 1× | detailed | 56 ms / 18 fps | 89 ms / 11 fps |
| 1 | 1× | **simple** | **32 ms / 31 fps** | 72 ms / 14 fps |
| 1 | 4× | detailed | 315 ms / 3.2 fps | 465 ms / 2.2 fps |
| 1 | 4× | **simple** | **229 ms / 4.4 fps** | 322 ms / 3.1 fps |
| 2 | 1× | detailed | 128 ms / 7.8 fps | 90 ms / 11 fps |
| 2 | 1× | **simple** | **41 ms / 24 fps** | 76 ms / 13 fps |
| 2 | 4× | detailed | 677 ms / 1.5 fps | 382 ms / 2.6 fps |
| 2 | 4× | **simple** | **211 ms / 4.7 fps** | 323 ms / 3.1 fps |

⚠️ **This container is noisy** — repeat runs of the same build vary by up to ~35 % in absolute
ms. Trust the **ratios measured within one run** (same row-pair, same session), not absolutes
across runs. The robust results are: Simple is **~3× faster than Detailed on a dpr-2 panel**
(both runs agreed, 2.8–3.2×) and **~1.3–1.75× on a dpr-1 panel**.

**Still not good enough.** At 4× the melt tab is 4.4 fps on Simple. Under ~10 fps interaction
feels broken. The remaining gap is the melt physics (a spatial hash) plus the per-atom/per-bond
raster described in 2.

## Where the time goes

**Melt-tab frame profile at 4× throttle** (dev build, so React's `jsxDEV` is inflated and should
be discounted):

| | share | note |
|---|---|---|
| native canvas rasterisation (`(program)` + `drawImage` + `bezierCurveTo`) | ~53 % | the blurs, the per-atom arcs, the per-bond lenses |
| `stepPhysics` | ~26 % | the five O(n²) loops |
| everything else | ~21 % | React (dev-inflated), graph, bookkeeping |

**Rasterisation dominates, not physics** — which is why the DPR cap and the blur caps moved the
numbers more than anything done to the step. The Bulk Material tab profiles similarly: ~45 %
rasterisation, ~34 % `stepSandPhysics`.


### 1. One tab simulates at a time — FIXED (was ~35 ms/frame of waste)

**Resolved 2026-10-02.** The melt tab ("Particles and Fields") and the bulk-material box sim
("Bulk Material") are no longer stepped or drawn in the same frame. Measured effect on the melt
tab at 1500 °C: **106 ms → 43 ms per frame, 9.4 → 23.0 fps.**

How it works now:

- `GlassViewer.jsx` had a literal `if (true) {` around the whole box simulation and its renderer,
  so on the melt tab it kept stepping 1800–2250 sand grains through a 10-pass PBD solve and
  running two `getImageData` metaball passes for a `display:none` canvas. That gate is now
  `if (tabRef.current === 'glass')`.
- **Both tabs stay mounted.** `CompositionView` used to be conditionally rendered, so switching
  to Bulk Material *destroyed* the melt physics and switching back rebuilt it from scratch. It is
  now always mounted inside a `display` wrapper and takes an `active` prop, so its state survives
  and the two tabs can be A/B'd instantly.
- **The inactive tab is frozen, not torn down.** `CompositionView`'s RAF keeps running but an
  `activeRef` guard skips `stepPhysics`, `drawScene`, replay capture, the graph and the bond-count
  callback. Verified in-browser: melt particle positions are bit-identical across a second of
  sitting on the other tab, and resume stepping on return.
- **A frozen state is only reused while it is still valid.** On every tab switch the conditions
  the outgoing tab was simulating under are recorded (`frozenCondRef`): rounded temperature,
  preset, cooling mode, heat mode. On entering a tab, if any of those have moved, that tab is
  rebuilt from a fresh start state instead of resumed — `setMeltResetToken` re-runs
  `CompositionView`'s init effect for the melt tab, and nulling `phys.sandParticles` /
  `phys.particles` lets the box sim's existing lazy-init path rebuild. Verified: heating from
  50 → 798 °C on the Bulk Material tab and returning gives a fresh 782-bond array with
  `promoted: 0`; a round trip with nothing changed resumes the same arrays.

⚠️ **Why the melt tab's energy ramp still runs while frozen.** `startCooling` sets
`energyInput = 0` and leaves *CompositionView's* energy-content ramp as "the sole temperature
driver" for Slow/Fast Cool, reporting up through `onTempUpdate`. Both tabs have Cool buttons, so
freezing `CompositionView` wholesale would have silently broken cooling on the Bulk Material tab.
The `activeRef` guard is therefore placed *below* the ramp: the cheap per-frame arithmetic
(ramp advance, `onTempUpdate`) keeps running, and only the expensive work is gated. Verified:
Fast Cool started on the Bulk Material tab takes 1655 → 1370 °C while melt particle positions
stay bit-identical. **If you ever move that guard higher, cooling on the Bulk Material tab dies.**
The cleaner fix is to move the cooling ramp into `GlassViewer`'s `integrateMelt` alongside
heating, so temperature is fully tab-independent; not done yet.

⚠️ **The mini blob preview is effectively disabled.** The `blob-box` thumbnail (dev-panel "Mini
photo view", default off) rendered a *live* bulk-material metaball — its own
`contrast(9999)` + `getImageData(320×320)` pass — in the header while the melt tab was showing.
That is precisely the both-at-once case being eliminated, so it is now gated on
`tabRef.current === 'glass'`, where the thumbnail isn't displayed. The code is left intact behind
the gate rather than deleted. If a macro thumbnail on the melt tab is wanted later it needs to be
a **cached still**, not a second live sim.

### 1b. The Bulk Material tab is now the bottleneck

With the melt tab fixed, the slow tab is the other one. Measured at ~1500 °C:

| Tab / tier | ms/frame | fps |
|---|---|---|
| Particles and Fields — Detailed | 43.4 | 23.0 |
| Particles and Fields — Simple | 36.6 | 27.3 |
| Bulk Material — either tier | 70–90 | 11–14 |

The Bulk Material figure moves with temperature (blur radius scales with `heatT`, up to 12 px),
hence the range. **The quality tier does nothing for it yet** — `simple` only drops the melt tab's
strain field. That tab holds 11 of the 13 `ctx.filter` applications in the project and both
`getImageData` metaball passes, so it is where the next tier caps belong.

### 1c. Quality tier — wired, speed test NOT yet connected

**Added 2026-10-02, extended 2026-10-03.** A render-quality tier so weak machines drop the
expensive effects. Everything downstream is plumbed; only the detection is a stub.

```js
// GlassViewer.jsx, top of file
function detectPerformanceTier() {
  // TODO(speed-test): return 'simple' | 'detailed' from the shared speed test.
  return null            // null = unknown → falls back to QUALITY_DEFAULT ('detailed')
}
```

**To switch it on, replace the body of `detectPerformanceTier()` and nothing else.** The other
sims in this project already run a speed test returning "Simple"/"Detailed"; drop that verdict in
here, lowercased.

`QUALITY` is the single table of per-tier caps:

| cap | detailed | simple | what it does |
|---|---|---|---|
| `bondStrainField` | true | false | full-canvas `blur(2px)` + screen/multiply composite on the melt tab |
| `maxDpr` | 2 | 1 | **the biggest render lever** — see below |
| `blobGlowBlur` | true | false | the Bulk tab's decorative heat-glow blurs (up to `blur(12px)`, full canvas, plus a per-grain arc fill) |
| `sandGrainScale` | 1 | **1 (parked)** | would halve Bulk-tab grain count; measured 68 → 30 ms but **not safe yet** — see below |

A manual tier override sits at the top of the dev panel (type "dev", "── Quality ──"), outside the
per-tab blocks because the tier is global. It prints "(speed test not wired yet)" while
`detectPerformanceTier()` returns null.

#### `maxDpr` — the single biggest render lever

A canvas backing store is sized at `devicePixelRatio`, so fill cost scales with its **square**: a
dpr-2 panel is 4× the pixels. Measured on the melt tab, dpr 1 → 2 costs **2.2×** per frame
(52 → 113 ms at 1×; 259 → 612 ms at 4×). Capping at 1 on `simple` is what produces the ~3×
Simple/Detailed gap on a dpr-2 panel in the table above.

⚠️ **`devicePixelRatio` also tracks browser zoom.** A student at 125 % zoom silently pays ~1.56×
fill with nothing else changed. This is a strong candidate for the machine-to-machine variance
between a dev machine at 100 % and field machines — worth checking zoom level before trusting any
field measurement.

Everything that sizes a canvas or maps pointer coordinates **must** use `effectiveDpr()` from
`renderer.js`, never `window.devicePixelRatio`. Verified: the pointer mapping in
`CompositionView`'s `toPhys` exactly inverts `drawScene`'s transform at every dpr (the dpr factor
cancels algebraically — round-trip checked at dpr 1, 1.25, 2, 3), so click-to-inspect is
unaffected by the cap.

The Bulk Material tab is **dpr-insensitive** — its canvas is sized in CSS pixels
(`canvas.width = canvas.clientWidth`, no dpr) and the blob is drawn through fixed 320×320
offscreens. That is why `maxDpr` moves the melt tab and not that one.

#### `sandGrainScale` is parked at 1 — do not enable it without fixing the rates first

Halving the Bulk tab's grain count measured **68 → 30 ms/frame at 1× and 308 → 162 ms at 4×** —
by far the biggest win available on that tab, since `stepSandPhysics`' 10-pass PBD solve is ~34 %
of its CPU and is linear in grain count.

It is disabled anyway, because it **changes what the sim teaches**. Screenshots at 1500 °C showed
Detailed as discrete grains with glowing blobs forming among them, and Simple as a flat orange
mass. The cause is in the next section: the melt-progression rates are per-frame with **absolute**
caps, so halving the grain count roughly doubles the fraction of the pile that melts per frame.

Fix the rates first, then set it to 0.5.

### 1d. ⚠️ Frame-rate-coupled behaviour — the sim runs a different lesson on different hardware

**Found 2026-10-03. Pre-existing, not caused by any optimisation here, and it matters more than
the frame rate does.** Two separate couplings make the *content* of the lesson depend on how fast
the machine is:

**1. Sand melt progression is proportional to frame rate.** All four melt-progression calls run
**once per rendered frame** with per-frame probabilities, in `GlassViewer`'s box loop:

| call | rate limit | scale-dependent? |
|---|---|---|
| `mergeSodaGrains(grains, meldProb)` | per-pair probability per frame | ∝ fps |
| `convertLargeNaGrains(...)` | **"one per frame"**, absolute | ∝ fps, and ∝ 1/grainCount in fractional terms |
| `mergeSilicateGrains(..., maxMerges: 3)` | **absolute 3 per frame** | ∝ fps, and ∝ 1/grainCount |
| `absorbNearbyGrains(...)` | per-grain probability per frame | ∝ fps |

So a machine running at 30 fps melts sand twice as fast as one at 15 fps, in wall-clock terms.
**Any performance work changes the melt pacing**, including the glow caps shipped here
(Bulk 89 → 72 ms is ~24 % more frames/sec, so ~24 % faster melting on Simple).

**2. Heating runs slower on slow machines.** `GlassViewer`'s `integrateMelt` uses
`elapsed = Math.min((ts - lastTs) / 1000, 0.05)`. The clamp is there to stop a huge jump after a
stall, but it means that below **20 fps the temperature ramp falls behind real time** — at 11 fps
(Bulk, Detailed) heating advances at ~61 % of the intended rate. "Heat to 1500 °C" therefore takes
noticeably longer on a weak Chromebook, and the student's lesson is paced differently.

**Why this matters more than fps:** a dev machine and a field Chromebook are not running the same
simulation. They melt at different rates and heat at different rates. Any field report of
"it behaved differently on my machine" may be this rather than a bug, and A/B comparisons of the
physics across machines are not valid until it is fixed.

**The fix** is to drive both from wall-clock, not frames: accumulate elapsed time and apply melt
progression per simulated second (the box physics already does this correctly for `stepSandPhysics`
via its `FIXED_DT` accumulator — use the same pattern), and replace the heating clamp with an
accumulator that doesn't silently drop time. Scale `maxMerges` and the one-per-frame conversion by
grain count at the same time, which unblocks `sandGrainScale`.

### 2. Canvas2D `ctx.filter` and `getImageData` — the graphical hot spots

`ctx.filter = 'blur(...)'` is the most expensive drawing call in this codebase. It is frequently
unaccelerated, and each use rasterizes a full-canvas layer on the CPU. `GlassViewer.jsx` has
**11 filter applications** (plus 11 `= 'none'` resets): `blur()` up to 12 px, `contrast(9999)`,
and `blur(4px) contrast(22)`. `renderer.js` has 2, both `blur(2px)`.

Worst offender, in the box-sim render path (so currently running on every tab): the metaball
pipeline in `GlassViewer.jsx`. Grep `contrast(9999)` — two call sites, the main blob and the
mini view. Each does, **every frame**:

```
ctx.filter = 'contrast(9999)' → drawImage → getImageData(320×320)
  → JS loop over 409,600 bytes → putImageData
```

`getImageData` forces a GPU→CPU readback and stalls the pipeline.

In `renderer.js` the two blurred offscreen layers are:
- **bond strain field** — full-canvas layer, `blur(2px)`, then composited with
  `globalCompositeOperation = 'screen'` (dark) / `'multiply'` (light). Measured at
  **~7 ms/frame** (Detailed → Simple, 43.4 → 36.6 ms at 1500 °C). It is the one effect the
  `simple` quality tier drops — see 1c.
- **grain outlines** — full-canvas layer, `blur(2px)`. Cheaper (outlines dissolve
  permanently as grains melt, so it empties out), but same mechanism.

Both layers are cached in `WeakMap`s keyed by the canvas (`fieldLayerCache`, `chunkLayerCache`)
and only reallocated on resize — the allocation isn't the problem, the blur and composite are.

For a low-end build: drop the blur entirely and draw the lens shapes directly at reduced alpha,
or pre-render a small radial-gradient sprite once and `drawImage` it per bond. The pedagogy needs
"bond is strained → pink"; it does not need a Gaussian.

Also per-frame in `renderer.js`: charge halos build a **new `createRadialGradient` per atom per
frame** — ~716 gradient objects/frame when Charge is on. Hoist to a cached sprite.

### 3. The physics step is five brute-force O(n²) loops

`n` is larger than it looks: **716 atoms** (soda 70/30), **767** (pure SiO₂), 710 (soda-lime).

**Clean step cost** — real `v3/meltPhysics.js`, headless node, median of 4 runs × 150 steps after
60 warm-up steps:

| Preset | ms/step | range |
|---|---|---|
| soda @ 1500 °C | **43.4** | 39.8–43.9 |
| soda @ 50 °C | **29.9** | 28.3–30.7 |
| pure SiO₂ @ 1500 °C | **33.6** | 32.0–34.4 |

**Where it goes** — from an *instrumented* copy with `performance.now()` around each section
banner. ⚠️ That instrumentation inflates the total by ~50 % (66.7 ms vs the clean 43.4) because
sections inside the substep loop are timed 6× per step, so **treat the shares as indicative and
the absolute ms as upper bounds**, and over-weighted for the substep-loop rows in particular:

| Section | ms/step @1500 °C (instrumented) | share | passes/step |
|---|---|---|---|
| **pairwise forces** | 21.2 | 32 % | 6 (one per substep) |
| **hard-sphere collisions** | 17.3 | 26 % | 6 |
| **bond rebuild for rendering** | 12.9 | 19 % | **1** |
| freed-ion exclusion (XPBD) | 7.6 | 11 % | 6 |
| contact liberation | 3.1 | 4.6 % | 1 |
| severance | 2.3 | 3.5 % | 1 |
| everything else combined | <1.5 | 2 % | — |

The ranking is robust — it matches the pair counts below, and the in-browser profile independently
showed `stepPhysics` as the single largest frame cost. Note `bond rebuild` runs **once** per step
yet still places third, so per pass it is the most expensive loop of all.

All five are `for i … for j = i+1 …` over every pair with no spatial structure:

| Loop | Location |
|---|---|
| pairwise forces | `// ── Pairwise interaction forces ──` |
| hard-sphere collisions | `// ── Elastic hard-sphere collision resolution ──` |
| freed-ion exclusion | `// ── Freed-ion exclusion zone ──` |
| cooling attract (only when `attractK > 0`) | `// ── Cooling attraction` |
| bond rebuild | `// ── Bond detection for rendering ──` |

**The headroom is enormous.** Measured at 1500 °C, soda: 255,970 pairs tested per pass, of which
**1,662 (0.65 %) are within `FORCE_CUTOFF` = 20 px** and 523 (0.20 %) within
`COLLIDE_CUTOFF` = 10 px. Per step that is **4.86 million pair tests** (6 + 6 + 6 + 1 passes)
to do ~1,600 pairs' worth of work — about **150× more work than necessary** on the force loop
and **490×** on the collision loop.

A uniform-grid spatial hash is the fix and **there is already a working one in this repo** —
`sandPhysics.js` (`CELL = GRAIN_R_MAX * 2`, typed-array linked list, rebuilt each step,
with a `LARGE_R` linear-scan fallback for oversized grains). Port that pattern.

Two further notes on the step:

- **Per-step allocation churn.** Each `stepPhysics` call allocates `crystAnchor`, `naAnchor`,
  `liveCount`, `siOCount`, `intactCount`, `hasSiOBond`, `sioCoord` (7 typed arrays sized `n`),
  a `siOPairs` Set, a `rigidPairSet` Set, the `bonds` array, the `sioCands` array, and in
  `dbg.bonds` an object with freshly built `${type}-${type}` template-string keys. GC was 4.8 %
  of profiled time. All of these can be hoisted onto `phys` and reused.
- **`computePE` is called and thrown away.** `stepPhysics` computes `peNow` at its top;
  nothing reads it (oxlint flags it). Delete the call — it walks the whole bond list.

### 4. Per-frame work in the RAF loop (`CompositionView.jsx`)

- `computeKE(phys)` is called **twice** per frame in the melt branch. Once is enough.
- `energyContent()` / `tempForContent()` are numerical integrals stepping 5 °C
  at a time — up to 400 iterations each. During a ramp, `rampEnergyLinearInContent` calls them
  3× per frame, plus `energyContent(1800, …)` every frame for the graph's `eMax`, plus another
  every 3rd frame for the history point. Both are pure functions of `(T, na2oPct, plateau)`:
  **precompute one lookup table per preset** and interpolate.
- The replay buffer pushes a `Float32Array(n*2)` **every frame** while a ramp is active.
  A slow cool is 1440 frames × 716 atoms × 2 × 4 B ≈ **8.2 MB per run**, and the buffer is only
  cleared when a new ramp starts. On a low-memory device, subsample it (every 4th frame is
  plenty for a scrub slider).
- `drawTEGraph` redraws the whole sidebar graph every frame. Throttle it; the bond-count table
  next to it is already throttled to 300 ms.
- The `[diag]` block runs a full `reduce` over all particles on each of the first
  10 steps. Harmless but delete-able.

### 5. `simSpeed` multiplies everything

`simSpeed` defaults to **0.5** (`GlassViewer.jsx`) — physics advances on every *other* frame.
That is the only reason the current build is watchable. At `simSpeed` 4 the loop runs
`Math.floor(speed)` = 4 full `stepPhysics` calls per frame, i.e. ~270 ms/frame. If you add a
"low power" mode, `simSpeed` is the cheapest lever, but note it slows sim time, it doesn't make
frames cheaper.

## Guidance for the trimmed-down build

Remaining work, in rough order of payoff per unit of effort:

1. ~~**Gate the box sim on the active tab.**~~ **DONE** — see 1.
2. ~~**Quality tier for the blurred strain field.**~~ **DONE** — see 1c.
3. ~~**`maxDpr` cap.**~~ **DONE** — see 1c. ~3× on the melt tab on a dpr-2 panel.
4. ~~**Bulk-tab glow caps.**~~ **DONE** — see 1c. ~1.25–1.45× on that tab.
5. **Make melt progression and heating frame-rate-independent** — see 1d. This is now the top
   item. It is a *correctness* fix, not a perf fix: right now a fast machine and a slow one teach
   different lessons. It also unblocks `sandGrainScale` (worth another ~2× on the Bulk tab), so it
   pays for itself in performance too.
6. **Spatial hash for the pair loops.** The melt tab is still 4.4 fps at 4× on Simple, and
   physics is ~26 % of that frame. Pattern already exists in `sandPhysics.js`. Physics-neutral if
   the cell size ≥ the largest cutoff.
7. **Per-atom and per-bond raster on the melt tab.** After the tab split and the DPR cap this is
   the largest remaining render cost: ~716 atoms × up to 4 ghost copies = up to ~2,900 `arc`
   fill+stroke pairs per frame, plus ~800 bond lenses each built from `bezierCurveTo`
   (`fillLens`). Both are candidates for a pre-rendered sprite blitted with `drawImage`.
8. **Collapse the 6 substeps to 2–3** on `simple`. ⚠️ Not free: a substep is one unit of simulated
   time, so fewer substeps means less dynamics per wall-clock second — it would slow cooling and
   could weaken the slow-vs-fast-cool difference in final order, which is on the do-not-cut list.
   Measure `meltStructure()` after a slow cool before accepting it.
9. ~~**Cut `n`.**~~ **Ruled out by Joe (2026-10-02).**
10. Precompute the heat-capacity integrals, hoist the per-step allocations, drop the duplicate
    `computeKE`, delete the dead `peNow`, subsample the replay buffer.

Things *not* to cut, because they carry the teaching:
bond colour responding to strain; grains visibly dissolving; the freed/bonded distinction;
the latent-heat plateau; the fast-vs-slow cool difference in final order; **discrete sand grains
visibly turning into blobs** (the `sandGrainScale` screenshot showed how easily that one is lost).

## Reproducing the measurements

Nothing here is checked in — these were throwaway scripts in the scratchpad. To redo them:

- **Headless physics timing**: `meltPhysics.js` is a plain ES module with no React or DOM
  dependency, so node can import it directly. `CompositionView.jsx` lines 9–199 (`buildGrid`,
  `declumpGrid`, `buildHexLayer`, `buildSquareLayer`, `buildAllAtoms`, and their constants) are
  also dependency-free — `sed -n '9,199p'` them into a `.mjs`, add an export line, and you can
  build `cellData` and call `initPhysics` / `buildRigidBondMap` / `stepPhysics` from node.
- **Per-section timing**: copy `meltPhysics.js`, insert `performance.now()` pairs around the
  `// ── Section ──` comment banners in `stepPhysics`, accumulate into an exported object.
  Use `var` for the timer locals — several sections open inside the substep loop and close
  outside it, so `const` is out of scope. ⚠️ The timers themselves cost ~50 % of the step
  (100+ `performance.now()` calls per step, since substep-loop sections are timed 6× each), so
  take totals from an uninstrumented run and use the instrumented one only for shares.
- **Browser fps**: `npm i -D playwright --no-save`, launch with
  `executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'` and
  `args: ['--no-sandbox', '--enable-unsafe-swiftshader']`, serve with `npx vite preview`, then
  sample RAF intervals in-page. `window.setMeltTemp(1500)` jumps the melt tab to temperature
  without driving the UI.
- **Function-level profile**: profile the **dev** server (`npx vite`), not `preview` — the
  production bundle is minified to single letters and unreadable in a profile.

---

# Melt tab

## Core constants (`meltPhysics.js`)

| Constant | Value | Meaning |
|---|---|---|
| `SIM_W` × `SIM_H` | 600 × 350 px | physics domain; toroidal wrap on both axes |
| `n` | 716 (soda) / 767 (pure) / 710 (soda-lime) | atom count |
| `THERMAL_SPEED` | 0.0018 | `v_rms = 0.0018 × √T` px/substep |
| `ENERGY_UNIT` | `THERMAL_SPEED²/2` = **1.62e-6** | `ePerParticle = (T+273) × ENERGY_UNIT` |
| `SUBSTEPS` | 6 | physics substeps per `stepPhysics` call |
| `THERMOSTAT_TAU` | 0.10 | Langevin coupling per substep for bonded atoms |
| `FORCE_CUTOFF` | 20 px | per-axis early reject for the pair force loop |
| `COLLIDE_CUTOFF` | 10 px | per-axis early reject for the collision loop |
| `ATTRACT_RANGE` | 40 px | long-range attract cutoff |
| `FREE_EXCL` | 2.0 | freed-pair XPBD exclusion = 2× contact radius (all pairs but Si-O) |
| `REP_K` / `REP_MULT` | 0.28 / 1.8 | generic repulsion for null-spec pairs |
| `ANCHOR_K` | 1.6 | lattice home-spring strength |
| `ANCHOR_FADE_TEMP` | 800 °C | lattice anchor → 0 here |
| `ANCHOR_MELT_TEMP` | 600 °C | above this once, lattice anchor disabled forever |
| `SIO_FADE_LOW` / `_HIGH` | 200 / 1100 °C | Si-O capture-mult fade window |
| `SIO_COLD_MULT` | 1.15 | Si-O capture mult at/below 200 °C |
| `COORD_TARGET` | `[3, 2, 1, 2]` | target coordination by typeId (Si, O, Na, Ca) |
| `REINT_RAMP_FRAMES` | 10 | frames to ramp speed back down after re-integration |
| `FAST_COOL_FRAMES` | 270 (~4.5 s) | `CompositionView.jsx` |
| `SLOW_COOL_FRAMES` | 1440 (~24 s) | `CompositionView.jsx` |
| `COOL_MIN_TEMP` | 1500 °C | cooling gate, `GlassViewer.jsx` |
| Temperature cap | 1800 °C | `GlassViewer.jsx` |
| Start temperature | 50 °C | `meltLocalTemp` initial state, `GlassViewer.jsx` |

⚠️ **The inline comment on `ENERGY_UNIT` says `1.125e-6`. It is wrong** —
`0.0018² / 2 = 1.62e-6`. The stale number is left over from `THERMAL_SPEED = 0.0015`.
`GlassViewer.jsx`'s `targetE` initial state hardcodes the correct `1.62e-6`. Fix the comment;
don't trust it.

`PHYSICS_START_TEMP = 0` is exported but unused — the UI starts at 50 °C.

## Atom species

| Type | r (px) | typeId | Lattice |
|---|---|---|---|
| Si | 3.2 | 0 | honeycomb, a = 2 × `sioR0` (18 px default) |
| O | 2.3 | 1 | placed at same-chunk cation midpoints |
| Na | 3.6 | 2 | square, a = 24 px |
| Ca | 4.5 | 3 | square, a = 24 px |

O atoms are only placed between cations in the **same chunk**, so grains start bond-isolated.
Atoms within `GRAIN_MARGIN` = 5 px of a chunk boundary are rejected for the same reason.

## Pair specs

Opposite-charge attractive springs (`PREFERRED`, aliased into `PAIR_TABLE`):

| Pair | r0 | k | mult | oneSided | freeRep (r0/k) | notes |
|---|---|---|---|---|---|---|
| Si-O | 9 | 0.061 | temp-dep `sioMult` (static `mult: 1.03` unused for Si-O) | true, lifted for freed pairs | — | `setSioK` |
| Na-O | 12 | 0.042 | 1.05 | false | 7 / 0.50 | `viewMult: 1.30` for rendering only; `setNaOK` |
| Ca-O | 12 | 0.28 | 1.02 | false | 8 / 0.55 | |

`oneSided: true` means the spring only attracts (`d > r0`); hard-sphere handles compression.
For **freed Si-O pairs** it is lifted unconditionally, giving a bilateral well at r0:
`effOneSided = spec.oneSided && !(isSiOSpec && isFreedPair)`.

Like-charge repulsion (`repOnly` — only fires inside r0, never attracts):

| Pair | r0 | k | notes |
|---|---|---|---|
| Si-Si | **15.6** | 0.22 | dev slider 10–20, `setSiSiRepR0`. With Si-O r0 = 9 this holds Si-O-Si ≥ ~120°; at 12 it folds to ~84° and the melt packs denser than the crystal. Crystal Si-Si is 18 px, unaffected. |
| O-O | 8 | 0.32 | `freeRep` 6 / 0.3 |
| Na-Na | **35** | 0.45 | dev slider 6–40, `setNaNaRepR0`. See the warning below. |
| Ca-Ca | 10 | 0.50 | |
| Na-Ca | 9 | 0.38 | |

The only pairs with no `PAIR_TABLE` entry are **Si-Na** and **Si-Ca**. They get generic
repulsion: `f = -REP_K × (cutoff - d)`, `cutoff = (ri + rj) × REP_MULT` = up to 12.2 px.
That is a large energy barrier, and it is the likely reason contact liberation of SiO2 atoms by
freed Na2O atoms fires less often than intended.

### ⚠️ Na-Na `r0 = 35` exceeds `FORCE_CUTOFF = 20` — measured, and counterintuitive

The force is truncated mid-slope. At the 20 px gate it is still
`0.45 × (20 − 35) = −6.75` px/substep², roughly 50× the Na-O attraction, and it steps
discontinuously to zero when a pair crosses the gate. The value is deliberate — commit `ddcfe89`
lists "Na-Na repulsion r0 default 35", and the inline comment's intent is to spread Na through
the melt instead of letting it clump.

Everything below is measured headless on the soda preset, 150 steps, same seed. **Read it before
"fixing" this**, because two obvious readings are both wrong.

**It is not wasteful.** Na-Na is gated by `FORCE_CUTOFF` like every other pair and costs nothing
extra. `r0 = 35` does not widen any loop.

**It is not inert either — the slider works, strongly.** Mean Na-Na nearest neighbour at 1500 °C:

| `setNaNaRepR0` | mean Na-Na nn | min Na-Na |
|---|---|---|
| 35 (default) | 32.7 px | 22.0 px |
| 20 | 24.1 px | 19.6 px |
| 14 | 21.9 px | 14.5 px |
| 8 | 21.1 px | 8.0 px |
| 0.1 (off) | 20.4 px | 7.3 px |

**But it does not work the way `r0 = 35` implies.** An instantaneous count finds **0–1 of 3160
Na-Na pairs** satisfying "passes the gate AND inside r0" at any temperature from 50 to 1800 °C.
That is not evidence the force is idle — it is evidence the force has already done its job. It
acts as a rare, violent *impulse* whenever two Na drift into the 40×40 px gate box, not as a
35 px-range field. Equilibrium settles just outside the gate (min 22.0 px at r0 = 35), so
**`FORCE_CUTOFF` sets the Na-Na spacing; `r0` only sets how hard the kick is.**

⚠️ If you measure this yourself, don't repeat the mistake of counting pairs in a settled snapshot
and concluding the force does nothing. You are looking at the equilibrium the force created, not
at its activity. A/B the parameter instead.

**The anisotropy is real but barely exercised.** The gate rejects per axis, so a pair at
`dx = dy = 20` is 28.3 px apart and still passes. Measured across 50–1800 °C, 0–1 pairs ever sit
in that diagonal band. Na's square lattice is a = 24 px and an axis-aligned neighbour at 24 px is
rejected outright, so lattice pairs can't trigger it at all.

**Raising `FORCE_CUTOFF` to 35 is cheap, not expensive.** A/B measured: **43.75 → 46.33 ms/step
(+2.6 ms, +6 %)**. The O(n²) rejection scan dominates and doesn't change; only the extra accepted
pairs (2043 → 6608) pay for a sqrt and a force. But it moves mean Na-Na spacing **+8.1 px
(30.3 → 38.4)** — a real structural change to the melt.

The inline comment claims "Na-Na r0 16" and "crystal Na-Na = 24px, unaffected". Both are false
at `r0 = 35`.

So this is a physics decision with a small perf cost attached, not a bug fix:
- leave it, and document that Na-Na spacing is really controlled by `FORCE_CUTOFF`;
- raise `FORCE_CUTOFF` for a continuous force, accepting +6 % and a more spread-out melt;
- or bring `r0` inside the cutoff so the slider's number means what it reads.

Re-run `meltStructure()` after any of them. **Still unresolved — don't quietly pick one.**

## Si-O capture range (`sioMult`)

Temperature-dependent, fading on measured KE temperature between `SIO_FADE_LOW` (200 °C) and
`SIO_FADE_HIGH` (1100 °C):

- `SIO_COLD_MULT = 1.15` below 200 °C — wide recapture; bonds effectively unbreakable
- `_sioHotMult = 1.07` above 1100 °C — narrower; dev slider 1.01–1.50

At 1800 °C the capture window is `9 × 1.07 = 9.63 px` and the freed Si-O XPBD floor is
`5.5 × 1.4 = 7.70 px`. The 1.3 px gap below r0 = 9 px is what lets freed pairs reach and settle
at the spring minimum.

**Resonance trap — avoid `_sioExclMult` 1.5–1.7.** When the XPBD floor lands inside the capture
window but above r0, freed pairs are held in a compression-only band, oscillating without
settling. Values ≥ 1.8 push the floor past the capture radius and disable the spring entirely.

Calibration sweep, 1800 °C, soda (historical — measured before the current Na-Na and
break-strain values, so re-run before relying on it):

| excl× | floor (px) | KE/target | SiO₂ bonded % |
|---|---|---|---|
| 1.0 | 5.50 | 1.314 | 96 % |
| 1.2 | 6.60 | 1.362 | 97 % |
| **1.4** | **7.70** | **1.321** | **96 %** |
| 1.6 | 8.80 | 3.840 | 65 % |
| 1.8 | 9.90 | 1.037 | 0 % |

## Si-O coordination cap

Freed Si-O pairs are capped at `COORD_TARGET` (Si ≤ 3 O, O ≤ 2 Si):

- At step start, `liveCount` / `siOCount` / `siOPairs` are built from **last frame's**
  `phys.bonds`, skipping `b.broken` (broken rigid bonds stay in `phys.bonds` for the pink fade
  until the atoms are 40 px apart). One frame stale, accepted.
- A freed Si-O pair not already bonded, where either side is full (`siOSat`), gets no spring and
  no long-range attract — only plain repulsion inside r0.
- The render-time dynamic bond scan accepts Si-O candidates **nearest-first** under the same cap
  (intact rigid Si-O counted first), so the bond list never shows over-coordination.

Historical effect at 1500 °C on soda, headless: atoms within 20 px per Si fell 6.05 → 5.44
(crystal 4.61), mean Si-Si nearest neighbour 16.4 → 17.9 px, over-coordinated Si 1.6 % → 0 %.

## Order of operations in `stepPhysics`

Per call, once: capture-mult update, anchor sets, coordination counts from last frame's bonds,
motif build (cooling only), freed-kick fade.

Then **6 substeps**, each: zero forces → motif forces → severance pull → **pairwise forces** →
intact-bond restoring spring → cooling attract (if `attractK > 0`) → lattice/crystal/Na anchors
→ integrate + toroidal wrap → **rigid-bond XPBD projection** → **hard-sphere collisions** →
**freed-ion exclusion XPBD** → thermostat → speed cap (`vTarget × 5`).

Then once more: bond break/reform with latent heat → `intactCount` → auto-free → re-integration
→ temperature measurement → contact liberation → severance → displacement clamp →
**bond rebuild for rendering** → debug snapshot.

Note there is **no force halving for freed atoms** and **no freed-atom velocity boost at
integration** — both were removed. Freed atoms differ only in their thermostat coupling
(`_freedTau`) and kick multiplier (`_freedSpeedMult`).

## XPBD position correction — two separate loops

1. **Rigid bond projection** — corrects non-broken rigid bond lengths directly and
   zeroes relative velocity along the bond axis. Runs only when
   `totalEnergy <= rb.projectionCutoff`. Skips bonds with `d > 3 × r0` so partners that drifted
   apart during the melt aren't rubber-banded back together on cooling.
2. **Freed-ion exclusion** — pushes freed-freed pairs apart to a minimum separation.
   Unconditionally stable against high-velocity penetration.
   - All pairs: `minD = (ri + rj) × FREE_EXCL (2.0)` → Na-O 11.8 px, O-O 9.2 px
   - Si-O: `minD = (ri + rj) × _sioExclMult (1.4)` = 7.70 px
   - During cooling, non-Si-O opposite-charge pairs clamp to `min(minD, 0.9 × r0)` so Ca-O can
     actually bond (its 13.6 px floor otherwise sits past r0 = 12 px).

The Si-O pair is identified as `pi.typeId + pj.typeId === 1` — only 0+1 sums to 1.

## Bond breaking (strain-based, with per-type feedback)

Each rigid bond gets its own `breakStrain` and `projectionCutoff` at `buildRigidBondMap`:

| | base `breakStrain` | `projectionCutoff` |
|---|---|---|
| Si-O | `_breakStrain` = **0.04** | `sioProjCutoff(sio2Pct)`: **1800** if `sio2Pct >= 100`, else **1300** — exact, no spread |
| Na-O / Ca-O | `_naBreakStrain` = **0.02** | `650 + 480 × random()` → uniform over 650–1130 °C |

Both `breakStrain` values are then multiplied by `1 + (random×2−1) × _breakStrainSpread (0.15)`.
Pure SiO₂'s cutoff of 1800 is deliberately at the model's ceiling so pure sand never melts.
Na/Ca's uniform spread is what makes broken % ramp linearly with temperature instead of
avalanching.

```js
effThreshold = rb.breakStrain × (1 + GAIN × _feedbackGainMult × fBrokenForThisType)
break  when avgStrain > effThreshold       // avgStrain = EMA α=0.1 if _useEmaStrain, else instantaneous
reform when strain <= _reformStrain (0) and no severance cooldown
```

`GAIN` interpolates on `sio2Pct` from `FEEDBACK_GAIN_SILICA` (0.112) at 100 % SiO₂ to
`FEEDBACK_GAIN_SODA` (0.437) at 70 %. **`_feedbackGainMult` defaults to 40** (dev slider 0–200).
The f=0/f=1 temperatures in those constants' comments assume a multiplier of 1 and do not apply
at 40.

**`fBroken` is per bond population**, not global: `fBrokenSiO` and `fBrokenMod` are tracked
separately. A single global figure was diluted by the ~550 always-intact Si-O bonds below the
projection cutoff, so a Na-O break barely moved it, the Na-O threshold never rose, and Na-O
bonds crept forever at a hold. `phys.fBroken` (the combined figure) is HUD-only.

## Latent heat (replaces the old `BOND_BREAK_ENERGY` model)

`BOND_BREAK_ENERGY` is **gone**. Latent heat is now a real KE transaction:

- Each bond carries a `bondDepth`, computed once when the bond is created:
  `0.5 × spec.k × (d × (spec.mult − 1))²` in `buildRigidBondMap` (using the *measured* separation
  `d` at snapshot time), and `0.5 × spec.k × (spec.r0 × (spec.mult − 1))²` in `promoteBonds`.
  Note both use the **static** `spec.mult` — for Si-O that is 1.03, not the temperature-dependent
  `sioMult` the force loop actually uses, so Si-O bond depths are on the shallow side.
- On break, `_removeKE` drains `bondDepth/2` from each atom's KE (clamped at zero if the atom
  can't pay; the thermostat restores it over ~2 steps).
- On reform, `_addKE` injects `bondDepth/2` into each atom, directed outward along the bond axis.
- `phys.bondBreakPE = breakKERemoved − breakKEReturned` — **net KE drained this step**, not an
  accumulated potential. `phys.breakKERemoved` / `.breakKEReturned` hold the gross figures.

Because temperature is now measured from KE (below), this shows up directly as a dip when bonds
break in bulk — no separate subtraction term.

## Severance

A freed Na⁺ or Ca²⁺ (`intactCount === 0`) within `_sevTriggerDist` (13 px) of **either** endpoint
of an intact Si-O rigid bond breaks it, sets `rb.severFrames = _sevCooldown` (60) and registers
a `phys.sevPulls` entry that drags the O toward the ion with strength `_sevPullK` (0.01).

The ion is **capped by its own coordination**: once `liveCount[k] >= COORD_TARGET[typeId]`
(Na → 1 O, Ca → 2) it is saturated and severs nothing more. Without that cap a few lingering
ions ate whole grains and the structure crept forever at a hold.

A severed bond can't reform while its ion is still within trigger distance; the cooldown only
counts down once the ion has left.

Cost note: this loop is `rigidBonds × n` with `Math.hypot` inside — ~2.3 ms/step.

## Freed atoms (`latticeFreed`)

`phys.latticeFreed` is a `Uint8Array(n)`, set to 1 when an atom leaves the lattice.
**Permanent within a run — only re-integration clears it.**

**Liberation paths:**

1. **Auto-free** — an atom is freed when `intactCount[i] <= floor(origCount[i] × (1 − frac))`,
   where `frac` is `_naLiberateFrac` (0.5) for Na2O-chunk atoms and `_liberateFrac` (0.5)
   otherwise. So: freed once a **majority** of its original bonds are broken, not all of them.
   `crystAnchor` atoms are exempt below 1300 °C (edge atoms can have `intactCount = 0` without
   having melted — they simply never formed rigid bonds).
2. **Contact liberation** — a freed Na2O atom, or a freed SiO2 atom that has drifted
   > `FREED_DRIFT_MIN` (4 px) from its site, liberates any unliberated SiO2 atom within
   `(ri + rj + 1)` px, with a `LIBERATE_KICK` (0.12 px/substep) outward kick.
   The nested loop that was meant to co-liberate the newly freed atom's bonded cluster is
   **dead** — see "Dead code and traps".

Freed atoms bypass the crystal/Na anchor springs and the displacement clamp, run the Langevin
thermostat with coupling `_freedTau` (0.01, so long straight runs) and kick multiplier
`_freedSpeedMult` (5), and are subject to the freed-ion exclusion XPBD.

**Re-integration:** a freed atom holding `min(_reintBondN, COORD_TARGET)` **live** bonds (rigid
*or* dynamic — `liveCount`, because rigid bonds only reform with original partners who are long
gone after a melt) for `_reintFrameM` (30) consecutive frames is cleared from `latticeFreed`, has
its anchor rebased to its current position, and gets `promoteBonds()` called — turning its
dynamic bonds into new rigid bonds (`promoted: true`, `r0 = spec.r0`) so XPBD holds the new solid.
Its kick multiplier ramps back down over `REINT_RAMP_FRAMES`.

Re-integration runs during cooling **and at any hold below the Si-O projection cutoff**. Without
the latter, a hold ratcheted the freed count upward forever: every transient full-break freed an
atom permanently with no path back.

`latticeFreed` and "currently bonded" are different things. A freed atom can re-bond dynamically
in the melt (`latticeFreed = 1` *and* `isBonded = 1`). `meltDebug()` reports both
(`liberated%` and `free%`).

⚠️ The measurement arrays in `CompositionView` (`everBroken`, `wasIntact`, `currentIntact`,
`lifetimeTotal`, `lifetimeBreaks`, `unitBonds`) are sized at init from `rigidBonds.length`.
`promoteBonds` **appends** to `rigidBonds`, so promoted bonds are not tracked by any of them.
Measurement-only; no physics effect.

## Temperature and energy

### What the readouts mean

- **`phys.latticeTemp`** = mean KE of atoms with `intactCount > 0`, converted to °C:
  `(keSum × 0.5 / keCount) / ENERGY_UNIT − 273`, falling back to `ePerParticle` if nothing is
  bonded. Set at the end of `stepPhysics`. This is a **real kinetic measurement** — it used to be
  the thermostat target, and the change is recent.
  ⚠️ It is assigned **twice** per step: once near the top of `stepPhysics` to the thermostat target
  (`phys.latticeTemp = keTarget / ENERGY_UNIT - 273`), then overwritten at the end with the
  measured value. The first assignment is dead; nothing reads it in between.
- **The UI "T:" readout** (`derivedTemp`) is computed in `CompositionView`'s RAF loop from
  `computeKE(phys) / (n × ENERGY_UNIT) − 273` — **all atoms, not just bonded ones** — smoothed
  with a 0.08 EMA. So `latticeTemp` and the UI readout are two different measurements.
- **`totalEnergy`** = `ePerParticle / ENERGY_UNIT − 273`, the thermostat *target*. All physics
  gates (bond cutoffs, anchor fades, motif ramp, liberation thresholds) read this, not the
  measured temperature, so they respond to the student's input immediately rather than lagging.

### Heat capacity and energy content

`heatCap(T, na2oPct, plateau)` in `CompositionView.jsx`, mirrored as `meltHeatCapacity` in
`GlassViewer.jsx` (two copies of the same curve — keep them in sync). It smoothsteps from 1.0 to
a plateau of `1 + (plateau − 1) × min(1, na2oPct/30)` across `HC_LO` 500 °C → `HC_HI` 750 °C.
`plateau` comes from the `hcPlateau` React state, default 4 (dev slider 1–8) — it is **not** a
module mutable. Pure SiO₂ stays flat at 1, so it has no latent-heat plateau at all.

`energyContent(T) = ∫₀ᵀ heatCap·dT` is the **graph x-axis** and the kJ readout
(× `ENERGY_KJ_MULT` 0.2) — not temperature. `tempForContent` is its numerical inverse.

**All ramps interpolate linearly in energy content**, not temperature
(`rampEnergyLinearInContent`), so kJ moves at a constant rate straight through the latent-heat
plateau while temperature visibly stalls. That stall is the point.

Both functions integrate in 5 °C steps on every call. See the perf notes.

## Heating and cooling modes

Set via the `coolingMode` prop on `CompositionView`; managed in `GlassViewer.jsx`.

| Mode | Mechanism | Duration | End target |
|---|---|---|---|
| `null` | thermostat holds at the slider / GO target | — | — |
| `'fastHeat'` | energy-content ramp | 270 frames | 1500 °C |
| `'slowHeat'` | energy-content ramp | 1440 frames | 1500 °C |
| `'fast'` | ramp + **half**-strength motif bias, no alignment → amorphous | 270 frames | 200 °C |
| `'slow'` | ramp + **full** motif bias with orientation alignment (+ hex-directed attract if `attractK > 0`) → crystalline | 1440 frames | 200 °C |

`coolingStartERef` is captured at mode entry, so a ramp always starts from the current
temperature. `startCooling` zeroes `energyInput`, leaving the ramp as the only driver;
`onTempUpdate` syncs the LCD every 6 frames.

**Cooling gate:** Slow/Fast Cool are disabled unless `meltLocalTemp >= COOL_MIN_TEMP` (1500 °C).
An already-active mode can still be clicked off.

**GO box:** type a target temperature; `GlassViewer` ramps to it through the heat-capacity
integrator and stops on arrival. Capped at 1800 °C.

### Motif bias

`buildMotif` / `applyMotifForces`, strength `_motifStrength` (0.004) × ramp
(0 at 1500 °C → 1 at 600 °C), halved for fast cool. Uses **relative** targets, never absolute
positions:

- Each Si with 2–3 bonded O gets a best-fit 3-fold orientation φ (`fitPhi`, via `atan2` of
  `cos3θ`/`sin3θ`). Its O are assigned to unique slots at φ + k·120° (best of all 6 permutations,
  minimising total angular error), distance r0. A soft spring pulls each O toward its slot with an
  equal and opposite force on the Si, so momentum is conserved and the thermostat stays honest.
- Each 2-coordinated O is pulled toward the midpoint of its two Si, straightening Si-O-Si
  toward 180° (strength `k × 0.5`).
- In `'slow'` only, each Si's φ moves `_motifAlign` (0.5) of the way toward its neighbours'
  orientation **mod 60°** (both honeycomb sublattices share φ mod 60°), so domains spread.

### Other cooling behaviour

- The freed-atom kick multiplier fades from `_freedSpeedMult` to `_latticeSpeedMult` as the
  target drops 1300 → 600 °C. Without this, freed atoms run ~12× hotter than target and can
  never freeze.
- `attractK` defaults to **0**. At 0.10 the cooled solid over-densified (local density 7–8 vs
  crystal 4.6, 70–100 Si-Si pairs inside r0). The whole cooling-attract loop is therefore dead
  by default — and it's a full O(n²) pass per substep when enabled.
- Re-integration + `promoteBonds` is what actually makes the cooled network solid; see above.

**Headless results** (soda, 1500 °C melt then cool, `attractK` 0, motif 0.004, single seed):
fast cool ends at local order 0.55 / ψ6 0.60; slow cool 0.72 / 0.73. O-Si-O angle error goes
from ~15° in the melt to ~11° after either cool. Only ~60 % of atoms are freed at 1500 °C, so the
melt keeps some memory of the grains. **Measured before the current break-strain and Na-Na
values — re-run `meltStructure()` before quoting these.**

## Grid layout

`buildGrid` seeds a shuffle from the composition percentages (so a given composition always
produces the same layout), then `declumpGrid` makes up to 3 SiO2↔Na2O swaps. Each swap is the
one that most reduces orthogonal like-type adjacency, ties broken by the seeded `rand`.

`buildHexLayer` / `buildSquareLayer` place cations then bridge **same-chunk** nearest-neighbour
pairs with O at the midpoint (`nnSq = (a × 1.05)²` rejects diagonals on the square lattices).

`initPhysics` then runs **120 passes** of O(n²) overlap resolution (needed because chunk
polygons overlap) plus one O(n²) Si-O dead-zone pass that nudges pairs sitting in
`r_sum < d < r0` — a zone where neither hard-sphere nor spring acts, so atoms would float there
forever. Measured 15–39 ms; one-time, on composition change only.

---

# Rendering (`renderer.js`)

`renderer.js` also owns the **DPR cap** (`setMaxDpr` / `effectiveDpr`) used by every canvas in
the project — see 1c. Never call `window.devicePixelRatio` directly in this codebase.

`drawScene(canvas, phys, options)` is the only entry point. Options: `ts`, `visualScale`,
`bondRound`, `showField`, `showCharge`, `darkMode`, `bondNums`, `atomColorMode`,
`showBrokenBonds`, `showLiveStats`, `targetTempC`, `hoverIdx`, `selectedIdx`.

Draw order: grain outlines (blurred offscreen layer) → bond strain field (blurred offscreen
layer, screen/multiply composite) → broken-bond dashed overlay → atoms (+ ghost copies) →
selection/hover rings → charge halos → bond-count labels → live-stats HUD.

- **Bond strain field.** Lens shapes per non-broken bond, coloured by strain. Two strain paths:
  for pairs where **both** atoms are freed, `bond.strain` is used directly; otherwise the
  midpoint-averaged separation is compared against the **original lattice** separation
  (`r0s = hypot(pj.x0 − pi.x0, …)`), which suppresses thermal jitter. The both-freed guard
  matters: melt-formed pairs were never neighbours, so `r0s` can be 50–500 px and would render
  deeply negative strain (solid pink).
- **Thermal fade.** `thermPink = clamp((targetTempC − 500) / 250)` multiplies strain before
  colouring, so a cooled solid goes grey across 750 → 500 °C regardless of strain.
- **Broken bonds are not drawn as bonds** — they'd read as long pink streaks. The
  `showBrokenBonds` dev overlay draws them as dashed blue lines instead.
- `bondCurDistAlpha` fades a bond lens out between 14 px and 25 px of current separation.
- **Grain outlines freeze and dissolve permanently.** `chunk._hull` (Andrew's monotone chain over
  `x0`/`y0`) is captured on first draw and never recomputed. A grain is marked in
  `phys.chunkDissolved` once ≥ `BOND_FRAC` of its bonds are broken or ≥ 25 % of its atoms are
  freed — and never comes back, so re-integration during cooling can't resurrect borders.
  `BOND_FRAC = window._chunkBondFrac ?? 0.40`, i.e. live-tunable from the console.
- **Ghost copies** implement the toroidal wrap visually: atoms within `GHOST_ZONE` (25 px) of an
  edge are redrawn at ±`SIM_W` / ±`SIM_H`.
- `_visualScale` (dev slider 0.5–10) amplifies displacement from `x0` for visibility without
  touching physics. `canvasJitter` is a stub returning zero — real thermal motion supplies the
  animation.
- `COLOR_STOPS` (dark) and `COLOR_STOPS_LIGHT` are separate ramps; light mode also switches the
  field composite to `multiply` so low-energy bonds stay visible.
- `C = { Si, O, Na, Ca }` — atom fill colours, imported by the UI for legend consistency.
- `atomColorMode`: `'normal'` | `'freed'` | `'coordination'` | `'attract'` (dev panel buttons).

`drawPhysics` — the second, duplicate renderer that used to live inside `meltPhysics.js` — has
been **deleted**. `renderer.js` is the only renderer.

---

# UI (`GlassViewer.jsx`)

## Presets

Only two: **Pure SiO₂** (100/0/0, 1800 sand grains) and **High Na₂O** (70/30/0, 2250 grains).
Soda-lime exists in the physics but not as a preset button.

## Tab contract — read before touching either RAF loop

Two tabs, both driven by one shared temperature, **never simulating in the same frame**:

| Tab button | `tab` | Renders | Sim |
|---|---|---|---|
| "Particles and Fields" | `'melt'` | `CompositionView` (atoms, bonds, strain field) | `meltPhysics.js` |
| "Bulk Material" | `'glass'` | `boxCanvasRef` (sand grains / SPH blob / metaball) | `sandPhysics.js` or `glassPhysics.js` |

Rules this layout depends on:

1. **Both are always mounted.** The melt tab lives inside a `display:none` wrapper when hidden,
   not behind a `&&`. Conditionally rendering it destroys its physics and forces a full rebuild on
   every switch, which is what the mount used to do.
2. **`tabRef` gates the simulations**, not React state — the RAF closures are created once with
   `[]` deps and never see state updates. `tabRef.current` is synced by its own effect.
3. **Freezing is by guard, not by cancelling the RAF.** `CompositionView` keeps its RAF and
   early-skips the expensive block via `activeRef`. The box loop keeps its RAF and skips its
   whole body. Cancelling instead would mean restarting on every switch.
4. **The melt energy ramp runs even when frozen** — it is the only temperature driver for
   Slow/Fast Cool, and the Bulk Material tab has Cool buttons. The `activeRef` guard sits below
   the ramp for exactly this reason. Moving it above breaks cross-tab cooling.
5. **Frozen state has a validity condition.** `frozenCondRef` records `{temp, preset, cooling,
   heat}` per tab at the moment it goes inactive; on reactivation a mismatch triggers a rebuild
   (`setMeltResetToken` for melt, nulling `phys.sandParticles`/`phys.particles` for the box).
   Dev-panel physics sliders are deliberately **not** tracked — they mutate shared module state in
   `meltPhysics.js` and would need 29 more dependencies. Dev-only, so a frozen state can be
   slightly stale after a slider move; change the temperature or switch twice to force a rebuild.

## Always-visible toggles

| Control | Effect |
|---|---|
| Charge | `showCharge` — radial charge halos (blue cations, orange O). Allocates a gradient per atom per frame. |
| Field | `showField` — the blurred bond strain field. Forced off and the button disabled on `simple` quality; the UI reads `effectiveShowField`, never raw `showField`. |
| Count / Graph | right panel: bond-count table vs energy graph |
| Turtle / Rabbit | `simSpeed` (default **0.5**) |
| Slow / Fast Heat, Slow / Fast Cool | cooling modes; cool gated at 1500 °C |
| GO + temperature box | ramp to a typed target through the heat-capacity integrator |
| Replay scrubber | appears once a ramp has recorded frames |

## Dev panel (type "dev" to toggle)

29 setters are wired. In panel order:

| Slider | Range | Default | Sets |
|---|---|---|---|
| Si-O break strain | 0.02–0.30 | 0.04 | `_breakStrain` |
| Na break strain | 0.005–0.15 | 0.02 | `_naBreakStrain` |
| Feedback gain × | 0–200 | 40 | `_feedbackGainMult` |
| Intact bond stiffness × | 0–5 | 1.0 | `_bondStiffMult` |
| Sev trigger dist | 5–20 px | 13 | `_sevTriggerDist` |
| Sev cooldown | 0–300 steps | 60 | `_sevCooldown` |
| Sev pull (ion→O) | 0–0.05 | 0.01 | `_sevPullK` |
| Freed speed × | 0.25–15 | 5 | `_freedSpeedMult` |
| Freed τ (travel) | 0.01–0.2 | 0.01 | `_freedTau` |
| Melt heat capacity plateau | 1–8 | 4 | `hcPlateau` (React state, not a module mutable) |
| Si-Si repulsion r₀ | 10–20 px | 15.6 | `PAIR_TABLE[0][0].r0`; shows resulting min Si-O-Si angle |
| Na-Na repulsion r₀ | 6–40 px | 35 | `PAIR_TABLE[2][2].r0` |
| Motif strength | 0–0.02 | 0.004 | `_motifStrength` |
| Motif align (slow) | 0–1 | 0.5 | `_motifAlign` |
| Si-O r₀ | 5–15 px | 9 | `PREFERRED['O-Si'].r0` via `setSiOr0` (prop-driven, rebuilds the grid) |
| Attract K | 0–0.5 | **0** | cooling attract strength |
| Attract falloff | 1–4 | 1.0 | `f ∝ r0 / d^falloff` |
| Speed × | 0.5–4.0 | 1.0 | `speedMult` into the thermostat |
| Si-O hot capture × | 1.01–1.50 | 1.07 | `_sioHotMult` |
| Freed Si-O long-range attract | 0–4 | 1.0 | `_freeAttractSiOMult` |
| Si-O freed excl × | 1.0–2.0 | 1.4 | `_sioExclMult`; shows live minD in px |
| Crystal jiggle × | 0.5–5.0 | 1.0 | `_crystJiggleMult` |
| Si-O spring k | 0.01–0.20 | 0.061 | `PREFERRED['O-Si'].k` |
| Na-O spring k | 0.005–0.10 | 0.042 | `PREFERRED['Na-O'].k` |
| Reform strain | −0.15–0.0 | 0.0 | `_reformStrain` |
| Crystal anchor k | 0–0.15 | 0.06 | `_crystAnchorK` |
| Liberate frac | 0.0–1.0 | 0.5 | `_liberateFrac` |
| Na anchor k | 0–0.15 | 0.06 | `_naAnchorK` |
| Na liberate frac | 0.0–1.0 | 0.5 | `_naLiberateFrac` |
| Break strain spread | 0–0.20 | 0.15 | `_breakStrainSpread` |
| Lattice speed × | 0.25–3.0 | 1.0 | `_latticeSpeedMult` |
| Reint bonds N | 1–6 | 2 | `_reintBondN` |
| Reint frames M | 5–120 | 30 | `_reintFrameM` |
| Visual scale | 0.5–10.0 | 1.0 | `setVisualScale` (render only) |

Checkboxes: **Broken bonds** (`showBrokenBonds`), **Live stats** (`showLiveStats` HUD),
**EMA strain** (`_useEmaStrain`, default off), **Bond #s** (`bondNums`), **Mini photo view**
(`showMiniView`, default off — now effectively disabled, see 1; it rendered a second live
metaball with its own `getImageData` pass).

Plus the global **── Quality ──** tier override (`detailed` / `simple`), at the top of the dev
panel outside the per-tab blocks. It drives `bondStrainField`, `maxDpr`, `blobGlowBlur` and
(parked) `sandGrainScale`. See 1c.

The Pre-Compute checkbox is **gone**, along with the precompute system behind it.

## Module-level mutables (`meltPhysics.js`, ES module singleton)

**25** of them — grep `^let _` in `meltPhysics.js`. They are module state, so they persist
across composition changes and are shared by every component that imports the module; nothing
resets them on a composition rebuild.

There are **29 exported `set…` functions**, more than there are mutables, because four of them
write into shared objects rather than into a `let`: `setSiSiRepR0` / `setNaNaRepR0`
(`PAIR_TABLE[i][i].r0`), `setSioK` / `setNaOK` (`PREFERRED[…].k`), plus `setSiOr0`
(`PREFERRED['O-Si'].r0`) and the `getSiSiRepR0` reader. Mutating `PREFERRED` takes effect
immediately everywhere, but **existing rigid bonds keep the `r0` they were created with** — so
moving the Si-O r₀ slider changes new bonds and the force law without relaxing the old bonds.

Defaults for all of them are in the dev-panel table above; `_useEmaStrain` (false) is the one set
from `CompositionView` rather than `GlassViewer`.

## Bond count display (COUNT view)

Reads `countBonds(phys)`, throttled to a 300 ms minimum interval.

**`countBonds` iterates `phys.rigidBonds` only** and counts intact vs total, classified by
`rb.isSiO` first, then Na (typeId 2), then Ca (typeId 3). It does **not** count dynamic melt
bonds, and it does not read `phys.bonds`.

| Row | Meaning |
|---|---|
| Before | `initialBondCounts`, captured on the first callback after physics settles |
| Now | current live count |
| Broken | `max(0, before − now)` |
| Total | this type's share of all broken bonds |
| Run Δ | signed delta from `modeBondCounts` (captured at cooling/heating mode entry); green = forming, red = breaking; only shown while a mode is active |

Na-O and Ca-O columns only appear when `initial.nao.total > 0` / `initial.cao.total > 0`.

---

# Console diagnostics

All installed on `window` from `CompositionView`'s init effect (so they are re-bound on every
composition change) except `sandStats`, which comes from `GlassViewer`. `window._meltPhys` is the
live `phys` object.

| Call | What it prints |
|---|---|
| `meltStructure()` | One table: mean Si/O coordination, % Si with >3 / <3 O, Si-Si pairs inside the repulsion r0, mean Si-Si nearest neighbour, atoms within 20 px per Si, global hex order ψ6, local order (mean cos 6Δφ between Si sharing an O), O-Si-O rms angle error, plus the relevant r0s and current motif k. **Run it at startup as the crystal reference.** |
| `meltDebug()` | Four tables: system (2 temperature rows, KE, bondedKE, ratio, `bondBreakPE`, cumulative KE, total energy added, anchor state); per species (count, `bonded%`, `free%`, `liberated%`, cation count, `whole%`, `meanLifeFr`); bond break stats per type; intra-grain vs inter-grain live bonds by `chunkIdx` (inter > 0 means cross-grain bonds formed in the liquid). |
| `measureStrain95()` | p50/p95 strain over intact rigid bonds, plus `fBroken`. |
| `bondAudit()` | Freed-pair bonds: `r0s_orig`, `actualD`, `bondStrain`, `renderedStrain`. |
| `getStrainStats()` | n, mean, p95, p99, max strain over non-broken rigid bonds. |
| `getFreedStats()` | SiO2 / Na2O freed percentages and raw counts. |
| `getDisplacementStats()` | mean / max displacement from `x0`, % over 9 px. |
| `getBreakStats()` | per-step latent-heat KE removed / returned / net, total KE, `latticeTemp`. |
| `getKERatio()` | measured KE vs target KE and the implied temperature. |
| `getSioStats()` | SiO2 bonded % and mean bond lifetime in frames. |
| `getLibStats()` / `resetLibStats()` | liberation instrumentation: `contactFires`, `strainFires`, and up to 200 recorded contact separations. |
| `resetLifetimes()` | zeroes the bond-lifetime bookkeeping. |
| `setMeltTemp(T)` | jumps the melt target without driving the UI — handy for scripted measurement. |
| `window.sandStats()` | sand particle speed histogram. Installed from `GlassViewer`, not `CompositionView`, and deleted on unmount. |

Live-tunable console hooks that are not in the dev panel: `window._chunkBondFrac` (grain-outline
dissolve threshold, default 0.40, read by `renderer.js` every frame). `window._naBlobs` and
`window._blobMct` are exposed read-only for sand-tab inspection.

Note `meltDebug()`'s system table has **two** temperature rows now — `tempC (target)` and
`tempC (total KE)`. The old third row (`KE÷boost est.`) went away with the freed-atom velocity
boost.

---

# Sand tab (`sandPhysics.js`)

Position-based dynamics, not force integration: gravity → predict → 10-pass position constraint
solve → derive velocity from displacement → wall restitution + velocity-dependent damping.
Settled grains zero their own velocity as a consequence, with no explicit zeroing.

| Constant | Value |
|---|---|
| `GRAIN_R` / `_MIN` / `_MAX` | 2.25 / 1.6 / 3.2 |
| `N_GRAINS` | 2250 max (pure sand uses 1800) |
| `NA_R` | 1.5 (Na micro-grains) |
| `CELL` | `GRAIN_R_MAX × 2` = 6.4 px; the loop scans **±4 cells** to cover large merged grains |
| `LARGE_R` | `GRAIN_R_MAX × 1.5` = 4.8 px — grains above this use a linear scan |
| `NA_BLOB_R_CTR` / `_CONVERT_R` | 1.0 (phantom centre, never collides) / 5.0 |
| `SAND_COLORS` | 12 gold/tan hexes |

The spatial grid here is the pattern to port into `meltPhysics.js`.

**Grain type chain:** `sand` → (Na+sand contact, >1000 °C) → `silicate` → (r ≥ 5.0) → soft blob
of `na-sub` circles. `na` grains also merge directly into each other.

- `na2oPct` → count fraction via `min(0.70, (na2oPct/30) × 0.36)`. At 30 %, ~36 % of grains by
  count are Na but only ~20 % by volume.
- **Na blob system**: phantom centre + hex-packed sub-circles + radial (`k` 200) and neighbour
  (`k` 100) springs. Spring integration, velocity kill, rigid-body projection and gravitational
  flattening are all cubic in `(1 − t)` and near zero above 800 °C. Conversion is rate-limited to
  one grain per frame.
- **Merge dwell time**: `checkNaBlobMerges` needs `max(5, round(20/tempFactor))` consecutive
  contact frames — 20 frames at 1200 °C, 400 at 700 °C. Stops hot collisions from merging.
- **Absorption** (`absorbNearbyGrains`): checks proximity to sub-circles, not the centre.
  na/silicate at `tempF × 0.008` per frame, sand at `tempF × 0.002`. Gated above 700 °C.

# Glass tab (`glassPhysics.js`)

Clavet, Beaudoin & Poulin (2005) SPH, algorithms 1–4: viscosity impulses, spring adjust, spring
displace, double density relaxation. `adjustSprings` is the plasticity mechanism; `alpha` sets
how fast springs adapt to deformation.

| Constant | Value |
|---|---|
| `PARTICLE_R` / `H` | 4.5 / 12 |
| `N_PARTICLES` | 500 |
| `FIXED_DT` | 1/120 |
| `T_RIGID` | 200 °C |
| `MAX_SPEED` | 800 px/s |
| sigma / alpha / kSpring | cold 60 / 0.005 / 15000 → hot 25 / 0.019 / 7000 |

- `tempParams(tempC)` interpolates sigma/alpha/kSpring **geometrically** (log-linear), because
  glass viscosity follows Arrhenius/VTF. Those three only begin easing above **590 °C** (the glass
  transition); `velDamp` and `rigidFrac` use the full 25–1200 °C cubic range. This asymmetry is
  deliberate.
- The cold-end values sit near documented stability limits (kSpring 15000 vs ~19000;
  sigma 60 vs ~80). Don't raise them without re-deriving.
- **Rigid-body mode below `T_RIGID`**: SPH is abandoned entirely. `freezeParticles` computes CM
  and ω = Σr×Δv / Σ|r|² and locks the shape; `stepRigidBody` uses proper 2D impulses,
  `J = −(1+e)·v_n / (1/M + r_CN²/I)`, applied at the average contact centroid per wall.
- **Floor mode** (`stepFloorPhysics`): same SPH pipeline, different boundaries — gravity always
  down, floor at a given Y, canvas-edge side walls, no top wall, optional stick obstacle as a
  zero-restitution line segment. Used when the box is dropped.
- `resolveOverlaps` runs **after** double density relaxation so pressure pushes can't create new
  overlaps that escape the wall clamp. Order matters.
- ⚠️ `springKey(i, j) = i × N_PARTICLES + j`. Change `N_PARTICLES` from 500 and every existing
  spring map silently becomes invalid.

---

# Dead code and traps

## ~~`if (true)` in `GlassViewer.jsx`~~ — fixed

Was running the entire box simulation on every tab. Now `if (tabRef.current === 'glass')`.
See 1 in the performance section for the full tab contract, including the one trap: the melt
tab's energy ramp must keep running while the tab is frozen, or cooling on the Bulk Material tab
stops working.

## `freeRep` springs never fire (grep `spec.freeRepR0 &&`)

The XPBD freed-ion exclusion floor exceeds `freeRepR0` for every pair type, so the spring's
trigger condition is unreachable:

| Pair | XPBD minD | cooling minD | `freeRepR0` | Result |
|---|---|---|---|---|
| Na-O | (3.6+2.3)×2.0 = 11.8 | min(11.8, 10.8) = 10.8 | 7 | dead |
| Ca-O | (4.5+2.3)×2.0 = 13.6 | min(13.6, 10.8) = 10.8 | 8 | dead |
| O-O | (2.3+2.3)×2.0 = 9.2 | 9.2 (repOnly, no clamp) | 6 | dead |

Both mechanisms require the same both-freed condition, so the hard floor always wins. Keep the
code for now — the intent (preventing tight ionic pairs) is real and may inform a redesign — but
know it does nothing.

## `breakable` is always `true`, so four `!rb.breakable` branches are unreachable

Both `buildRigidBondMap` and `promoteBonds` set `breakable: true`
unconditionally. Therefore:

| Location | Dead code | Consequence |
|---|---|---|
| grep `!rb.broken && !rb.breakable` | `if (!rb.broken && !rb.breakable) crystAnchor[…] = 1` | adds nothing; `crystAnchor` comes entirely from the typeId/cellType test above it |
| grep `hasSiOBond[rb.i] = 1` | `if (!rb.breakable) hasSiOBond[…] = 1` | `hasSiOBond` is never set |
| grep `hasSiOBond[i] ? 5 :` | `const limit = hasSiOBond[i] ? 5 : LOOSE_WANDER` | always `LOOSE_WANDER`; the tight 5 px Si clamp no longer exists |
| grep `// Si-O only` | `if (rb.broken \|\| rb.breakable) continue` | the whole cluster co-liberation loop is dead — a contact-liberated atom's bond partners are never freed with it |

Three other `if (!rb.breakable) continue` / `if (!rb.breakable || rb.broken) continue` sites
(the two break/reform loops and `measureStrain95`) also test it, but there the test is a skip-guard, so
"never skips" is the correct behaviour. Those are fine.

## Stale comments to fix

Line numbers go stale — that is how this file drifted in the first place. Each entry below
gives a grep-able snippet instead.

| Grep for | What's wrong |
|---|---|
| `= 1.125e-6; ePerParticle` | `ENERGY_UNIT` is `1.62e-6`. Stale from `THERMAL_SPEED = 0.0015`. |
| `with THERMAL_SPEED=0.005` (the `mult` calibration block above `PREFERRED`) | Derives escape temperatures from `THERMAL_SPEED = 0.005` (it's 0.0018) and quotes Na-O r0 = 16 (it's 12). The whole block predates the current numbers. |
| `// Na-Na  (Na⁺)` and the two comment lines above it | Claim `r0 16` and "crystal Na-Na = 24px, unaffected". The value is 35 and the claim no longer holds. |
| `excludes freed atoms running at boosted thermal speed` | There is no velocity boost any more. `computeBondedKE` filters on `intactCount > 0`, nothing else. |
| `Si-O breaks only above 1700°C` | The cutoff is `sioProjCutoff`: 1300 °C with any modifier, 1800 °C for pure SiO₂. |
| `Si-O: XPBD enforced up to 1700 °C` (and the `Na-O / Ca-O … 650 °C` line under it) | Si-O is 1300/1800 per `sioProjCutoff`; Na/Ca is `650 + 480·random()` per bond, i.e. spread over 650–1130 °C. |
| `_crystJiggleMult × larger kicks (default 3.3)` | It defaults to 1.0. |
| `Broken bonds stay in the list so atoms visibly stretch pink` | They do stay in `phys.bonds`, but `renderer.js` skips `bond.broken` entirely, so they are not drawn as bonds. Only the `showBrokenBonds` dashed overlay shows them. |
| `latticeTemp = keTarget/ENERGY_UNIT-273` (in `CompositionView.jsx`) | That assignment is overwritten later in the same `stepPhysics` call; `latticeTemp` is a measured value. |

`AUDIT.md` was committed already stale — it listed `drawPhysics` and the precompute functions as
live exports, and only 2 of the 25 module mutables, while its own renderer section said
`drawPhysics` had been removed. **It has been superseded by this file and deleted.**

## Deleted — don't go looking for them

`drawPhysics`, `computeAmorphousTargets`, `computeSlowCoolTargets`, `initPrecompute`,
`stepPrecompute`, `crystallize`, `BOND_BREAK_ENERGY`, the freed-atom velocity boost, the
freed-atom force halving, and the Pre-Compute checkbox are all gone from `v3/`. Older copies
survive in `v1/` and `v2/`; those are not built.

---

# Known conflicts with SPEC.md

⚠️ **`SPEC.md` is not in this repository and never has been** (checked against the full git
history). The previous CLAUDE.md carried this section anyway. Either the spec lives somewhere
outside the repo or it was never written down. Until it turns up, treat the items below as
standing open questions about the model, not as deviations from an agreed document — and if the
spec does exist, please add it to the repo so this section can mean something.

Recorded observations, not decisions. **Do not resolve them silently.**

**(a) ~~UI temperature is the thermostat target~~ — no longer true in the code.** Temperature is
now measured from kinetic energy in two places, and they disagree: `phys.latticeTemp` averages
over **bonded** atoms (`intactCount > 0`), while the UI's
`derivedTemp` averages over **all** atoms and applies a 0.08 EMA. With no velocity boost left the
two are much closer than they used to be, but they are not the same number. Decide which one the
student should see.

**(b) The bonded-atom average is still statistically thin at melt temperature.** `latticeTemp`
and `computeBondedKE` both count only atoms with `intactCount > 0`. At 1500 °C on soda, 370–457
of 716 atoms are freed; at higher temperatures or on compositions that melt harder the bonded
population can collapse to a handful, making the average noisy right where the student is
looking. The all-atom UI readout avoids this but mixes freed and bonded populations.

**(c) The "~70 % SiO₂ whole at 1800 °C" target** (recorded in the old CLAUDE.md as coming from
SPEC.md; the stochastic break model it was written against has since been replaced by strain
breaking) has not been re-checked against the strain model since the break
strains changed to 0.04 / 0.02 and the feedback gain to 40. The last measurement under the old
values gave ~96 % of atoms freed and mean Si coordination 1.1, i.e. not met. Re-measure before
treating this as either met or broken.
