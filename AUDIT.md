# Audit: Exports and Module-Level Mutables vs. CLAUDE.md

---

## meltPhysics.js

**Module-level mutables**

| Name | What it does | In CLAUDE.md? |
|---|---|---|
| `let _sioHotMult = 1.07` | Si-O capture multiplier at high temp (>1100°C); tunable via dev slider | Yes — "Si-O capture range" and "Module-level mutable params" |
| `let _freeAttractSiOMult = 1.0` | Scales always-on long-range attract force for freed Si-O pairs | Yes — "Freed Si-O bonding" and "Module-level mutable params" |

**Exported constants**

| Name | What it does | In CLAUDE.md? |
|---|---|---|
| `PHYSICS_START_TEMP = 0` | Starting temperature on init | No |
| `SIM_W = 600` | Physics domain width in px | No |
| `SIM_H = 350` | Physics domain height in px | No |
| `THERMAL_SPEED = 0.0018` | v_rms = THERMAL_SPEED × √T px/substep | Yes |
| `ENERGY_UNIT` | THERMAL_SPEED²/2 = 1.62e-6; ePerParticle = (T+273) × ENERGY_UNIT | Yes |
| `SUBSTEPS = 6` | Physics substeps per RAF frame | Yes |
| `THERMOSTAT_TAU = 0.10` | Berendsen coupling strength per substep | Yes |
| `FORCE_CUTOFF = 20` | Pairwise force early-reject radius in px | Yes |
| `ATTRACT_RANGE = 40` | Long-range cooling attract cutoff in px | Yes |
| `FREE_EXCL = 2.0` | Freed-ion exclusion zone = 2× contact radius | Yes |
| `ANCHOR_MELT_TEMP = 600` | Above this, lattice anchor disabled forever | Yes |

**Exported functions**

| Function | What it does | In CLAUDE.md? |
|---|---|---|
| `setSioHotMult(v)` | Sets `_sioHotMult`; called from dev slider onChange | Yes — named in "Si-O capture range" |
| `setFreeAttractSiOMult(v)` | Sets `_freeAttractSiOMult`; called from dev slider onChange | Yes — named in "Freed Si-O bonding" |
| `initPhysics(cellData)` | Creates particle array from grid cell data, resolves 120 overlap passes, snaps Si-O dead-zone pairs, builds chunks metadata, returns phys object | No |
| `buildRigidBondMap(phys)` | Snapshots all current in-range pairs as rigid bonds; now sets all bonds `breakable: true`; sets `breakStart`/`breakFull` by pair type; called once after init | No |
| `computeKE(phys)` | Sums KE of all particles including freed | No |
| `computeBondedKE(phys)` | Sums KE of non-freed particles only; used for thermostat temperature display | No |
| `computePE(phys)` | Sums PE from all active bond springs | No |
| `stepPhysics(phys, ePerParticle, coolingFactor, attractK, coolingMode, speedMult, attractFalloff)` | Full physics step: XPBD bonds, pairwise forces, thermostat, liberation, stochastic break/reform, crystal/Na anchors, GUIDE bias | Mentioned by name only; signature not documented |
| `setSiOr0(r0)` | Live-mutates `PREFERRED['O-Si'].r0`; wired to Si-O r₀ dev slider | No |
| `crystallize(phys, strength, minCluster, angleTol)` | BFS detects Si atoms with ≥3 O bonds, nudges O toward ideal 120° hex slots for slow cool | Behavior described in "Cooling modes"; signature not documented |
| `computeAmorphousTargets(phys)` | Builds random amorphous network target positions used by fast-cool precompute | No |
| `computeSlowCoolTargets(phys, sio2Pct, na2oPct, caoPct)` | Builds hex crystal lattice targets with random nucleation seeds; used by slow-cool GUIDE bias | No |
| `initPrecompute(phys, targets)` | Captures current particle velocities before precompute begins | No |
| `stepPrecompute(phys, frame, lerpRate)` | Advances particles toward precomputed targets with DAMP=0.97; used for fast-cool animation | Mentioned by name in "Cooling modes" only |
| `rebuildBonds(phys)` | Reconstructs bond list from current particle positions; used for replay mode | No |
| `drawPhysics(canvas, phys, svgW, svgH, lerpT, debug, bondNums)` | Second, separate renderer embedded inside meltPhysics.js; its own COLOR_STOPS, strainColor, fillLens; caps halfL at 7; different color ramp than renderer.js | No |

