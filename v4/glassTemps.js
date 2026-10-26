// Canonical glass-process landmark temperatures (°C) — the SINGLE source of truth shared by the
// particle melt (meltPhysics), the energy graph (CompositionView), and the Bulk merge animation
// (sandPhysics / GlassViewer). Before this, each subsystem carried its own numbers for the same
// physical events, so the blob-merge viz and the graph slopes didn't line up with the particle
// melt. These values are the particle tab's tuned numbers (the most-elaborated subsystem); the
// graph and Bulk derive from them. Not pure physics — a chosen, consistent model.
//
// Dialing these retunes all three views together, which is the point. Per-subsystem window
// overrides (_crystLockTemp, _coolLatent*) still exist for live
// tuning; they default to the values here.
export const T = {
  MELT_ONSET: 700,   // heating: grains start merging / modifier bonds start breaking
  MELT_FULL:  1300,  // heating: fully liquid  (= Si–O projection cutoff for modified glass)
  CRYST_LOCK: 1050,  // cooling: bonds lock / crystallize  (= particle CRYST_LOCK; graph cool-shelf top)
  LATENT_LO:  500,   // cooling: latent-heat release complete, solid  (graph cool-shelf bottom)
}

// ── Cooling band: ONE schedule for "the melt turns into cold glass" in both tabs ──────────────
// Particles: each bond fades pink → grey over `w` °C at its own random temperature inside [lo, hi]
// (renderer, per-bond slot). Bulk: the hot-blob → clear-glass crossfade follows the SAME
// population — glass amount = share of particle bonds that have gone grey (coolGreyFrac). So
// moving the band moves both views together. Dev panel → "Tune these".
export const COOL_BAND = { hi: 1000, lo: 500, w: 150 }
export const setCoolBand = ({ hi = COOL_BAND.hi, lo = COOL_BAND.lo, w = COOL_BAND.w }) => { COOL_BAND.hi = hi; COOL_BAND.lo = lo; COOL_BAND.w = w }
// One bond's remaining pink (1 = fully pink, 0 = grey) at temperature T, for its slot u ∈ [0,1).
export function coolBondPink(T, u) {
  const w = Math.max(1, COOL_BAND.w), span = Math.max(0, COOL_BAND.hi - COOL_BAND.lo - w)
  const t0 = COOL_BAND.lo + u * span                       // this bond fades over t0 → t0 + w
  const x = Math.max(0, Math.min(1, (T - t0) / w))
  return x * x * (3 - 2 * x)
}
// Share of all bonds that have gone grey at T (slots are uniform → average over evenly spaced u).
export function coolGreyFrac(T) {
  let s = 0
  for (let k = 0; k < 64; k++) s += coolBondPink(T, (k + 0.5) / 64)
  return 1 - s / 64
}
