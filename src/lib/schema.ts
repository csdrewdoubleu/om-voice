export const FUNCTIONS = [
  "Leadership",
  "Operations",
  "Sales",
  "Marketing",
  "Product & Engineering",
  "Finance & Admin",
  "Client service",
  "Other",
] as const;

export const SENIORITIES = [
  "Founder or partner",
  "Lead or manager",
  "Individual contributor",
] as const;

export const TENURE_BANDS = ["Under 1 year", "1-3 years", "3-7 years", "7+ years"] as const;

export const WORK_MODES = ["Onsite", "Hybrid", "Remote"] as const;

export const TOOL_CATALOG = [
  "Gmail",
  "Outlook",
  "Slack",
  "Microsoft Teams",
  "Google Docs",
  "Microsoft 365",
  "Notion",
  "Asana",
  "Trello",
  "Monday",
  "ClickUp",
  "Jira",
  "Linear",
  "HubSpot",
  "Salesforce",
  "Pipedrive",
  "QuickBooks",
  "Xero",
  "Stripe",
  "Calendly",
  "Google Calendar",
  "Google Drive",
  "Dropbox",
  "Box",
  "SharePoint",
  "Google Sheets",
  "Google Ads",
  "Microsoft Excel",
  "Zoom",
  "Google Meet",
  "Airtable",
  "Canva",
  "Meta Ads",
] as const;

export const TOOL_ALIASES: Record<string, string> = {
  sheets: "Google Sheets",
  "google sheet": "Google Sheets",
  excel: "Microsoft Excel",
  meet: "Google Meet",
  teams: "Microsoft Teams",
  "facebook ads": "Meta Ads",
  "instagram ads": "Meta Ads",
  "adwords": "Google Ads",
  docs: "Google Docs",
  drive: "Google Drive",
  "monday.com": "Monday",
  quickbooks: "QuickBooks",
};

export const REKEY_HOURS = ["0", "1-2", "3-5", "6-10", "10+"] as const;

export const CHANNELS = [
  "Email",
  "Slack or Teams",
  "Text message",
  "Phone call",
  "In person",
] as const;

export const SCORE_VALUES = [0, 25, 50, 75, 100] as const;

export const SCORE_KEYS = [
  "async",
  "collaborative",
  "improviser",
  "deliberate",
  "interrupt_averse",
  "process_skipper",
] as const;

export type ScoreKey = (typeof SCORE_KEYS)[number];

export const SCORE_POLES: Record<ScoreKey, { label: string; low: string; high: string }> = {
  async: {
    label: "Async",
    low: "I'd rather hop on a call",
    high: "Send it to me in writing",
  },
  collaborative: {
    label: "Collaborative",
    low: "I do my best work alone",
    high: "I do my best work with people around",
  },
  improviser: {
    label: "Improviser",
    low: "I plan the week on Monday",
    high: "I figure it out as it comes",
  },
  deliberate: {
    label: "Deliberate",
    low: "I decide fast and adjust",
    high: "I decide once I've seen everything",
  },
  interrupt_averse: {
    label: "Interrupt averse",
    low: "Interrupt me any time",
    high: "Protect my focus, batch it up",
  },
  process_skipper: {
    label: "Process skipper",
    low: "I build the checklist",
    high: "I skip the checklist",
  },
};

export const AI_USAGE_LABELS = [
  "Never",
  "Tried it",
  "Sometimes",
  "Weekly for real work",
  "Daily for real work",
];

export type Scores = Partial<Record<ScoreKey, number>>;

export const HANDOFF_DIRECTIONS = ["waits_on", "waited_on_by"] as const;
export const HANDOFF_KINDS = ["person", "function", "external"] as const;
export interface Handoff {
  direction: (typeof HANDOFF_DIRECTIONS)[number];
  target_kind: (typeof HANDOFF_KINDS)[number];
  target: string;
  what: string | null;
}

const FUNCTION_ALIASES: Record<string, string> = {
  "product team": "Product & Engineering", product: "Product & Engineering",
  engineering: "Product & Engineering", engineers: "Product & Engineering", dev: "Product & Engineering",
  developers: "Product & Engineering", "the partners": "Leadership", partners: "Leadership",
  founders: "Leadership", leadership: "Leadership", management: "Leadership", execs: "Leadership",
  accounting: "Finance & Admin", finance: "Finance & Admin", admin: "Finance & Admin",
  bookkeeping: "Finance & Admin", "the front desk": "Operations", "front desk": "Operations",
  ops: "Operations", operations: "Operations", sales: "Sales", "sales team": "Sales",
  marketing: "Marketing", "marketing team": "Marketing", support: "Client service",
  "customer service": "Client service", "client service": "Client service", "account managers": "Client service",
};