---

## renderer.js

**No module-level mutables** (all constants are `const`).

**Exported constants**

| Name | What it does | In CLAUDE.md? |
|---|---|---|
| `VW = 600` | Renderer viewport width; matches SIM_W | No |
| `VH = 350` | Renderer viewport height; matches SIM_H | No |
| `C = { Si, O, Na, Ca }` | Atom fill colors: Si gold, O red, Na green, Ca blue | No |

**Exported functions**

| Function | What it does | In CLAUDE.md? |
|---|---|---|
| `drawScene(canvas, phys, options)` | Main renderer: chunk outlines (blurred), atoms with ghost copies, bond strain field (blurred screen-composite), charge halos, bond-count labels; options: ts, visualScale, bondRound, showField, showCharge, darkMode, bondNums | Named in project layout only; options not documented |

---

## sandPhysics.js

**Module-level mutables (private, not exported)**

| Name | What it does | In CLAUDE.md? |
|---|---|---|
| `let _gridW`, `let _gridH`, `let _nodeG`, `let _nodeNxt` | Typed-array spatial grid for collision detection; rebuilt each step | No |
| `let _blobId` | Monotonically increasing blob ID counter | No |
| `const _toAbsorb` | Uint8Array scratch buffer for merge operations | No |

**Exported constants**

| Name | What it does | In CLAUDE.md? |
|---|---|---|
| `GRAIN_R = 2.25` | Average sand grain radius for packing layout | No |
| `GRAIN_R_MIN = 1.6` | Minimum random grain radius | No |
| `GRAIN_R_MAX = 3.2` | Maximum random grain radius | No |
| `N_GRAINS = 2250` | Max grain count; pure sand uses 1800 | No |
| `SAND_COLORS` | 12-entry array of hex gold/tan sand colors | No |
| `NA_BLOB_R_CTR = 1.0` | Phantom center radius (never collides) | No |
| `NA_BLOB_CONVERT_R = 5.0` | Na grain radius that triggers conversion to soft blob | No |

**Exported functions**

| Function | What it does | In CLAUDE.md? |
|---|---|---|
| `initSandParticles(HS, multiRadius, na2oPct, nGrains)` | Hex-packs grains in a square box; randomly scatters Na micro-grains by count fraction derived from na2oPct | No |
| `mergeSodaGrains(grains, meldProb)` | Merges touching Na grains by area-weighted position/velocity; caps merged radius at 10×NA_R; call once per visual frame | No |
| `mergeSilicateGrains(grains, naSandProb, silSilProb, maxMerges)` | Na+sand → silicate and silicate+silicate → silicate merges; up to maxMerges=5 per call | No |
| `stepSandPhysics(grains, dt, HS, boxAngle)` | PBD: gravity → predict → 10-pass position constraint solve (spatial grid + large-grain linear scan) → derive velocity → wall restitution + velocity-dependent damping | No |
| `makeNaBlob(cx, cy, vx, vy, blobR)` | Creates a hex-packed soft body from a merged Na grain: phantom center + sub-circles + radial and neighbor springs | No |
| `stepNaBlobSprings(naBlobs, dt, boxAngle, temp)` | Spring force integration + velocity kill (velDamp) + rigid body projection (rigidFrac) + gravitational flattening; all factors cubic in (1−t), near-zero above 800°C | No |
| `convertLargeNaGrains(grains, naBlobs)` | Converts at most one silicate grain ≥ NA_BLOB_CONVERT_R per call into a soft blob; rate-limits conversion to one per frame | No |
| `checkNaBlobMerges(naBlobs, mct, grains, temp)` | Checks blob-pair proximity; merges after frameTarget consecutive contact frames; frameTarget = max(5, round(20/tempFactor)) | No |
| `absorbNearbyGrains(grains, naBlobs, temp)` | Absorbs touching na/silicate/sand grains into blobs; sand absorbs ~4× slower than Na/silicate; only active above 700°C | No |

