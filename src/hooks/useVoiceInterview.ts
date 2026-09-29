import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createRealtimeSession } from "@/lib/realtime.functions";
import {
  normaliseTool,
  validateField,
  type Confidence,
  type FieldKey,
  type OperatingMap,
  type Quotes,
} from "@/lib/schema";

export type VoiceStatus = "idle" | "connecting" | "live" | "ended" | "error";
export type VoiceErrorKind = "mic" | "session" | "connection" | null;

export const HARD_CAP_SECONDS = 7 * 60;

interface Options {
  firstName: string;
  onFinish: (reason: "complete" | "dropped" | "capped" | "early") => void;
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

  const finish = useCallback(
    (reason: "complete" | "dropped" | "capped" | "early") => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      teardown();
      setStatus("ended");
      onFinish(reason);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onFinish],
  );

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
    const incoming = args.fields ?? {};
    const captured: string[] = [];

    for (const [key, raw] of Object.entries(incoming)) {
      let value = raw;
      if (key === "tools" && Array.isArray(raw)) {
        value = (raw as unknown[])
          .filter((t): t is string => typeof t === "string")
          .map(normaliseTool);
      }
      const failure = validateField(key, value);
      if (failure) return { ok: false as const, ...failure };

      captured.push(key);
      const k = key as FieldKey;
      setFields((prev) => {
        const next = { ...prev, [k]: value } as OperatingMap;
        if (k === "scores") {
          next.scores = { ...(prev.scores ?? {}), ...(value as Record<string, number>) };
        }
        fieldsRef.current = next;
        return next;
      });

      const conf = args.confidence?.[key];
      if (conf) setConfidence((prev) => ({ ...prev, [k]: conf }));
      const quote = args.quotes?.[key];
      if (quote) setQuotes((prev) => ({ ...prev, [key]: quote }));
    }

    return { ok: true as const, captured };
  }, []);

  const sendToolResult = useCallback((callId: string, output: unknown) => {
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
    dc.send(JSON.stringify({ type: "response.create" }));
  }, []);

  const handleServerEvent = useCallback(
    (event: Record<string, unknown>) => {
      const type = event["type"];

      if (type === "input_audio_buffer.speech_started") setSpeaker("person");
      if (type === "input_audio_buffer.speech_stopped") setSpeaker("idle");
      if (type === "output_audio_buffer.started" || type === "response.output_audio.delta")
        setSpeaker("agent");
      if (type === "output_audio_buffer.stopped" || type === "response.output_audio.done")
        setSpeaker("idle");

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

      if (name !== "record_answers" || !callId || handledCallsRef.current.has(callId)) return;
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
        body: offer.sdp,
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
        if (next >= HARD_CAP_SECONDS) finish("capped");
        return next;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [status, finish]);

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
