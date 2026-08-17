import { useState, useCallback } from 'react'
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
  const [tempC, setTempC]           = useState(20)
  const [simSpeed, setSimSpeed]     = useState(0.2)
  const [sioR0, setSioR0]           = useState(9)
  const [attractK, setAttractK]     = useState(0.02)
  const [showDev, setShowDev]       = useState(true)
  const [narrowTemp, setNarrowTemp] = useState(false)
  const [coolingMode, setCoolingMode] = useState(null) // null | 'slow' | 'fast'
  const [displayTemp, setDisplayTemp] = useState(tempC)
  const tempMax = narrowTemp ? 700 : 2000
  const p = PRESETS.find(x => x.id === presetId)

  const handleTempUpdate = useCallback(t => setDisplayTemp(t), [])

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
            <span className="toolbar-label">Temperature</span>
            <input
              type="range"
              className="temp-range"
              min={0} max={tempMax} step={narrowTemp ? 5 : 10}
              value={Math.min(tempC, tempMax)}
              onChange={e => { setCoolingMode(null); setTempC(Number(e.target.value)); setDisplayTemp(Number(e.target.value)) }}
            />
            <span className="temp-val">{Math.min(coolingMode ? displayTemp : tempC, tempMax)} °C</span>
            <button
              className={`cool-btn ${coolingMode === 'slow' ? 'active' : ''}`}
              onClick={() => setCoolingMode(m => m === 'slow' ? null : 'slow')}
            >Slow Cool</button>
            <button
              className={`cool-btn ${coolingMode === 'fast' ? 'active' : ''}`}
              onClick={() => setCoolingMode(m => m === 'fast' ? null : 'fast')}
            >Fast Cool</button>
            <button
              className={`range-toggle ${narrowTemp ? 'active' : ''}`}
              onClick={() => setNarrowTemp(n => !n)}
              title="Toggle temperature range"
            >0–{narrowTemp ? '2000' : '700'}°C</button>
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
        </div>
      )}

      <main className="micro-section">
        {tab === 'melt'
          ? <CompositionView
              key="melt"
              sio2Pct={p.sio2} na2oPct={p.na2o} caoPct={p.cao}
              sioR0={sioR0} attractK={attractK}
              tempC={tempC} simSpeed={simSpeed} coolingMode={coolingMode}
              onTempUpdate={handleTempUpdate}
            />
          : <NetworksView sio2Pct={p.sio2} na2oPct={p.na2o} caoPct={p.cao} />
        }
      </main>
    </div>
  )
}