/** Maps a department description to a function value, or null. */
export function mapFunction(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/^the /, "").replace(/ (team|department|dept|folks|people)$/, "");
  const exact = FUNCTIONS.find((f) => f.toLowerCase() === raw.trim().toLowerCase());
  if (exact) return exact;
  return FUNCTION_ALIASES[t] ?? FUNCTION_ALIASES[raw.trim().toLowerCase()] ?? FUNCTION_ALIASES[`the ${t}`] ?? null;
}

/** Normalises function targets before validation. */
export function normaliseHandoffs(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((h) => {
    if (!h || typeof h !== "object") return h;
    const e = { ...(h as Record<string, unknown>) } as { target?: unknown; target_kind?: unknown; what?: unknown };
    if (typeof e.target === "string") e.target = e.target.trim();
    if (e.target_kind === "function" && typeof e.target === "string")
      e.target = mapFunction(e.target) ?? e.target;
    if (typeof e.what === "string") e.what = e.what.trim() || null;
    if (e.what === undefined) e.what = null;
    return e;
  });
}

export function handoffReason(value: unknown): string | null {
  if (!Array.isArray(value)) return "handoffs must be an array";
  if (value.length > 6) return "at most six hand-offs";
  for (const h of value as { direction?: unknown; target_kind?: unknown; target?: unknown; what?: unknown }[]) {
    if (!h || typeof h !== "object") return "each hand-off must be an object";
    if (!(HANDOFF_DIRECTIONS as readonly unknown[]).includes(h.direction)) return "direction must be waits_on or waited_on_by";
    if (!(HANDOFF_KINDS as readonly unknown[]).includes(h.target_kind)) return "target_kind must be person, function or external";
    if (typeof h.target !== "string" || !h.target.trim()) return "target is required";
    if (h.target_kind === "function" && !(FUNCTIONS as readonly string[]).includes(h.target))
      return `"${h.target}" is not a function value; use one of ${FUNCTIONS.join(", ")}`;
    if (h.target_kind === "person" && !/^[\p{L}][\p{L}'-]*$/u.test(h.target))
      return "a person target must be a single first name";
    if (h.target_kind === "external" && (h.target.length > 40 || h.target.split(/\s+/).length > 5))
      return "an external target must be a short label, not a sentence";
    if (h.what !== null && (typeof h.what !== "string" || h.what.length >= 80))
      return "what must be a short phrase under 80 characters, or null";
  }
  return null;
}

export function formatHandoff(h: Handoff): string {
  const what = h.what ? `: ${h.what}` : "";
  return h.direction === "waits_on" ? `waits on ${h.target}${what}` : `${h.target} waits on you${what}`;
}

export interface OperatingMap {
  first_name?: string;
  role_title?: string;
  function?: string;
  seniority?: string;
  tenure_band?: string;
  work_mode?: string;
  tools?: string[];
  rekey_pair?: [string, string] | null;
  rekey_hours?: string;
  channel_routine?: string;
  channel_sameday?: string;
  channel_urgent?: string;
  hours_window?: string;
  hard_rule?: string | null;
  scores?: Scores;
  ai_usage_level?: number;
  handoffs?: Handoff[];
  annoying_task?: string | null;
}

export type FieldKey = keyof OperatingMap;

export type Confidence = Partial<Record<FieldKey, "high" | "low">>;
export type Quotes = Partial<Record<string, string>>;

export const FIELD_LABELS: Record<FieldKey, string> = {
  first_name: "First name",
  role_title: "Role",
  function: "Function",
  seniority: "Seniority",
  tenure_band: "Tenure",
  work_mode: "Work mode",
  tools: "Tools",
  rekey_pair: "Re-key pair",
  rekey_hours: "Re-key hours",
  channel_routine: "Routine",
  channel_sameday: "Same day",
  channel_urgent: "Urgent",
  hours_window: "Hours",
  hard_rule: "Hard rule",
  scores: "Working style",
  ai_usage_level: "AI usage",
  handoffs: "Hand-offs",
  annoying_task: "Annoying task",
};

export interface Section {
  id: string;
  label: string;
  fields: FieldKey[];
}

export const SECTIONS: Section[] = [
  {
    id: "about",
    label: "About you",
    fields: ["role_title", "function", "seniority", "tenure_band", "work_mode"],
  },
  { id: "tools", label: "Tools", fields: ["tools", "rekey_pair", "rekey_hours"] },
  {
    id: "reach",
    label: "Reach",
    fields: ["channel_routine", "channel_sameday", "channel_urgent", "hours_window", "hard_rule"],
  },
  { id: "style", label: "Working style", fields: ["scores", "ai_usage_level"] },
  { id: "handoffs", label: "Hand-offs", fields: ["handoffs", "annoying_task"] },
];

export const ALL_FIELDS: FieldKey[] = SECTIONS.flatMap((s) => s.fields);

const ENUMS: Partial<Record<FieldKey, readonly string[]>> = {
  function: FUNCTIONS,
  seniority: SENIORITIES,
  tenure_band: TENURE_BANDS,
  work_mode: WORK_MODES,
  rekey_hours: REKEY_HOURS,
  channel_routine: CHANNELS,
  channel_sameday: CHANNELS,
  channel_urgent: CHANNELS,
};

export function enumFor(key: FieldKey): readonly string[] | undefined {
  return ENUMS[key];
}

export interface ValidationFailure {
  field: string;
  reason: string;
}

/** Validates one incoming field value. Returns null when valid. */
export function validateField(key: string, value: unknown): ValidationFailure | null {
  const bad = (field: string): ValidationFailure => ({
    field,
    reason: "not one of the allowed values",
  });

  const allowed = ENUMS[key as FieldKey];
  if (allowed) {
    if (typeof value !== "string" || !allowed.includes(value)) return bad(key);
    return null;
  }

  switch (key) {
    case "role_title":
    case "hours_window":
      return typeof value === "string" && value.trim().length > 0 ? null : bad(key);
    case "first_name":
    case "hard_rule":
    case "annoying_task":
      return value === null || typeof value === "string" ? null : bad(key);
    case "handoffs": {
      const reason = handoffReason(value);
      return reason ? { field: "handoffs", reason } : null;
    }
    case "tools":
      if (!Array.isArray(value) || value.some((t) => typeof t !== "string")) return bad(key);
      return null;
    case "rekey_pair":
      if (value === null) return null;
      if (!Array.isArray(value) || value.length !== 2 || value.some((t) => typeof t !== "string"))
        return bad(key);
      return null;
    case "ai_usage_level":
      return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4
        ? null
        : bad(key);
    case "scores": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return bad(key);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!(SCORE_KEYS as readonly string[]).includes(k)) return bad(`scores.${k}`);
        if (typeof v !== "number" || !(SCORE_VALUES as readonly number[]).includes(v))
          return bad(`scores.${k}`);
      }
      return null;
    }
    default:
      return bad(key);
  }
}