---

## glassPhysics.js

**No module-level mutables.**

**Exported constants**

| Name | What it does | In CLAUDE.md? |
|---|---|---|
| `PARTICLE_R = 4.5` | SPH particle radius | No |
| `H = 12` | SPH smoothing length | No |
| `N_PARTICLES = 500` | Default particle count | No |
| `FIXED_DT = 1/120` | Physics timestep | No |
| `T_RIGID = 200` | °C freeze threshold; below this, blob switches to rigid body mode | No |

**Exported functions**

| Function | What it does | In CLAUDE.md? |
|---|---|---|
| `tempParams(tempC)` | Maps temperature to `{ sigma, alpha, kSpring, velDamp, rigidFrac, gamma, beta }` using geometric (log-linear) interpolation for sigma/alpha/kSpring (Arrhenius-like), cubic falloff for velDamp/rigidFrac; fluid params only ease above 590°C | No |
| `initParticles()` | Creates N_PARTICLES in a hex-offset grid with small random jitter; sets px/py = x/y | No |
| `stepPhysics(particles, springs, dt, HS, boxAngle, tempC)` | Full SPH-viscoelastic step: gravity+velDamp → viscosity impulses → spring adjust → spring displacements → double density relaxation → overlap resolve → wall clamp → velocity derive → speed cap → rigid body velocity projection | No |
| `freezeParticles(particles)` | Computes rigid body state (cx/cy/vcx/vcy/theta/omega/refX/refY/I) from current particle positions and velocities; called at T < T_RIGID | No |
| `syncParticlesToRigidBody(particles, rb)` | Writes particle x/y/vx/vy from rigid body state each frame below T_RIGID | No |
| `stepRigidBody(rb, dt, HS, boxAngle)` | Rigid body integration: gravity+damping, speed caps, position correction (8 iterations), wall velocity impulses at each wall using average contact centroid | No |
| `stepFloorPhysics(particles, springs, dt, floorY, canvasW, tempC, stickA, stickB)` | World-space physics after box is removed: same SPH pipeline but floor at floorY, canvas-edge side walls, no top wall, optional stick obstacle as line-segment hard boundary | No |

---

## Undocumented behavior

### meltPhysics.js

**Exported constants not in CLAUDE.md:**
- `PHYSICS_START_TEMP = 0` — the initial temperature the simulation starts at on first load
- `SIM_W = 600`, `SIM_H = 350` — physics domain dimensions; imported by CompositionView and renderer.js as canonical bounds

**Exported functions not in CLAUDE.md:**
- `initPhysics(cellData)` — creates the entire phys object from grid input; 120-pass overlap resolution; dead-zone snapping for Si-O pairs that would start inside r0; builds `phys.chunks` convex hulls from per-grain pIdxs
- `buildRigidBondMap(phys)` — the function that makes the bond list permanent; key place where `breakable: true` / `breakStart` / `breakFull` are set; calling it again would reset bond state
- `computeKE(phys)`, `computeBondedKE(phys)`, `computePE(phys)` — energy measurement; `computeBondedKE` drives the thermostat temperature display, not `computeKE`; freed atoms' boosted velocities inflate `computeKE` but not `computeBondedKE`; this distinction determines what temperature the UI shows
- `setSiOr0(r0)` — live-mutates the Si-O equilibrium distance; changes the spring rest length in PREFERRED but does not rebuild bonds; existing rigid bonds retain their original r0
- `computeAmorphousTargets(phys)` — builds target positions for fast-cool; stored for stepPrecompute to lerp toward; called once before precompute starts
- `computeSlowCoolTargets(phys, sio2Pct, na2oPct, caoPct)` — builds a hex crystal lattice with multiple random nucleation seeds; BFS assigns atoms to nearest seed; composition percentages affect lattice parameters
- `initPrecompute(phys, targets)` — captures and stashes pre-precompute velocities so they can be restored if precompute is cancelled
- `stepPrecompute(phys, frame, lerpRate)` — moves atoms toward targets with DAMP=0.97; does not run thermostat; atoms reach targets by exponential approach; frame count determines blend weight
- `rebuildBonds(phys)` — used only in replay mode to reconstruct bond geometry from atom positions after physics state is scrubbed; without it, replay shows no bonds
- `drawPhysics(canvas, phys, svgW, svgH, lerpT, debug, bondNums)` — a **complete second renderer** inside meltPhysics.js with its own private:
  - `COLOR_STOPS`: `[[0.00,172,167,160],[0.12,255,180,230],[0.28,255,40,180],[0.80,160,0,255],[1.00,0,200,255]]` — different ramp from renderer.js; goes through teal at the hot end instead of pink
  - `strainColor(strain)` — outputs `rgb(...)` string (not an RGB array like renderer.js version)
  - `fillLens(...)` — caps `halfL` at 7, unlike renderer.js which uses `len * 0.40` uncapped
  - `ATOM_COLOR` map — its own per-type fill colors (may differ from renderer.js `C` object)
  - Supports `lerpT` lerp factor for replay scrubbing and `bondNums` overlay
  - Uses `COORD_TARGET = [3, 2, 1, 2]` for bond-count coloring

