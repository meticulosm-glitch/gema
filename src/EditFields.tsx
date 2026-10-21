import { isDateType, isNumericType, type FormField } from "./editForm";

/**
 * Campi del modulo di modifica: etichetta (alias), obbligatori, sola lettura, menu a tendina, aiuto ed errori.
 * I campi nascosti non si mostrano. Usato dall'editor e dall'anteprima nella pagina admin.
 */
export default function EditFields({
  fields, values, errors = {}, isNew, onChange,
}: {
  fields: FormField[]; values: Record<string, string>; errors?: Record<string, string>; isNew: boolean;
  onChange: (name: string, value: string) => void;
}) {
  return (
    <div className="ed-form">
      {fields.filter((f) => !f.hidden).map((f) => {
        const t = f.type.toLowerCase();
        const v = values[f.name] ?? "";
        const err = errors[f.name];
        const id = `ed-${f.name}`;
        const describedBy = [f.help ? `${id}-help` : "", err ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
        const common = {
          id, disabled: f.readonly, "aria-labelledby": `${id}-label`, "aria-invalid": err ? true : undefined, "aria-required": f.required || undefined, "aria-describedby": describedBy,
        } as const;
        const options = f.options
          ? [...f.options, ...(v && !f.options.some((o) => o.value === v) ? [{ value: v, label: `${v} (valore attuale)` }] : [])]
          : t === "boolean" ? [{ value: "true", label: "sì" }, { value: "false", label: "no" }] : null;
        return (
          <label key={f.name} className={`ed-field${f.required ? " req" : ""}${err ? " has-err" : ""}`} data-field={f.name} htmlFor={id}>
            <span id={`${id}-label`} title={f.label === f.name ? `${f.name} (${f.type})` : `${f.label} — colonna ${f.name} (${f.type})`}>{f.label}</span>
            {options ? (
              <select {...common} value={v} onChange={(e) => onChange(f.name, e.target.value)}>
                {(!f.required || !v) && <option value="">{f.required ? "— scegli —" : ""}</option>}
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input
                {...common}
                className="search"
                type={isNumericType(t) ? "number" : "text"}
                step={isNumericType(t) ? "any" : undefined}
                placeholder={isDateType(t) ? "AAAA-MM-GG" + (t === "datetime" ? "THH:MM:SSZ" : "") : ""}
                value={v}
                onChange={(e) => onChange(f.name, e.target.value)}
              />
            )}
            {f.readonly && <small className="ed-note">{isNew && f.default ? `valore predefinito` : "sola lettura"}</small>}
            {f.help && <small className="ed-note" id={`${id}-help`}>{f.help}</small>}
            {err && <small className="ed-err" id={`${id}-err`} role="alert">{err}</small>}
          </label>
        );
      })}
    </div>
  );
}