/** Normalises a tool name against the catalog, otherwise prefixes "Other: ". */
export function normaliseTool(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  if (trimmed.toLowerCase().startsWith("other:")) {
    const rest = trimmed.slice(6).trim();
    const match = TOOL_CATALOG.find((t) => t.toLowerCase() === rest.toLowerCase());
    return match ?? `Other: ${rest}`;
  }
  const match =
    TOOL_CATALOG.find((t) => t.toLowerCase() === trimmed.toLowerCase()) ??
    TOOL_ALIASES[trimmed.toLowerCase()];
  return match ?? `Other: ${trimmed}`;
}

export function formatChip(key: FieldKey, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const label = FIELD_LABELS[key];
  if (key === "tools") {
    const list = value as string[];
    if (!list.length) return null;
    return `${label}: ${list.join(", ")}`;
  }
  if (key === "rekey_pair") {
    const pair = value as [string, string];
    return `${label}: ${pair[0]} to ${pair[1]}`;
  }
  if (key === "scores" || key === "handoffs") return null;
  if (key === "ai_usage_level") return `${label}: ${AI_USAGE_LABELS[value as number] ?? value}`;
  return `${label}: ${String(value)}`;
}

export function emptyMap(firstName: string): OperatingMap {
  return { first_name: firstName, tools: [], scores: {} };
}

export const OPTIONAL_FIELDS: FieldKey[] = [
  "ai_usage_level",
  "handoffs",
  "annoying_task",
  "rekey_pair",
  "hours_window",
  "hard_rule",
];

/** Required keys; scores are expanded into scores.<dimension>. */
export const REQUIRED_KEYS: string[] = ALL_FIELDS.filter((k) => !OPTIONAL_FIELDS.includes(k)).flatMap(
  (k) => (k === "scores" ? SCORE_KEYS.map((d) => `scores.${d}`) : [k]),
);

