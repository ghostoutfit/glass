// Canonical glass-process landmark temperatures (°C) — the SINGLE source of truth shared by the
// particle melt (meltPhysics), the energy graph (CompositionView), and the Bulk merge animation
// (sandPhysics / GlassViewer). Before this, each subsystem carried its own numbers for the same
// physical events, so the blob-merge viz and the graph slopes didn't line up with the particle
// melt. These values are the particle tab's tuned numbers (the most-elaborated subsystem); the
// graph and Bulk derive from them. Not pure physics — a chosen, consistent model.
//
// Dialing these retunes all three views together, which is the point. Per-subsystem window
// overrides (_crystLockTemp, _macroMeltOnset/_macroMeltFull, _coolLatent*) still exist for live
// tuning; they default to the values here.
export const T = {
  MELT_ONSET: 700,   // heating: grains start merging / modifier bonds start breaking
  MELT_FULL:  1300,  // heating: fully liquid  (= Si–O projection cutoff for modified glass)
  CRYST_LOCK: 1050,  // cooling: bonds lock / crystallize  (= particle CRYST_LOCK; graph cool-shelf top)
  LATENT_LO:  500,   // cooling: latent-heat release complete, solid  (graph cool-shelf bottom)
}
