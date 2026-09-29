import { createServerFn } from "@tanstack/react-start";
import { buildSystemPrompt, RECORD_ANSWERS_TOOL } from "./prompt";

const DAILY_SESSION_CAP = 40;

export interface RealtimeSessionResult {
  ok: boolean;
  error?: string;
  value?: string;
  expires_at?: number;
  model?: string;
}

export const createRealtimeSession = createServerFn({ method: "POST" })
  .inputValidator((input: { firstName?: string }) => ({
    firstName: typeof input?.firstName === "string" ? input.firstName.slice(0, 60) : "",
  }))
  .handler(async ({ data }): Promise<RealtimeSessionResult> => {
    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      return { ok: false, error: "Voice is not configured yet. The API key is missing." };
    }

    // Spend guard: refuse above the daily session cap.
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count } = await supabaseAdmin
        .from("voice_sessions")
        .select("id", { count: "exact", head: true })
        .gte("created_at", since);
      if ((count ?? 0) >= DAILY_SESSION_CAP) {
        return {
          ok: false,
          error: "This prototype has hit its daily limit of conversations. Try again tomorrow.",
        };
      }
    } catch {
      // A counting failure should not block the session.
    }

    const model = "gpt-realtime-2.1";

    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model,
          instructions: buildSystemPrompt(data.firstName),
          audio: {
            input: { turn_detection: { type: "semantic_vad" } },
            output: { voice: "cedar" },
          },
          tools: [RECORD_ANSWERS_TOOL],
          tool_choice: "auto",
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error("realtime client_secrets failed", response.status, body);
      return {
        ok: false,
        error:
          response.status === 429
            ? "The voice service is busy. Try again in a moment."
            : "Could not start the conversation. Try again.",
      };
    }

    const payload = (await response.json()) as {
      value?: string;
      expires_at?: number;
      client_secret?: { value?: string; expires_at?: number };
    };

    const value = payload.value ?? payload.client_secret?.value;
    if (!value) {
      console.error("realtime client_secrets returned no token");
      return { ok: false, error: "Could not start the conversation. Try again." };
    }

    return {
      ok: true,
      value,
      expires_at: payload.expires_at ?? payload.client_secret?.expires_at,
      model,
    };
  });