export function isCaptured(map: OperatingMap, key: string): boolean {
  if (key.startsWith("scores.")) {
    const d = key.slice(7) as ScoreKey;
    return typeof map.scores?.[d] === "number";
  }
  if (key === "scores") return SCORE_KEYS.every((d) => typeof map.scores?.[d] === "number");
  const v = map[key as FieldKey];
  if (v === undefined || v === "") return false;
  if (key === "tools") return Array.isArray(v) && v.length > 0;
  return true; // explicit null counts as answered for optional nullable fields
}

export function sectionKeys(section: Section): string[] {
  return section.fields.flatMap((k) =>
    k === "scores" ? SCORE_KEYS.map((d) => `scores.${d}`) : [k],
  );
}

export function missingInSection(map: OperatingMap, sectionId: string): string[] {
  const section = SECTIONS.find((s) => s.id === sectionId);
  return section ? sectionKeys(section).filter((k) => !isCaptured(map, k)) : [];
}

export function missingRequired(map: OperatingMap): string[] {
  return REQUIRED_KEYS.filter((k) => !isCaptured(map, k));
}

export function sectionOf(key: string): string | undefined {
  const base = key.startsWith("scores.") ? "scores" : key;
  return SECTIONS.find((s) => s.fields.includes(base as FieldKey))?.id;
}

export type EndedBy =
  | "wrap"
  | "wrap_unconfirmed"
  | "finish_early"
  | "finish_early_voice"
  | "cap"
  | "dropped";

export interface ToolLogEntry {
  at: number;
  tool: string;
  keys: string[];
  ok: boolean;
  rejected: ValidationFailure[];
  /** Who asked for the recording: the app's timed request, or the interviewer handing off. */
  source?: "app" | "interviewer";
}

export interface ErrorEntry {
  at: number;
  where: string;
  message: string;
}

export interface RecordInput {
  fields?: Record<string, unknown> | null;
  confidence?: Record<string, unknown> | null;
  quotes?: Record<string, unknown> | null;
}

export interface RecordOutcome {
  next: OperatingMap;
  confidence: Confidence;
  quotes: Quotes;
  result: {
    ok: boolean;
    captured: string[];
    rejected: ValidationFailure[];
    missing_in_section: string[];
    missing_required: string[];
    note?: string;
  };
  section: string;
}

/**
 * Applies one record_answers call. Every valid field is recorded; only invalid
 * fields are rejected. A missing or null handoffs means no hand-offs in this call.
 */
export function applyRecordAnswers(
  prev: OperatingMap,
  args: RecordInput,
  firstName: string,
  currentSection: string,
): RecordOutcome {
  const incoming: Record<string, unknown> =
    args && typeof args.fields === "object" && args.fields !== null ? { ...args.fields } : {};
  delete incoming["first_name"];
  if (incoming["handoffs"] === null || incoming["handoffs"] === undefined) delete incoming["handoffs"];
  const confIn = (args?.confidence ?? {}) as Record<string, unknown>;
  const quoteIn = (args?.quotes ?? {}) as Record<string, unknown>;

  const captured: string[] = [];
  const rejected: ValidationFailure[] = [];
  const notes: string[] = [];
  const confidence: Confidence = {};
  const quotes: Quotes = {};
  const next: OperatingMap = { ...prev, first_name: firstName };

  for (const [key, raw] of Object.entries(incoming)) {
    let value = raw;
    try {
      if (key === "tools" && Array.isArray(raw)) {
        value = raw.filter((t): t is string => typeof t === "string").map(normaliseTool);
      }
      if (key === "handoffs") value = normaliseHandoffs(raw);
      if (key === "rekey_pair" && Array.isArray(raw)) {
        value = raw.map((t) => (typeof t === "string" ? normaliseTool(t) : t));
      }
      const failure = validateField(key, value);
      if (failure) {
        rejected.push({
          field: failure.field,
          reason:
            key === "rekey_pair"
              ? "rekey_pair must be a two-item array of tool names, or null"
              : failure.reason,
        });
        continue;
      }
    } catch (e) {
      rejected.push({ field: key, reason: e instanceof Error ? e.message : "could not read this value" });
      continue;
    }
    const k = key as FieldKey;
    if (k === "scores") {
      next.scores = { ...(next.scores ?? {}), ...(value as Record<string, number>) } as Scores;
    } else if (k === "tools") {
      next.tools = [...new Set([...(next.tools ?? []), ...(value as string[])])];
    } else {
      (next as Record<string, unknown>)[k] = value;
    }
    captured.push(key);
    const conf = confIn[key];
    if (conf === "high" || conf === "low") confidence[k] = conf;
    const quote = quoteIn[key];
    if (typeof quote === "string" && quote) quotes[key] = quote;
  }

  if (Array.isArray(next.rekey_pair)) {
    const tools = [...(next.tools ?? [])];
    for (const t of next.rekey_pair) {
      if (!tools.includes(t)) {
        tools.push(t);
        notes.push(`added ${t} to tools`);
      }
    }
    next.tools = tools;
  }

  const lastKey = captured[captured.length - 1];
  const section = (lastKey && sectionOf(lastKey)) || currentSection;
  return {
    next,
    confidence,
    quotes,
    section,
    result: {
      ok: captured.length > 0,
      captured,
      rejected,
      missing_in_section: missingInSection(next, section),
      missing_required: missingRequired(next),
      ...(notes.length ? { note: notes.join("; ") } : {}),
    },
  };
}

