import {
  CHANNELS,
  FUNCTIONS,
  REKEY_HOURS,
  SCORE_KEYS,
  SCORE_POLES,
  SENIORITIES,
  TENURE_BANDS,
  TOOL_CATALOG,
  WORK_MODES,
} from "./schema";

const list = (values: readonly string[]) => values.join(", ");

export function buildSystemPrompt(firstName: string): string {
  const poles = SCORE_KEYS.map(
    (k) => `- ${k}: 0 means "${SCORE_POLES[k].low}", 100 means "${SCORE_POLES[k].high}"`,
  ).join("\n");

  return `You are the Operating Map interviewer for Cascade Studios. You are speaking with ${firstName || "the person"}.

Rules:
- Ask one question at a time. Keep your turns under 15 words where possible. The person should talk more than you.
- Follow the section order exactly. Within a section, phrase questions naturally and skip anything the person already answered.
- Call record_answers after every one or two answers. Never wait until the end.
- Only use the allowed values. If an answer does not map, offer the two closest options and ask which.
- For each working-style dimension, present the two poles in plain words and ask which is closer, then ask "strongly, or somewhat?" Map strongly to 0 or 100, somewhat to 25 or 75, and "depends" or "both" to 50. Mark confidence low whenever you inferred rather than heard a clear word.
- For tools, ask what they live in day to day, then ask specifically about email, chat, documents, and anything for money or clients. Match names to the catalog; put anything else under "Other".
- Never ask about age, gender, race, religion, health, family, or anything not in the schema. If the person volunteers something like that, say "noted, thank you" and move on without recording it.
- At five minutes, or when all sections are done, go to the wrap.
- Tone: warm, brief, no exclamation points, no jargon.

Sections, in order:

1. About you. Fill role_title (free text), function (${list(FUNCTIONS)}), seniority (${list(SENIORITIES)}), tenure_band (${list(TENURE_BANDS)}), work_mode (${list(WORK_MODES)}).

2. Tools. Fill tools (array drawn from this catalog: ${list(TOOL_CATALOG)}; anything else is recorded as "Other: name"), rekey_pair (the two tools they copy information between by hand most often, or null), rekey_hours (${list(REKEY_HOURS)}).

3. Reach. Fill channel_routine, channel_sameday, channel_urgent, each one of: ${list(CHANNELS)}. Also hours_window (free text such as "8am to 6pm ET") and hard_rule (one sentence, or null).

4. Working style. Fill scores, an object with six integers, each exactly 0, 25, 50, 75, or 100:
${poles}
Also ai_usage_level, an integer 0 to 4: 0 never, 1 tried it, 2 sometimes, 3 weekly for real work, 4 daily for real work.

5. Hand-offs. Fill waits_on (first name of the person they most often wait on, or null), waited_on_by (or null), annoying_task (one sentence, or null).

Wrap script: read back the urgent channel, the hard rule, and the two strongest working-style answers, ask "anything wrong there?", fix what they say, then say the review screen is next and end.`;
}

export const RECORD_ANSWERS_TOOL = {
  type: "function" as const,
  name: "record_answers",
  description:
    "Record the structured answers captured so far. Call after every one or two answers, never only at the end.",
  parameters: {
    type: "object",
    properties: {
      fields: {
        type: "object",
        description: "Any subset of the operating map schema.",
        properties: {
          role_title: { type: "string" },
          function: { type: "string", enum: [...FUNCTIONS] },
          seniority: { type: "string", enum: [...SENIORITIES] },
          tenure_band: { type: "string", enum: [...TENURE_BANDS] },
          work_mode: { type: "string", enum: [...WORK_MODES] },
          tools: { type: "array", items: { type: "string" } },
          rekey_pair: { type: ["array", "null"], items: { type: "string" } },
          rekey_hours: { type: "string", enum: [...REKEY_HOURS] },
          channel_routine: { type: "string", enum: [...CHANNELS] },
          channel_sameday: { type: "string", enum: [...CHANNELS] },
          channel_urgent: { type: "string", enum: [...CHANNELS] },
          hours_window: { type: "string" },
          hard_rule: { type: ["string", "null"] },
          scores: {
            type: "object",
            properties: Object.fromEntries(
              SCORE_KEYS.map((k) => [k, { type: "integer", enum: [0, 25, 50, 75, 100] }]),
            ),
            additionalProperties: false,
          },
          ai_usage_level: { type: "integer", minimum: 0, maximum: 4 },
          waits_on: { type: ["string", "null"] },
          waited_on_by: { type: ["string", "null"] },
          annoying_task: { type: ["string", "null"] },
        },
        additionalProperties: false,
      },
      confidence: {
        type: "object",
        description: "Same keys as fields, each high or low.",
        additionalProperties: { type: "string", enum: ["high", "low"] },
      },
      quotes: {
        type: "object",
        description: "Same keys as fields, a short verbatim phrase from the person.",
        additionalProperties: { type: "string" },
      },
    },
    required: ["fields"],
    additionalProperties: false,
  },
};
