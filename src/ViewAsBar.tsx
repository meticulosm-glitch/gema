/** Barra fissa mentre l'amministratore usa l'app come un altro ruolo: dice cosa sta guardando e come uscirne. */
export default function ViewAsBar({ role, roles, onChange, onExit }: { role: string; roles: string[]; onChange: (r: string) => void; onExit: () => void }) {
  return (
    <div className="viewas-bar" role="region" aria-label="Visualizza come ruolo">
      <span className="viewas-icon" aria-hidden="true">👁</span>
      <div className="viewas-text">
        <strong>Stai vedendo l'applicazione come {role}</strong>
        <span>Mappa, strumenti, dashboard, avvisi e vista iniziale sono quelli del ruolo. I dati arrivano con le tue credenziali (quello che il ruolo legge davvero lo decide GeoServer) e le modifiche che salvi sono reali, a tuo nome.</span>
      </div>
      <label className="viewas-pick"><span>Ruolo</span>
        <select aria-label="Cambia ruolo" value={role} onChange={(e) => onChange(e.target.value)}>
          {(roles.includes(role) ? roles : [role, ...roles]).map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      <button className="btn-sm" onClick={onExit}>Torna amministratore</button>
    </div>
  );
}
