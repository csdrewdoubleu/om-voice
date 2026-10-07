import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createLiveSession } from "@/lib/live.functions";
import {
  applyRecordAnswers,
  missingRequired,
  type ErrorEntry,
  type RecordInput,
  type ToolLogEntry,
  type Confidence,
  type FieldKey,
  type OperatingMap,
  type Quotes,
} from "@/lib/schema";

// ---- Settings ----
const SILENCE_AFTER_FINISH_MS = 1500;
const FINISH_FALLBACK_MS = 8000;
const SPEAKING_LEVEL = 0.06;
const UNCONFIRMED_WRAP_MS = 10000;
const WATCHDOG_SECONDS = 120;
const CLOSING_LINE = /next screen/i;

export type VoiceStatus = "idle" | "connecting" | "live" | "ended" | "error";
export type VoiceErrorKind = "mic" | "session" | "connection" | null;

export const HARD_CAP_SECONDS = 7 * 60;
export const REQUIRED_ONLY_SECONDS = 5 * 60;
export const FORCE_WRAP_SECONDS = 6 * 60 + 30;

export type FinishReason =
  | "complete"
  | "unconfirmed"
  | "dropped"
  | "capped"
  | "early"
  | "voice_early";

interface Options {
  firstName: string;
  onFinish: (reason: FinishReason) => void;
}

function rms(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const v = (buffer[i]! - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / buffer.length) * 4);
}

