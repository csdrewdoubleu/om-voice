import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createRealtimeSession } from "@/lib/realtime.functions";
import {
  missingInSection,
  missingRequired,
  normaliseTool,
  sectionOf,
  validateField,
  type Confidence,
  type FieldKey,
  type OperatingMap,
  type Quotes,
} from "@/lib/schema";

export type VoiceStatus = "idle" | "connecting" | "live" | "ended" | "error";
export type VoiceErrorKind = "mic" | "session" | "connection" | null;

export const HARD_CAP_SECONDS = 7 * 60;
export const REQUIRED_ONLY_SECONDS = 5 * 60;
export const FORCE_WRAP_SECONDS = 6 * 60 + 30;

export type FinishReason = "complete" | "dropped" | "capped" | "early" | "voice_early";

interface Options {
  firstName: string;
  onFinish: (reason: FinishReason) => void;
}

interface RecordArgs {
  fields?: Record<string, unknown>;
  confidence?: Record<string, "high" | "low">;
  quotes?: Record<string, string>;
}

export function useVoiceInterview({ firstName, onFinish }: Options) {
  const getToken = useServerFn(createRealtimeSession);

  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [errorKind, setErrorKind] = useState<VoiceErrorKind>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [fields, setFields] = useState<OperatingMap>({ first_name: firstName });
  const [confidence, setConfidence] = useState<Confidence>({});
  const [quotes, setQuotes] = useState<Quotes>({});
  const [elapsed, setElapsed] = useState(0);
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [speaker, setSpeaker] = useState<"agent" | "person" | "idle">("idle");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analysersRef = useRef<{ mic?: AnalyserNode; remote?: AnalyserNode }>({});
  const rafRef = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const handledCallsRef = useRef<Set<string>>(new Set());
  const fieldsRef = useRef<OperatingMap>({ first_name: firstName });
  const currentSectionRef = useRef<string>("about");
  const endingRef = useRef(false);
  const endReasonRef = useRef<FinishReason>("complete");
  const responseActiveRef = useRef(false);
  const pendingCreateRef = useRef(false);

  const finish = useCallback(
    (reason: FinishReason) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      teardown();
      setStatus("ended");
      onFinish(reason);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onFinish],
  );

  const finishRef = useRef(finish);
  finishRef.current = finish;

  function teardown() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    try {
      dcRef.current?.close();
    } catch {
      /* already closed */
    }
    try {
      pcRef.current?.close();
    } catch {
      /* already closed */
    }
    micRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    analysersRef.current = {};
    dcRef.current = null;
    pcRef.current = null;
    micRef.current = null;
    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
      audioElRef.current.remove();
      audioElRef.current = null;
    }
  }

  const applyRecord = useCallback((args: RecordArgs) => {
    const incoming = { ...(args.fields ?? {}) };
    delete incoming["first_name"]; // first name comes from the start screen only
    const captured: string[] = [];
    const notes: string[] = [];

    // Validate everything first so a bad call changes nothing.
    const cleaned: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(incoming)) {
      let value = raw;
      if (key === "tools" && Array.isArray(raw)) {
        value = (raw as unknown[])
          .filter((t): t is string => typeof t === "string")
          .map(normaliseTool);
      }
      if (key === "rekey_pair" && Array.isArray(raw)) {
        value = (raw as unknown[]).map((t) => (typeof t === "string" ? normaliseTool(t) : t));
      }
      const failure = validateField(key, value);
      if (failure) {
        return {
          ok: false as const,
          ...failure,
          reason:
            key === "rekey_pair"
              ? "rekey_pair must be a two-item array of tool names, or null"
              : failure.reason,
        };
      }
      cleaned[key] = value;
    }

    const prev = fieldsRef.current;
    const next: OperatingMap = { ...prev, first_name: firstName };
    for (const [key, value] of Object.entries(cleaned)) {
      const k = key as FieldKey;
      if (k === "scores") {
        next.scores = { ...(prev.scores ?? {}), ...(value as Record<string, number>) };
      } else if (k === "tools") {
        next.tools = [...new Set([...(next.tools ?? []), ...(value as string[])])];
      } else {
        (next as Record<string, unknown>)[k] = value;
      }
      captured.push(key);
      const conf = args.confidence?.[key];
      if (conf) setConfidence((p) => ({ ...p, [k]: conf }));
      const quote = args.quotes?.[key];
      if (quote) setQuotes((p) => ({ ...p, [key]: quote }));
    }

    // Any re-key tool not already in tools is added automatically.
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

    fieldsRef.current = next;
    setFields(next);

    const lastKey = captured[captured.length - 1];
    const sec = lastKey ? sectionOf(lastKey) : undefined;
    if (sec) currentSectionRef.current = sec;

    return {
      ok: true as const,
      captured,
      missing_in_section: missingInSection(next, currentSectionRef.current),
      missing_required: missingRequired(next),
      ...(notes.length ? { note: notes.join("; ") } : {}),
    };
  }, [firstName]);

  const sendSystemNote = useCallback((text: string) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;
    dc.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "system", content: [{ type: "input_text", text }] },
      }),
    );
  }, []);

  const requestResponse = useCallback(() => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open" || endingRef.current) return;
    // A response.create during an active response is rejected, so queue it.
    if (responseActiveRef.current) {
      pendingCreateRef.current = true;
      return;
    }
    pendingCreateRef.current = false;
    dc.send(JSON.stringify({ type: "response.create" }));
  }, []);

  const sendToolResult = useCallback(
    (callId: string, output: unknown) => {
      const dc = dcRef.current;
      if (!dc || dc.readyState !== "open") return;
      dc.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(output),
          },
        }),
      );
      requestResponse();
    },
    [requestResponse],
  );

  const handleServerEvent = useCallback(
    (event: Record<string, unknown>) => {
      const type = event["type"];

      if (type === "response.created") responseActiveRef.current = true;
      if (type === "response.done" || type === "response.cancelled") {
        responseActiveRef.current = false;
        if (pendingCreateRef.current) requestResponse();
      }

      if (type === "input_audio_buffer.speech_started") setSpeaker("person");
      if (type === "input_audio_buffer.speech_stopped") setSpeaker("idle");
      if (type === "output_audio_buffer.started" || type === "response.output_audio.delta")
        setSpeaker("agent");
      if (type === "output_audio_buffer.stopped" || type === "response.output_audio.done") {
        setSpeaker("idle");
        if (endingRef.current && type === "output_audio_buffer.stopped") {
          const reason = endReasonRef.current;
          window.setTimeout(() => finishRef.current(reason), 300);
        }
      }

      const isCallDone =
        type === "response.function_call_arguments.done" ||
        type === "response.output_item.done" ||
        type === "conversation.item.done";

      if (!isCallDone) return;

      let name: string | undefined;
      let callId: string | undefined;
      let argsText: string | undefined;

      if (type === "response.function_call_arguments.done") {
        name = event["name"] as string | undefined;
        callId = event["call_id"] as string | undefined;
        argsText = event["arguments"] as string | undefined;
      } else {
        const item = (event["item"] ?? {}) as Record<string, unknown>;
        if (item["type"] !== "function_call") return;
        name = item["name"] as string | undefined;
        callId = item["call_id"] as string | undefined;
        argsText = item["arguments"] as string | undefined;
      }

      if (!callId || handledCallsRef.current.has(callId)) return;
      if (name === "finish_session") {
        handledCallsRef.current.add(callId);
        let reason = "complete";
        try {
          reason = (JSON.parse(argsText || "{}") as { reason?: string }).reason ?? "complete";
        } catch {
          /* default to complete */
        }
        endReasonRef.current = reason === "person_requested" ? "voice_early" : "complete";
        endingRef.current = true;
        pendingCreateRef.current = false;
        const dc = dcRef.current;
        if (dc && dc.readyState === "open") {
          dc.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: { type: "function_call_output", call_id: callId, output: '{"ok":true}' },
            }),
          );
        }
        // Wait for the closing audio to finish playing; fall back after 8 seconds.
        const fallbackReason = endReasonRef.current;
        window.setTimeout(() => finishRef.current(fallbackReason), 8000);
        return;
      }
      if (name !== "record_answers") return;
      handledCallsRef.current.add(callId);

      let parsed: RecordArgs = {};
      try {
        parsed = JSON.parse(argsText || "{}") as RecordArgs;
      } catch {
        sendToolResult(callId, { ok: false, reason: "arguments were not valid JSON" });
        return;
      }
      sendToolResult(callId, applyRecord(parsed));
    },
    [applyRecord, sendToolResult],
  );

  const start = useCallback(async () => {
    if (status === "connecting" || status === "live") return;
    setStatus("connecting");
    fieldsRef.current = { ...fieldsRef.current, first_name: firstName };
    setFields(fieldsRef.current);
    setErrorKind(null);
    setErrorMessage("");

    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setStatus("error");
      setErrorKind("mic");
      setErrorMessage("Voice needs the microphone.");
      return;
    }
    micRef.current = mic;

    let token: string;
    try {
      const result = await getToken({ data: { firstName } });
      if (!result.ok || !result.value) {
        mic.getTracks().forEach((t) => t.stop());
        setStatus("error");
        setErrorKind("session");
        setErrorMessage(result.error ?? "Could not start the conversation.");
        return;
      }
      token = result.value;
    } catch {
      mic.getTracks().forEach((t) => t.stop());
      setStatus("error");
      setErrorKind("session");
      setErrorMessage("Could not start the conversation.");
      return;
    }

    try {
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioElRef.current = audioEl;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const micAnalyser = ctx.createAnalyser();
      micAnalyser.fftSize = 512;
      ctx.createMediaStreamSource(mic).connect(micAnalyser);
      analysersRef.current.mic = micAnalyser;

      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0]!;
        try {
          const remoteAnalyser = ctx.createAnalyser();
          remoteAnalyser.fftSize = 512;
          ctx.createMediaStreamSource(e.streams[0]!).connect(remoteAnalyser);
          analysersRef.current.remote = remoteAnalyser;
        } catch {
          /* analyser is decorative only */
        }
      };

      pc.addTrack(mic.getTracks()[0]!, mic);

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.addEventListener("message", (e) => {
        try {
          handleServerEvent(JSON.parse(e.data as string) as Record<string, unknown>);
        } catch {
          /* ignore malformed event */
        }
      });
      dc.addEventListener("open", () => setStatus("live"));

      pc.addEventListener("connectionstatechange", () => {
        if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
          finish("dropped");
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp ?? "",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/sdp",
        },
      });

      if (!sdpResponse.ok) throw new Error(`SDP exchange failed: ${sdpResponse.status}`);

      await pc.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
      setStatus("live");

      // Drive the level meter.
      const buffer = new Uint8Array(256);
      const tick = () => {
        const analyser =
          analysersRef.current.remote && speakerIsAgent()
            ? analysersRef.current.remote
            : analysersRef.current.mic;
        if (analyser) {
          analyser.getByteTimeDomainData(buffer);
          let sum = 0;
          for (let i = 0; i < buffer.length; i += 1) {
            const v = (buffer[i]! - 128) / 128;
            sum += v * v;
          }
          setLevel(Math.min(1, Math.sqrt(sum / buffer.length) * 4));
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      teardown();
      setStatus("error");
      setErrorKind("connection");
      setErrorMessage("The call could not connect.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstName, getToken, handleServerEvent, status, finish]);

  const speakerRef = useRef(speaker);
  speakerRef.current = speaker;
  function speakerIsAgent() {
    return speakerRef.current === "agent";
  }

  // Elapsed timer plus the hard seven-minute cap.
  useEffect(() => {
    if (status !== "live") return;
    const id = window.setInterval(() => {
      setElapsed((prev) => {
        const next = prev + 1;
        if (next === REQUIRED_ONLY_SECONDS) {
          const missing = missingRequired(fieldsRef.current);
          if (missing.length) {
            sendSystemNote(
              `Five minutes have passed. Skip every remaining optional question. Ask only for these required fields, one per turn, then wrap: ${missing.join(", ")}.`,
            );
          }
        }
        if (next === FORCE_WRAP_SECONDS) {
          sendSystemNote(
            "Six and a half minutes have passed. The time budget has run out. Begin the wrap now, keep it brief, then call finish_session with reason "complete".",
          );
          if (dcRef.current?.readyState === "open")
            dcRef.current.send(JSON.stringify({ type: "response.create" }));
        }
        if (next >= HARD_CAP_SECONDS) finish("capped");
        return next;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [status, finish, sendSystemNote]);

  useEffect(() => () => teardown(), []);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      micRef.current?.getAudioTracks().forEach((t) => {
        t.enabled = !next;
      });
      return next;
    });
  }, []);

  return {
    status,
    errorKind,
    errorMessage,
    fields,
    confidence,
    quotes,
    elapsed,
    muted,
    level,
    speaker,
    start,
    finish,
    toggleMute,
  };
}