export interface SessionExport {
  session_id: string;
  first_name: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  ended_by: EndedBy;
  fields: Record<string, unknown>;
  confidence: Record<string, unknown>;
  quotes: Record<string, string | null>;
  edited_fields: string[];
  sections_completed: string[];
  estimated_cost: number;
  estimated_cost_note: string;
  tool_log: ToolLogEntry[];
  errors: ErrorEntry[];
  event_log: EventLogEntry[];
  event_log_dropped: number;
  session_config: SessionConfigSummary | null;
}

/** One received session event. Never holds spoken words, audio, or keys. */
export interface EventLogEntry {
  at: number;
  type: string;
  note: string;
}

/** What the server sent when creating the session, without keys or prompt text. */
export interface SessionConfigSummary {
  live_model: string;
  voice: string;
  delegation_present: boolean;
  delegation_type: string | null;
  backend_model: string | null;
  tools: string[];
  tool_choice: string | null;
  live_prompt_chars: number;
  backend_prompt_chars: number;
  response_status: number | null;
  accepted: boolean;
  session_id: string | null;
}

export const EVENT_LOG_CAP = 500;

/** Voice session time only; backend tokens excluded. */
export function estimateCost(durationSeconds: number): number {
  return Math.round((durationSeconds / 60) * 0.05 * 1000) / 1000;
}

/** Every schema key present; null where nothing was captured. Scores always carry all six dimensions. */
export function fullFields(map: OperatingMap, firstName: string): Record<string, unknown> {
  const out: Record<string, unknown> = { first_name: firstName || map.first_name || null };
  for (const k of ALL_FIELDS) {
    if (k === "scores") {
      out["scores"] = Object.fromEntries(SCORE_KEYS.map((d) => [d, map.scores?.[d] ?? null]));
    } else {
      const v = map[k];
      out[k] = v === undefined || v === "" ? null : v;
    }
  }
  return out;
}

export function fullKeyed<T>(obj: Partial<Record<string, T>>): Record<string, T | null> {
  return Object.fromEntries(ALL_FIELDS.map((k) => [k, obj[k] ?? null]));
}

/**
 * Sections 1 to 4 are complete when all their required fields are captured.
 * Section 5 is complete when a hand-off or the annoying task is captured, or the call ended by the closing line.
 */
export function sectionIsComplete(map: OperatingMap, sectionId: string, closedByWrap: boolean): boolean {
  if (sectionId === "handoffs") {
    return (
      (Array.isArray(map.handoffs) && map.handoffs.length > 0) ||
      (typeof map.annoying_task === "string" && map.annoying_task.trim() !== "") ||
      closedByWrap
    );
  }
  const section = SECTIONS.find((s) => s.id === sectionId);
  if (!section) return false;
  return sectionKeys(section)
    .filter((k) => REQUIRED_KEYS.includes(k))
    .every((k) => isCaptured(map, k));
}

export function sectionsCompleted(map: OperatingMap, endedBy: EndedBy): string[] {
  return SECTIONS.filter((sec) => sectionIsComplete(map, sec.id, endedBy === "wrap")).map((s) => s.label);
}

/** Plain names for required keys, for the "Still needed" note. */
export function requiredKeyLabel(key: string): string {
  if (key.startsWith("scores.")) {
    const d = key.slice(7) as ScoreKey;
    const pole = SCORE_POLES[d];
    return pole ? `${pole.label.toLowerCase()} (${pole.low} or ${pole.high})` : d;
  }
  return (FIELD_LABELS[key as FieldKey] ?? key).toLowerCase();
}
