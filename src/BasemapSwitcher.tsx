import type { BasemapDef } from "./basemaps";

/** Scelta dello sfondo: sulla mappa, in basso a sinistra. */
export default function BasemapSwitcher({ list, value, onChange }: { list: BasemapDef[]; value: string; onChange: (id: string) => void }) {
  if (list.length < 2) return null;
  return (
    <div className="basemap-switch" role="radiogroup" aria-label="Sfondo della mappa">
      {list.map((b) => (
        <button key={b.id} role="radio" aria-checked={b.id === value} className={b.id === value ? "on" : ""} title={b.attribution ?? b.label} onClick={() => onChange(b.id)}>
          {b.label}
        </button>
      ))}
    </div>
  );
}
