import { SECTIONS, formatChip, formatHandoff, type FieldKey, type Confidence, type OperatingMap } from "@/lib/schema";

interface Props {
  fields: OperatingMap;
  confidence: Confidence;
  elapsed: number;
  muted: boolean;
  level: number;
  speaker: "agent" | "person" | "idle";
  connecting: boolean;
  onToggleMute: () => void;
  onFinishEarly: () => void;
  warning?: string | null;
}

function formatClock(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function sectionComplete(fields: OperatingMap, keys: (keyof OperatingMap)[]) {
  return keys.every((k) => {
    const v = fields[k];
    if (v === undefined || v === null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (k === "scores") return Object.keys(v as object).length >= 6;
    return true;
  });
}

export function ConversationScreen({
  fields,
  confidence,
  elapsed,
  muted,
  level,
  speaker,
  connecting,
  onToggleMute,
  onFinishEarly,
  warning,
}: Props) {
  const done = SECTIONS.filter((s) => sectionComplete(fields, s.fields)).length;
  const progress = Math.round((done / SECTIONS.length) * 100);

  const ringColor =
    speaker === "agent" ? "var(--color-forest)" : speaker === "person" ? "var(--color-terracotta)" : "var(--color-cream-deep)";
  const scale = 1 + (speaker === "idle" ? 0.02 : level * 0.35);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-5 pt-3 pb-6">
      <div className="h-1 w-full rounded-full bg-cream-deep">
        <div
          className="h-1 rounded-full bg-terracotta transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="flex min-h-40 items-center justify-center py-8">
        <div
          className="flex h-32 w-32 items-center justify-center rounded-full transition-transform duration-75"
          style={{
            border: `3px solid ${ringColor}`,
            backgroundColor: speaker === "idle" ? "var(--color-cream-deep)" : "transparent",
            transform: `scale(${scale})`,
          }}
        >
          <span className="label-mono">
            {connecting ? "connecting" : speaker === "agent" ? "listening to me" : speaker === "person" ? "i hear you" : "go ahead"}
          </span>
        </div>
      </div>

      {warning ? (
        <p role="status" className="mb-3 rounded-lg border border-terracotta/40 bg-peach px-4 py-3 text-sm text-ink">
          {warning}
        </p>
      ) : null}

      <div className="flex-1 space-y-4 overflow-y-auto">
        {SECTIONS.map((section) => {
          const chips = section.fields
            .flatMap((key): { key: FieldKey; id: string; text: string | null }[] =>
              key === "handoffs"
                ? (fields.handoffs ?? []).map((h, i) => ({ key, id: `handoffs-${i}`, text: formatHandoff(h) }))
                : [{ key, id: key as string, text: formatChip(key, fields[key]) }],
            )
            .filter((c) => c.text);
          return (
            <div key={section.id}>
              <div className="label-mono">{section.label}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {chips.length === 0 ? (
                  <span className="text-sm text-muted-foreground">Not yet</span>
                ) : (
                  chips.map((chip) => (
                    <span
                      key={chip.id}
                      className={`rounded-full bg-cream-deep px-3 py-1 text-xs text-ink ${
                        confidence[chip.key] === "low"
                          ? "border border-dashed border-terracotta"
                          : "border border-border"
                      }`}
                    >
                      {chip.text}
                    </span>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onToggleMute}
          className="btn-base btn-outline flex-1 py-2.5 text-sm"
        >
          {muted ? "Unmute" : "Mute"}
        </button>
        <span className="font-mono text-sm text-muted-foreground">{formatClock(elapsed)}</span>
        <button
          type="button"
          onClick={onFinishEarly}
          className="btn-base btn-outline flex-1 py-2.5 text-sm"
        >
          Finish early
        </button>
      </div>
    </div>
  );
}
