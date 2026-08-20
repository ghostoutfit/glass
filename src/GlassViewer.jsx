import { useState, useCallback, useEffect, useRef } from 'react'
import CompositionView from './CompositionView'
import NetworksView from './NetworksView'
import './GlassViewer.css'

const PRESETS = [
  { id: 'pure',     label: 'Pure SiO₂',         sio2: 100, na2o: 0,  cao: 0  },
  { id: 'soda',     label: 'High Na₂O',          sio2: 70,  na2o: 30, cao: 0  },
  { id: 'sodalime', label: 'Soda-lime glass',    sio2: 70,  na2o: 15, cao: 15 },
  { id: 'excess',   label: 'Too many additives', sio2: 50,  na2o: 25, cao: 25 },
]

export default function GlassViewer() {
  const [tab, setTab]               = useState('melt')
  const [presetId, setPresetId]     = useState('pure')
  const [energyVal, setEnergyVal]   = useState(20)      // slider value 0-2000 (energy target)
  const [derivedTemp, setDerivedTemp] = useState(20)    // temperature computed from KE
  const [displayEnergy, setDisplayEnergy] = useState(20) // shown during ramps
  const [simSpeed, setSimSpeed]     = useState(0.5)
  const [sioR0, setSioR0]           = useState(9)
  const [attractK, setAttractK]     = useState(0.02)
  const [showDev, setShowDev]       = useState(true)
  const [showGraphs, setShowGraphs] = useState(false)
  const [narrowTemp, setNarrowTemp] = useState(false)
  const [coolingMode, setCoolingMode] = useState(null)
  const [precompute, setPrecompute]       = useState(true)
  const [bondNums, setBondNums]           = useState(false)
  const [replayFrameCount, setReplayFrameCount] = useState(0)
  const [replayFrame, setReplayFrame]     = useState(null)
  const [replayPlaying, setReplayPlaying] = useState(false)
  const replayRafRef = useRef(null)

  const handleReplayReady = useCallback(count => {
    setReplayFrameCount(count)
    setReplayFrame(null)
    setReplayPlaying(false)
  }, [])

  // Receives slider-equivalent energy value from ramp (to sync slider position)
  const handleTempUpdate = useCallback(val => { setDisplayEnergy(val) }, [])
  // Receives KE, PE, derived temperature from each physics frame
  const handleEnergyUpdate = useCallback((_ke, _pe, derivedT) => {
    setDerivedTemp(derivedT)
  }, [])

  // Auto-advance replay frames
  useEffect(() => {
    if (!replayPlaying) { cancelAnimationFrame(replayRafRef.current); return }
    let last = null
    const tick = ts => {
      if (last !== null && ts - last < 16) { replayRafRef.current = requestAnimationFrame(tick); return }
      last = ts
      setReplayFrame(f => {
        const next = (f ?? 0) + 1
        if (next >= replayFrameCount) { setReplayPlaying(false); return replayFrameCount - 1 }
        return next
      })
      replayRafRef.current = requestAnimationFrame(tick)
    }
    replayRafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(replayRafRef.current)
  }, [replayPlaying, replayFrameCount])

  const startCooling = useCallback(mode => {
    setReplayFrameCount(0)
    setReplayFrame(null)
    setReplayPlaying(false)
    setCoolingMode(m => m === mode ? null : mode)
  }, [])
  const energyMax = narrowTemp ? 700 : 2000
  const p = PRESETS.find(x => x.id === presetId)

  const switchPreset = id => { setCoolingMode(null); setPresetId(id) }

  return (
    <div className="viewer">
      <header className="top-bar">
        <div className="toolbar">

          {/* ── Tab switcher ── */}
          <button
            className={`tab-btn ${tab === 'melt' ? 'active' : ''}`}
            onClick={() => setTab('melt')}
          >Melt</button>
          <button
            className={`tab-btn ${tab === 'networks' ? 'active' : ''}`}
            onClick={() => setTab('networks')}
          >Networks</button>

          <div className="toolbar-divider" />

          {/* ── Preset buttons (shared across tabs) ── */}
          {PRESETS.map(preset => (
            <button key={preset.id}
              className={`preset-btn ${presetId === preset.id ? 'active' : ''}`}
              onClick={() => switchPreset(preset.id)}
            >{preset.label}</button>
          ))}

          {/* ── Melt-only controls ── */}
          {tab === 'melt' && <>
            <div className="toolbar-divider" />
            <span className="toolbar-label">Energy</span>
            <input
              type="range"
              className="temp-range"
              min={0} max={energyMax} step={narrowTemp ? 5 : 10}
              value={Math.min(coolingMode ? displayEnergy : energyVal, energyMax)}
              onChange={e => { setCoolingMode(null); setEnergyVal(Number(e.target.value)); setDisplayEnergy(Number(e.target.value)) }}
            />
            <span className="temp-val">{Math.min(coolingMode ? displayEnergy : energyVal, energyMax)}</span>
            <span className="toolbar-label" style={{ marginLeft: 6 }}>T:</span>
            <span className="temp-val">{derivedTemp}°C</span>
            <button
              className={`heat-btn ${coolingMode === 'slowHeat' ? 'active' : ''}`}
              onClick={() => startCooling('slowHeat')}
            >Slow Heat</button>
            <button
              className={`heat-btn ${coolingMode === 'fastHeat' ? 'active' : ''}`}
              onClick={() => startCooling('fastHeat')}
            >Fast Heat</button>
            <button
              className={`cool-btn ${coolingMode === 'slow' ? 'active' : ''}`}
              onClick={() => startCooling('slow')}
            >Slow Cool</button>
            <button
              className={`cool-btn ${coolingMode === 'fast' ? 'active' : ''}`}
              onClick={() => startCooling('fast')}
            >Fast Cool</button>
            <button
              className={`range-toggle ${narrowTemp ? 'active' : ''}`}
              onClick={() => setNarrowTemp(n => !n)}
              title="Toggle energy range"
            >0–{narrowTemp ? '2000' : '700'}</button>
            <div className="toolbar-divider" />
            <span className="speed-label">🐢</span>
            <input
              type="range"
              className="speed-range"
              min={0.05} max={0.5} step={0.025}
              value={simSpeed}
              onChange={e => setSimSpeed(Number(e.target.value))}
            />
            <span className="speed-label">🐇</span>
            <div className="toolbar-divider" />
            <label className="dev-toggle">
              <input type="checkbox" checked={showDev} onChange={e => setShowDev(e.target.checked)} />
              dev
            </label>
          </>}

          <span className="composition-tag">
            SiO₂ {p.sio2}% · Na₂O {p.na2o}% · CaO {p.cao}%
          </span>
        </div>
      </header>

      {tab === 'melt' && replayFrameCount > 0 && (
        <div className="replay-bar">
          <button
            className={`replay-btn ${replayPlaying ? 'active' : ''}`}
            onClick={() => {
              if (replayFrame === null) setReplayFrame(0)
              setReplayPlaying(p => !p)
            }}
          >{replayPlaying ? '■ Stop' : '▶ Replay'}</button>
          <input
            type="range"
            className="replay-range"
            min={0} max={replayFrameCount - 1}
            value={replayFrame ?? 0}
            onChange={e => { setReplayPlaying(false); setReplayFrame(Number(e.target.value)) }}
          />
          <span className="replay-time">
            {replayFrame ?? 0} / {replayFrameCount - 1}
          </span>
          <button className="replay-btn" onClick={() => setReplayFrame(null)}>Live</button>
        </div>
      )}

      {tab === 'melt' && showDev && (
        <div className="dev-bar">
          <span className="toolbar-label">Si-O r₀</span>
          <input
            type="range"
            className="r0-range"
            min={5} max={15} step={0.5}
            value={sioR0}
            onChange={e => setSioR0(Number(e.target.value))}
          />
          <span className="r0-val">{sioR0} px</span>
          <div className="toolbar-divider" />
          <span className="toolbar-label">Cooling Attract</span>
          <input
            type="range"
            className="r0-range"
            min={0} max={0.02} step={0.0005}
            value={attractK}
            onChange={e => setAttractK(Number(e.target.value))}
          />
          <span className="r0-val">{attractK === 0 ? 'off' : attractK.toFixed(4)}</span>
          <div className="toolbar-divider" />
          <label className="dev-toggle">
            <input type="checkbox" checked={precompute} onChange={e => setPrecompute(e.target.checked)} />
            Pre-Compute
          </label>
          <div className="toolbar-divider" />
          <label className="dev-toggle">
            <input type="checkbox" checked={bondNums} onChange={e => setBondNums(e.target.checked)} />
            Bond #s
          </label>
          <div className="toolbar-divider" />
          <label className="dev-toggle">
            <input type="checkbox" checked={showGraphs} onChange={e => setShowGraphs(e.target.checked)} />
            Graphs
          </label>
        </div>
      )}

      <main className="micro-section">
        {tab === 'melt'
          ? <CompositionView
              key="melt"
              sio2Pct={p.sio2} na2oPct={p.na2o} caoPct={p.cao}
              sioR0={sioR0} attractK={attractK} debug={showDev}
              bondNums={bondNums} precompute={precompute}
              energyVal={energyVal} simSpeed={simSpeed} coolingMode={coolingMode}
              onTempUpdate={handleTempUpdate}
              onEnergyUpdate={handleEnergyUpdate}
              showGraphs={showGraphs}
              replayFrame={replayFrame} onReplayReady={handleReplayReady}
            />
          : <NetworksView sio2Pct={p.sio2} na2oPct={p.na2o} caoPct={p.cao} />
        }
      </main>
    </div>
  )
}
