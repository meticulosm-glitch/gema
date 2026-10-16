import { useEffect, useRef, useState } from "react";
import { shortTime, stepIndex } from "./timeline";

const SPEEDS: { ms: number; label: string }[] = [
  { ms: 2000, label: "0,5×" },
  { ms: 1000, label: "1×" },
  { ms: 500, label: "2×" },
  { ms: 250, label: "4×" },
];

/** Slider cronologico con play sugli istanti di un layer con dimensione TIME. */
export default function TimeSlider({
  steps, value, defaultValue, onChange,
}: {
  steps: string[];
  value: string;        // "" = data predefinita del layer
  defaultValue?: string;
  onChange: (t: string) => void;
}) {
  const current = Math.max(0, stepIndex(steps, value, defaultValue));
  const [pos, setPos] = useState(current);     // posizione mostrata (anche mentre si trascina)
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const posRef = useRef(pos); posRef.current = pos;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;

  // la data cambia dall'esterno (menu, link, ripristino): lo slider la segue
  useEffect(() => setPos(current), [current]);

  const commit = (i: number) => {
    setPos(i);
    onChangeRef.current(steps[i]);
  };

  // durante il trascinamento si aggiorna l'etichetta subito, ma i tile si ricaricano solo a trascinamento fermo
  const drag = (i: number) => {
    setPos(i);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChangeRef.current(steps[i]), 180);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // riproduzione: avanza di un istante a ogni scatto e ricomincia dall'inizio alla fine
  useEffect(() => {
    if (!playing || steps.length < 2) return;
    const id = setInterval(() => {
      const next = posRef.current + 1 >= steps.length ? 0 : posRef.current + 1;
      commit(next);
    }, SPEEDS[speed].ms);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, steps]);

  if (steps.length < 2) return null;
  const label = shortTime(steps[Math.min(pos, steps.length - 1)]);

  return (
    <div className="timeslider" role="group" aria-label="Slider temporale">
      <div className="ts-row">
        <button className="btn-sm" title={playing ? "Pausa" : "Riproduci"} aria-label={playing ? "Pausa" : "Riproduci"} onClick={() => setPlaying((p) => !p)}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button className="btn-sm" title="Istante precedente" aria-label="Istante precedente" disabled={pos <= 0} onClick={() => { setPlaying(false); commit(pos - 1); }}>‹</button>
        <input
          type="range"
          min={0}
          max={steps.length - 1}
          step={1}
          value={pos}
          aria-label="Data"
          aria-valuetext={label}
          onChange={(e) => { setPlaying(false); drag(Number(e.target.value)); }}
        />
        <button className="btn-sm" title="Istante successivo" aria-label="Istante successivo" disabled={pos >= steps.length - 1} onClick={() => { setPlaying(false); commit(pos + 1); }}>›</button>
        <select value={speed} aria-label="Velocità" title="Velocità di riproduzione" onChange={(e) => setSpeed(Number(e.target.value))}>
          {SPEEDS.map((s, i) => <option key={s.ms} value={i}>{s.label}</option>)}
        </select>
      </div>
      <div className="ts-label"><span className="muted">{shortTime(steps[0])}</span><strong>{label}</strong><span className="muted">{shortTime(steps[steps.length - 1])}</span></div>
    </div>
  );
}
