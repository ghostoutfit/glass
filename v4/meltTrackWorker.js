// Web Worker: generates the Particles-tab catch-up states in the background and answers catch-up
// requests (see meltTrack.js). Messages in:
//   { type: 'init', id, comp: {sio2,na2o,cao,sioR0}, P }   — (re)build + generate for a composition
//   { type: 'catchup', id, reqId, req }                      — req = { kind, T, frozen? }
// Messages out: { type: 'progress', id, stage, T } · { type: 'ready', id } · { type: 'state', id, reqId, result }
globalThis.window = globalThis.window ?? {}   // physics modules read optional window.* tuning knobs
let M = null, G = null, genId = 0
const pending = []

async function load() { if (!M) M = await import('./meltTrack.js'); return M }

function serve() {
  for (let k = pending.length - 1; k >= 0; k--) {
    const q = pending[k]
    if (q.id !== genId) { pending.splice(k, 1); continue }
    if (!G || !M.trackCovers(G, q.req)) continue
    pending.splice(k, 1)
    // runCatchup borrows the generator's phys — put the generator back where it was afterwards
    const resume = G.done ? null : M.snapshotFull(G.phys)
    const result = M.runCatchup(G, q.req)
    if (resume) M.restoreFull(G.phys, resume)
    self.postMessage({ type: 'state', id: q.id, reqId: q.reqId, result })
  }
}

function tick(id) {
  if (id !== genId || !G || G.done) return
  M.stepTrackGen(G, 10)
  self.postMessage({ type: G.done ? 'ready' : 'progress', id, stage: G.stage, T: Math.round(G.st.T) })
  serve()
  if (!G.done) setTimeout(() => tick(id), 0)
}

self.onmessage = async e => {
  const m = e.data
  await load()
  if (m.type === 'init') {
    genId = m.id
    G = M.makeTrackGen(m.comp, m.P)
    setTimeout(() => tick(m.id), 0)
  } else if (m.type === 'catchup') {
    pending.push(m)
    serve()
  }
}
