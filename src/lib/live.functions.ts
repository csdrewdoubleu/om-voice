import { createServerFn } from "@tanstack/react-start";
import {
  buildBackendPrompt,
  buildLivePrompt,
  FINISH_SESSION_TOOL,
  RECORD_ANSWERS_TOOL,
} from "./prompt";

// ---- Settings ----
const LIVE_MODEL = "gpt-live-1";
const BACKEND_MODEL = "gpt-6-luna";
const LIVE_VOICE = "cedar";
export const SESSION_CAP_SECONDS = 7 * 60;
const DAILY_SESSION_CEILING = 40;

export interface LiveSessionResult {
  ok: boolean;
  error?: string;
  sessionId?: string | undefined;
  sdp?: string;
}

export const createLiveSession = createServerFn({ method: "POST" })
  .inputValidator((input: { firstName?: string; sdp?: string }) => {
    if (typeof input?.sdp !== "string" || !input.sdp.trim() || input.sdp.length > 60000) {
      throw new Error("An SDP offer is required");
    }
    return {
      firstName: typeof input.firstName === "string" ? input.firstName.slice(0, 60) : "",
      sdp: input.sdp,
    };
  })
  .handler(async ({ data }): Promise<LiveSessionResult> => {
    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) return { ok: false, error: "Voice is not configured yet. The API key is missing." };

    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count } = await supabaseAdmin
        .from("voice_sessions")
        .select("id", { count: "exact", head: true })
        .gte("created_at", since);
      if ((count ?? 0) >= DAILY_SESSION_CEILING) {
        return {
          ok: false,
          error: "This prototype has hit its daily limit of conversations. Try again tomorrow.",
        };
      }
    } catch {
      // A counting failure should not block the session.
    }

    const response = await fetch("https://api.openai.com/v1/live/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          model: LIVE_MODEL,
          instructions: buildLivePrompt(data.firstName),
          audio: { output: { voice: LIVE_VOICE } },
          delegation: {
            type: "responses",
            responses: {
              model: BACKEND_MODEL,
              instructions: buildBackendPrompt(),
              tools: [RECORD_ANSWERS_TOOL, FINISH_SESSION_TOOL],
              tool_choice: "auto",
            },
          },
        },
        transport: { type: "webrtc", sdp: data.sdp },
      }),
    });

    if (!response.ok) {
      console.error("live session creation failed", response.status, await response.text());
      return {
        ok: false,
        error:
          response.status === 429
            ? "The voice service is busy. Try again in a moment."
            : "Could not start the conversation. Try again.",
      };
    }

    const payload = (await response.json()) as {
      session?: { id?: string };
      transport?: { sdp?: string };
    };
    if (!payload.transport?.sdp) {
      console.error("live session returned no SDP answer");
      return { ok: false, error: "Could not start the conversation. Try again." };
    }
    return { ok: true, sessionId: payload.session?.id, sdp: payload.transport.sdp };
  });