export function useVoiceInterview({ firstName, onFinish }: Options) {
  const startSession = useServerFn(createLiveSession);

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
  const [toolLog, setToolLog] = useState<ToolLogEntry[]>([]);
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [nothingRecordedWarning, setNothingRecordedWarning] = useState(false);
  const recordedOkRef = useRef(false);
  const startedAtMsRef = useRef(0);
  const outputTranscriptRef = useRef("");
  const closingHeardRef = useRef(false);

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
  const lastAgentSoundRef = useRef(0);
  const startedRef = useRef(false);
  const finishToolAtRef = useRef(0);
  // Backend responses that received tool results and need a continue.
  const needsContinueRef = useRef<Set<string>>(new Set());
  const callResponseRef = useRef<Map<string, string>>(new Map());

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
    const dc = dcRef.current;
    try {
      if (dc?.readyState === "open") dc.send(JSON.stringify({ type: "session.close" }));
    } catch {
      /* best effort */
    }
    try {
      dc?.close();
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

  const send = useCallback((payload: Record<string, unknown>) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;
    dc.send(JSON.stringify(payload));
  }, []);

  const secondsIn = () =>
    startedAtMsRef.current ? Math.round((performance.now() - startedAtMsRef.current) / 1000) : 0;

  const logError = useCallback((where: string, message: unknown) => {
    const text =
      typeof message === "string"
        ? message
        : message instanceof Error
          ? message.message
          : JSON.stringify(message ?? "unknown error");
    // Strip anything that looks like a key or bearer token.
    const safe = text.replace(/(sk-[A-Za-z0-9_-]{6,}|Bearer\s+\S+)/g, "[redacted]").slice(0, 500);
    console.warn("[voice]", where, safe);
    setErrors((prev) => [...prev, { at: secondsIn(), where, message: safe }]);
  }, []);

  const logTool = useCallback((entry: Omit<ToolLogEntry, "at">) => {
    setToolLog((prev) => [...prev, { at: secondsIn(), ...entry }]);
  }, []);

  const applyRecord = useCallback(
    (args: RecordInput) => {
      const outcome = applyRecordAnswers(fieldsRef.current, args, firstName, currentSectionRef.current);
      fieldsRef.current = outcome.next;
      currentSectionRef.current = outcome.section;
      setFields(outcome.next);
      if (Object.keys(outcome.confidence).length) setConfidence((p) => ({ ...p, ...outcome.confidence }));
      if (Object.keys(outcome.quotes).length) setQuotes((p) => ({ ...p, ...outcome.quotes }));
      if (outcome.result.ok) {
        recordedOkRef.current = true;
        setNothingRecordedWarning(false);
      }
      return outcome.result;
    },
    [firstName],
  );

  /** Steer the live voice directly (time notes, greeting). */
  const sendLiveNote = useCallback(
    (text: string) => {
      send({
        type: "session.instructions.append",
        event_id: `note_${Date.now()}`,
        delegation_id: null,
        content: text,
      });
    },
    [send],
  );

  const sendToolResult = useCallback(
    (responseId: string | undefined, callId: string, output: unknown) => {
      send({
        type: "response.item.create",
        event_id: `result_${callId}`,
        item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
      });
      if (responseId) needsContinueRef.current.add(responseId);
    },
    [send],
  );

  const runFunctionCall = useCallback(
    (responseId: string | undefined, item: Record<string, unknown>) => {
      const name = item["name"] as string | undefined;
      const callId = item["call_id"] as string | undefined;
      const argsText = item["arguments"] as string | undefined;
      if (!callId || handledCallsRef.current.has(callId)) return;
      handledCallsRef.current.add(callId);

      if (name === "finish_session") {
        let reason = "complete";
        try {
          reason = (JSON.parse(argsText || "{}") as { reason?: string }).reason ?? "complete";
        } catch {
          /* default to complete */
        }
        logTool({ tool: "finish_session", keys: ["reason"], ok: true, rejected: [] });
        endReasonRef.current = reason === "person_requested" ? "voice_early" : "complete";
        endingRef.current = true;
        sendToolResult(responseId, callId, { ok: true });
        finishToolAtRef.current = performance.now();
        const fallbackReason = endReasonRef.current;
        window.setTimeout(() => finishRef.current(fallbackReason), FINISH_FALLBACK_MS);
        return;
      }
      if (name !== "record_answers") {
        logTool({ tool: String(name), keys: [], ok: false, rejected: [] });
        sendToolResult(responseId, callId, { ok: false, reason: `unknown function ${name}` });
        return;
      }
      let parsed: RecordInput = {};
      try {
        parsed = JSON.parse(argsText || "{}") as RecordInput;
      } catch {
        logTool({ tool: "record_answers", keys: [], ok: false, rejected: [] });
        logError("record_answers", "arguments were not valid JSON");
        sendToolResult(responseId, callId, { ok: false, reason: "arguments were not valid JSON" });
        return;
      }
      const keys =
        parsed && typeof parsed.fields === "object" && parsed.fields !== null ? Object.keys(parsed.fields) : [];
      try {
        const result = applyRecord(parsed);
        logTool({ tool: "record_answers", keys, ok: result.ok, rejected: result.rejected });
        sendToolResult(responseId, callId, result);
      } catch (e) {
        logError("record_answers handler", e);
        logTool({ tool: "record_answers", keys, ok: false, rejected: [] });
        sendToolResult(responseId, callId, {
          ok: false,
          captured: [],
          rejected: [],
          reason: "the app could not process this call",
        });
      }
    },
    [applyRecord, sendToolResult, logTool, logError],
  );

  const handleServerEvent = useCallback(
    (event: Record<string, unknown>) => {
      const type = event["type"];

      if (type === "session.started") {
        startedRef.current = true;
        startedAtMsRef.current = performance.now();
        setStatus("live");
        sendLiveNote(
          "Greet the person now in English by first name, in one short sentence, then ask the opening question for section 1. Then pause and listen.",
        );
        return;
      }
      if (type === "session.closed") {
        if (!finishedRef.current) finishRef.current(endingRef.current ? endReasonRef.current : "dropped");
        return;
      }
      if (type === "error") {
        const err = (event["error"] ?? {}) as Record<string, unknown>;
        logError("live", (err["message"] as string | undefined) ?? err);
        return;
      }
      if (type === "session.output_transcript.delta" && typeof event["delta"] === "string") {
        outputTranscriptRef.current = (outputTranscriptRef.current + event["delta"]).slice(-400);
        if (!closingHeardRef.current && CLOSING_LINE.test(outputTranscriptRef.current)) {
          closingHeardRef.current = true;
          // Stop listening so a "thank you" can't start another turn.
          send({ type: "session.input_audio.mute", event_id: "closing_mute" });
          window.setTimeout(() => {
            if (finishedRef.current || endingRef.current) return;
            logError("finish_session", "no finish_session within 10 seconds of the closing line");
            finishRef.current("unconfirmed");
          }, UNCONFIRMED_WRAP_MS);
        }
        return;
      }
      if (type !== "response.event") return;

      const inner = (event["event"] ?? {}) as Record<string, unknown>;
      const innerType = inner["type"];
      const response = (inner["response"] ?? {}) as Record<string, unknown>;

      if (innerType === "error" || innerType === "response.failed") {
        const err = ((innerType === "error" ? inner["error"] : response["error"]) ?? inner) as Record<
          string,
          unknown
        >;
        logError(`delegated ${String(innerType)}`, (err["message"] as string | undefined) ?? err);
        return;
      }
      if (innerType === "response.incomplete") {
        logError("delegated response.incomplete", response["incomplete_details"] ?? "incomplete");
      }

      if (innerType === "response.output_item.done") {
        const item = (inner["item"] ?? {}) as Record<string, unknown>;
        if (item["type"] !== "function_call") return;
        const responseId =
          (inner["response_id"] as string | undefined) ??
          callResponseRef.current.get("current");
        runFunctionCall(responseId, item);
        return;
      }
      if (innerType === "response.created" && typeof response["id"] === "string") {
        callResponseRef.current.set("current", response["id"] as string);
        return;
      }
      if (
        innerType === "response.completed" ||
        innerType === "response.done" ||
        innerType === "response.incomplete"
      ) {
        const id = (response["id"] as string | undefined) ?? callResponseRef.current.get("current");
        if (id && needsContinueRef.current.has(id)) {
          needsContinueRef.current.delete(id);
          send({ type: "response.create", event_id: `continue_${id}` });
        }
      }
    },
    [runFunctionCall, send, sendLiveNote, logError],
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

    const fail = (kind: VoiceErrorKind, message: string) => {
      teardown();
      setStatus("error");
      setErrorKind(kind);
      setErrorMessage(message);
    };

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
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        audioEl.srcObject = stream;
        audioEl.play().catch(() => undefined);
        try {
          const remoteAnalyser = ctx.createAnalyser();
          remoteAnalyser.fftSize = 512;
          ctx.createMediaStreamSource(stream).connect(remoteAnalyser);
          analysersRef.current.remote = remoteAnalyser;
        } catch {
          /* analyser failure only affects the ring */
        }
      };

      for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);

      // Data channel and listeners before the offer.
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.addEventListener("message", (e) => {
        try {
          handleServerEvent(JSON.parse(e.data as string) as Record<string, unknown>);
        } catch (err) {
          logError("event handler", err);
        }
      });

      pc.addEventListener("connectionstatechange", () => {
        if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
          finishRef.current(endingRef.current ? endReasonRef.current : "dropped");
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (pc.iceGatheringState !== "complete") {
        await new Promise<void>((resolve) => {
          const timeout = window.setTimeout(done, 5000);
          function done() {
            window.clearTimeout(timeout);
            pc.removeEventListener("icegatheringstatechange", onState);
            resolve();
          }
          function onState() {
            if (pc.iceGatheringState === "complete") done();
          }
          pc.addEventListener("icegatheringstatechange", onState);
        });
      }

      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("Missing local SDP offer");

      let result;
      try {
        result = await startSession({ data: { firstName, sdp } });
      } catch {
        fail("session", "Could not start the conversation.");
        return;
      }
      if (!result.ok || !result.sdp) {
        fail("session", result.error ?? "Could not start the conversation.");
        return;
      }

      await pc.setRemoteDescription({ type: "answer", sdp: result.sdp });
      // Status flips to live on session.started; give up if it never comes.
      window.setTimeout(() => {
        if (dcRef.current === dc && !startedRef.current && !finishedRef.current) {
          fail("session", "The call could not connect. Try again.");
        }
      }, 15000);

      const buffer = new Uint8Array(256);
      const tick = () => {
        const { mic: micA, remote } = analysersRef.current;
        const agentLevel = remote ? rms(remote, buffer) : 0;
        const personLevel = micA ? rms(micA, buffer) : 0;
        const now = performance.now();
        if (agentLevel > SPEAKING_LEVEL) lastAgentSoundRef.current = now;
        const agentActive = now - lastAgentSoundRef.current < 400;
        if (agentActive) {
          setSpeaker("agent");
          setLevel(agentLevel);
        } else if (personLevel > SPEAKING_LEVEL) {
          setSpeaker("person");
          setLevel(personLevel);
        } else {
          setSpeaker("idle");
          setLevel(Math.max(agentLevel, personLevel));
        }
        // After finish_session: close once the voice has been quiet long enough.
        if (endingRef.current && finishToolAtRef.current) {
          const quietSince = Math.max(lastAgentSoundRef.current, finishToolAtRef.current);
          if (now - quietSince >= SILENCE_AFTER_FINISH_MS) {
            finishRef.current(endReasonRef.current);
            return;
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      fail("connection", "The call could not connect.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstName, startSession, handleServerEvent, status]);

  // Elapsed timer plus the hard seven-minute cap.
  useEffect(() => {
    if (status !== "live") return;
    const id = window.setInterval(() => {
      setElapsed((prev) => {
        const next = prev + 1;
        if (next === REQUIRED_ONLY_SECONDS) {
          const missing = missingRequired(fieldsRef.current);
          if (missing.length) {
            sendLiveNote(
              `Five minutes have passed. Skip every remaining optional question. Ask only for these required fields, one per turn, then wrap: ${missing.join(", ")}.`,
            );
          }
        }
        if (next === FORCE_WRAP_SECONDS) {
          sendLiveNote(
            "Six and a half minutes have passed. Begin the wrap now and keep it brief. After it, tell the backend the interview is complete.",
          );
        }
        if (next === WATCHDOG_SECONDS && !recordedOkRef.current) {
          setNothingRecordedWarning(true);
          setErrors((p) => [...p, { at: WATCHDOG_SECONDS, where: "watchdog", message: "no successful record_answers" }]);
        }
        if (next >= HARD_CAP_SECONDS) finish("capped");
        return next;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [status, finish, sendLiveNote]);

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
    toolLog,
    errors,
    nothingRecordedWarning,
    start,
    finish,
    toggleMute,
  };
}