**Private structures not in CLAUDE.md:**
- `phys.dbg` — debug object updated each step; used by `meltDebug()`; exact fields not documented
- `phys.bondBreakPE` — latent heat field; accumulates `BOND_BREAK_ENERGY` per broken Na-O bond; subtracted from displayed temperature to simulate heat absorption; creates a temperature dip when Na-O bonds break rapidly
- `COORD_TARGET = [3, 2, 1, 2]` — per-typeId target bond counts (Si=3, O=2, Na=1, Ca=2); used in bondNums overlay coloring: green if count ≥ target, yellow if partial, red if zero
- `nearestAssign()` — private; used inside `computeSlowCoolTargets` to assign atoms to nearest lattice site; determines crystal grain boundaries
- `idealHexAngle()` — private; used by `crystallize()` to compute the ideal 120°-offset angle for O placement around a Si center
- Null-spec repulsion path: pairs like Na-Si and Ca-Si have no entry in PAIR_TABLE; they receive generic repulsion `f = -REP_K × (cutoff − d)` where `cutoff = (ri + rj) × REP_MULT (1.8)`. This creates a large energy barrier — likely the reason contact liberation of SiO2 atoms by freed Na2O atoms is unreliable.

---

### renderer.js

**Exported constants not in CLAUDE.md:**
- `VW = 600`, `VH = 350` — renderer viewport; defined independently from meltPhysics.js; if SIM dimensions changed, renderer would need a separate update
- `C = { Si, O, Na, Ca }` — atom colors; imported by other modules for UI consistency

**Unexported internals not in CLAUDE.md:**
- `canvasJitter(_idx, _t)` — stub returning `{jx:0, jy:0}`; intentionally disabled; real thermal motion provides animation; exists as scaffolding from the concrete port
- `bondCurDistAlpha(dx, dy)` — fades bond lenses when current atom separation exceeds 14px; fully zero at 25px; prevents smearing ghost lens shapes as bonds break; the 14–25px window is not a named constant
- `roundedHullPath(ctx, pts, inflate, cornerR)` — builds grain-outline path; inflates hull vertices outward from centroid by `inflate` px then draws rounded corners with `arcTo`; called with inflate=7, cornerR=6
- `convexHull(pts)` — Andrew's monotone chain; private to renderer.js (meltPhysics.js has its own separate copy)
- `fieldLayerCache`, `chunkLayerCache` — `WeakMap` offscreen canvas caches; reused across frames, recreated only on resize; this is why field and chunk outlines render efficiently with blur
- `GHOST_ZONE = 25` — atoms within 25px of an edge get ghost copies drawn at ±SIM_W or ±SIM_H; implements visual toroidal wrap
- `VISUAL_SCALE = 1` — lattice atoms drawn at `x0 + (x − x0) × visualScale`; at 1.0 this is just `x`; option to amplify thermal motion visually without changing physics, currently 1:1
- `CHARGE_POS`, `CHARGE_NEG`, `CHARGE_TYPES` — charge halo colors (blue for Si/Ca/Na, orange for O); toggled by the CHARGE button in the UI
- `COORD_TARGET = [3, 2, 1, 2]` — now exported from meltPhysics.js and imported here; single source of truth
- COLOR_STOPS in renderer.js (grey → violet → magenta → hot pink) was the only ramp after drawPhysics was removed from meltPhysics.js
- `drawScene` option `darkMode` — no UI toggle; hardcoded true at all call sites

