import {
  AI_USAGE_LABELS,
  CHANNELS,
  FIELD_LABELS,
  FUNCTIONS,
  REKEY_HOURS,
  SCORE_KEYS,
  SCORE_POLES,
  SCORE_VALUES,
  SECTIONS,
  SENIORITIES,
  TENURE_BANDS,
  TOOL_CATALOG,
  WORK_MODES,
  enumFor,
  type Confidence,
  type FieldKey,
  type OperatingMap,
  type Quotes,
} from "@/lib/schema";

interface Props {
  fields: OperatingMap;
  confidence: Confidence;
  quotes: Quotes;
  edited: string[];
  banner?: string | null;
  saving: boolean;
  onChange: (key: FieldKey, value: unknown) => void;
  onSave: () => void;
  onDownload: () => void;
}

function isEmpty(key: FieldKey, value: unknown) {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (key === "scores")
    return SCORE_KEYS.some((d) => typeof (value as Record<string, unknown>)[d] !== "number");
  return false;
}

function FieldShell({
  label,
  flagged,
  children,
}: {
  label: string;
  flagged: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg p-3 ${flagged ? "bg-peach ring-1 ring-terracotta/40" : "bg-transparent"}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="label-mono">{label}</span>
        {flagged ? <span className="label-mono text-terracotta">check this</span> : null}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

const inputClass =
  "w-full rounded-lg border border-border bg-cream px-3 py-2.5 text-sm text-ink outline-none focus:ring-2 focus:ring-forest";

export function ReviewScreen({
  fields,
  confidence,
  quotes,
  edited,
  banner,
  saving,
  onChange,
  onSave,
  onDownload,
}: Props) {
  const flagged = (key: FieldKey) => confidence[key] === "low" || isEmpty(key, fields[key]);

  const renderEnum = (key: FieldKey, options: readonly string[]) => (
    <select
      value={(fields[key] as string) ?? ""}
      onChange={(e) => onChange(key, e.target.value || undefined)}
      className={inputClass}
    >
      <option value="">Not captured</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );

  const renderText = (key: FieldKey, placeholder = "") => (
    <input
      value={(fields[key] as string) ?? ""}
      placeholder={placeholder}
      onChange={(e) => onChange(key, e.target.value)}
      className={inputClass}
    />
  );

  const renderField = (key: FieldKey) => {
    const label = FIELD_LABELS[key];
    const options = enumFor(key);

    if (options) {
      return (
        <FieldShell key={key} label={label} flagged={flagged(key)}>
          {renderEnum(key, options)}
        </FieldShell>
      );
    }

    if (key === "tools") {
      const selected = (fields.tools ?? []) as string[];
      const extras = selected.filter((t) => !(TOOL_CATALOG as readonly string[]).includes(t));
      return (
        <FieldShell key={key} label={label} flagged={flagged(key)}>
          <div className="flex flex-wrap gap-2">
            {[...TOOL_CATALOG, ...extras].map((tool) => {
              const on = selected.includes(tool);
              return (
                <button
                  key={tool}
                  type="button"
                  onClick={() =>
                    onChange(
                      "tools",
                      on ? selected.filter((t) => t !== tool) : [...selected, tool],
                    )
                  }
                  className={`rounded-full border px-3 py-1 text-xs ${
                    on
                      ? "border-forest bg-forest text-primary-foreground"
                      : "border-border bg-cream text-ink"
                  }`}
                >
                  {tool}
                </button>
              );
            })}
          </div>
        </FieldShell>
      );
    }

    if (key === "rekey_pair") {
      const pair = (fields.rekey_pair ?? [undefined, undefined]) as (string | undefined)[];
      const setAt = (i: number, v: string) => {
        const next = [pair[0] ?? "", pair[1] ?? ""];
        next[i] = v;
        onChange("rekey_pair", next[0] && next[1] ? (next as [string, string]) : null);
      };
      const choices = [...new Set([...(fields.tools ?? []), ...TOOL_CATALOG])];
      return (
        <FieldShell key={key} label={label} flagged={flagged(key)}>
          <div className="flex gap-2">
            {[0, 1].map((i) => (
              <select
                key={i}
                value={pair[i] ?? ""}
                onChange={(e) => setAt(i, e.target.value)}
                className={inputClass}
              >
                <option value="">Not captured</option>
                {choices.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            ))}
          </div>
        </FieldShell>
      );
    }

    if (key === "scores") {
      const scores = fields.scores ?? {};
      return (
        <FieldShell key={key} label={label} flagged={flagged(key)}>
          <div className="space-y-4">
            {SCORE_KEYS.map((sk) => (
              <div key={sk}>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{SCORE_POLES[sk].low}</span>
                  <span>{SCORE_POLES[sk].high}</span>
                </div>
                <div className="mt-1 flex gap-1">
                  {SCORE_VALUES.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => onChange("scores", { ...scores, [sk]: v })}
                      className={`flex-1 rounded-md border py-1.5 text-xs ${
                        scores[sk] === v
                          ? "border-forest bg-forest text-primary-foreground"
                          : "border-border bg-cream text-ink"
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </FieldShell>
      );
    }

    if (key === "ai_usage_level") {
      return (
        <FieldShell key={key} label={label} flagged={flagged(key)}>
          <select
            value={fields.ai_usage_level ?? ""}
            onChange={(e) =>
              onChange("ai_usage_level", e.target.value === "" ? undefined : Number(e.target.value))
            }
            className={inputClass}
          >
            <option value="">Not captured</option>
            {AI_USAGE_LABELS.map((l, i) => (
              <option key={l} value={i}>
                {i} {l.toLowerCase()}
              </option>
            ))}
          </select>
        </FieldShell>
      );
    }

    return (
      <FieldShell key={key} label={label} flagged={flagged(key)}>
        {renderText(key, key === "hours_window" ? "8am to 6pm ET" : "")}
      </FieldShell>
    );
  };

  const quoteEntries = Object.entries(quotes).filter(([, v]) => v);

  return (
    <div className="mx-auto w-full max-w-md px-5 py-8">
      <div className="label-mono">review</div>
      <h1 className="mt-2 text-3xl leading-tight text-ink">Check your operating map</h1>

      {banner ? (
        <p className="mt-4 rounded-lg border border-terracotta/40 bg-peach px-4 py-3 text-sm text-ink">
          {banner}
        </p>
      ) : null}

      <div className="mt-6">
        <FieldShell label={FIELD_LABELS.first_name} flagged={flagged("first_name")}>
          {renderText("first_name")}
        </FieldShell>
      </div>

      {SECTIONS.map((section) => (
        <section key={section.id} className="mt-6">
          <h2 className="text-lg text-ink">{section.label}</h2>
          <div className="mt-2 space-y-1">{section.fields.map(renderField)}</div>
        </section>
      ))}

      <section className="surface mt-8 p-4">
        <div className="label-mono">In their words</div>
        {quoteEntries.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No quotes captured.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {quoteEntries.map(([key, quote]) => (
              <li key={key} className="text-sm text-ink">
                <span className="label-mono">{FIELD_LABELS[key as FieldKey] ?? key}</span>
                <div>“{quote}”</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-4 text-xs text-muted-foreground">
        {edited.length} {edited.length === 1 ? "field" : "fields"} edited so far.
      </p>

      <div className="mt-4 flex gap-3 pb-8">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="btn-base btn-primary flex-1 disabled:opacity-50"
        >
          {saving ? "Saving" : "Save"}
        </button>
        <button type="button" onClick={onDownload} className="btn-base btn-outline flex-1">
          Download JSON
        </button>
      </div>
    </div>
  );
}

export const REVIEW_ENUMS = {
  FUNCTIONS,
  SENIORITIES,
  TENURE_BANDS,
  WORK_MODES,
  REKEY_HOURS,
  CHANNELS,
};