---

### sandPhysics.js

Everything in sandPhysics.js is undocumented beyond the project-layout line. Key items:

- **PBD algorithm**: position-based dynamics, not force integration for collision solving. Velocity is derived from position displacement after constraint solve → settled grains naturally zero their velocity without explicit velocity zeroing.
- **Spatial grid**: typed-array linked-list grid; `CELL = GRAIN_R_MAX × 2 = 6.4px`; collision search uses ±1 cells, which fails for large merged blobs; the `LARGE_R` linear scan (for grains >4.8px) is the fallback.
- **Na micro-grains**: `NA_R = 1.5px`; `na2oPct` maps to count fraction via `min(0.70, (na2oPct/30) × 0.36)`. At na2oPct=30, ~36% of grains by count are Na — but only ~20% by volume (smaller radius).
- **Na blob system**: a complete soft-body system — phantom center + hex-packed sub-circles + radial and neighbor springs. `NA_BLOB_CONVERT_R = 5.0` is the size at which a merged Na grain converts to this system. Conversion rate-limited to one per frame by `convertLargeNaGrains`.
- **Blob merging dwell time**: `checkNaBlobMerges` requires `max(5, round(20/tempFactor))` consecutive contact frames before merging; at 1200°C this is 20 frames; at 700°C this is 400 frames. Prevents hot-collision merging.
- **Grain absorption**: `absorbNearbyGrains` checks proximity to sub-circles (not center); na/silicate absorb at `tempF × 0.008` probability per frame, sand at `tempF × 0.002`. Both gated on temp > 700°C.
- **Grain type chain**: `sand` → (Na+sand contact) → `silicate` → (if r ≥ 5.0) → `na-sub` in a blob. The `na` type can also merge directly into other `na` grains or be absorbed.
- **`window.sandStats()`** — CLAUDE.md mentions it exists but does not describe what it outputs (speed histogram).

---

### glassPhysics.js

Everything in glassPhysics.js is undocumented beyond the project-layout line. Key items:

- **Algorithm**: Clavet, Beaudoin & Poulin (2005) SPH with Algos 1–4 (viscosity, spring adjust, spring displace, double density). The spring length adjustment `adjustSprings` is the plasticity mechanism; `alpha` controls how fast springs adapt to deformation.
- **`tempParams(tempC)`**: geometric (log-linear) interpolation for sigma/alpha/kSpring because glass viscosity follows Arrhenius/VTF. Fluid params (sigma, alpha, kSpring) only begin easing above 590°C — the glass transition point. velDamp and rigidFrac use the full 25–1200°C cubic range. This asymmetry is undocumented.
- **Rigid body mode** (`T_RIGID = 200°C`): below this, SPH is abandoned entirely. `freezeParticles` computes CM and angular velocity (ω = Σr×Δv / Σ|r|²) and locks the shape. `stepRigidBody` uses proper 2D impulse mechanics: J = −(1+e)×v_normal / (1/M + r_CN²/I) applied at the average contact centroid per wall.
- **Floor mode** (`stepFloorPhysics`): different boundary conditions — gravity always down, floor at a given Y, canvas-edge side walls, no top wall, optional stick obstacle (line segment, zero restitution). Used when the box is dropped in the glass tab.
- **Overlap resolution after DDR**: `resolveOverlaps` runs after double density relaxation so pressure pushes don't create new overlaps that escape the wall clamp. Order matters.
- **Speed cap = 800 px/s**: hard-caps individual particle velocity post-wall-clamp; prevents high-temperature explosions.
- **`springKey(i, j)` encoding**: `i × N_PARTICLES + j`; if N_PARTICLES changes from 500, existing spring maps become invalid. Brittle coupling between the constant and the data structure.
