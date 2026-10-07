import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createLiveSession, recordFromTranscript, type TranscriptTurn } from "@/lib/live.functions";
import {
  applyRecordAnswers,
  missingRequired,
  requiredKeyLabel,
  EVENT_LOG_CAP,
  type ErrorEntry,
  type EventLogEntry,
  type RecordInput,
  type SessionConfigSummary,
  type ToolLogEntry,
  type Confidence,
  type FieldKey,
  type OperatingMap,
  type Quotes,
} from "@/lib/schema";

// ---- Settings ----
const SILENCE_AFTER_CLOSING_MS = 1500;
const FINAL_RECORD_TIMEOUT_MS = 8000;
const RECORD_INTERVAL_SECONDS = 30;
const SPEAKING_LEVEL = 0.06;
const WATCHDOG_SECONDS = 120;
const CLOSING_LINE = /next screen/i;
const STOPPING_LINE = /stop there/i;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const safeText = (text: string) =>
  text.replace(/(sk-[A-Za-z0-9_-]{6,}|Bearer\s+\S+)/g, "[redacted]").slice(0, 300);

/**
 * Turn a received event into a log line with no spoken words, audio, or keys.
 * Returns null for audio chunks. `merge` marks streaming deltas that are folded
 * into the previous entry of the same type.
 */
export function describeEvent(
  event: Record<string, unknown>,
): { type: string; note: string; chars?: number } | null {
  const type = str(event["type"]) || "unknown";
  if (/audio[._]delta|input_audio\.append|audio_buffer/.test(type)) return null;
  if (type.includes("transcript")) {
    const who = type.includes("input") ? "person" : type.includes("output") ? "agent" : "unknown";
    const text = str(event["delta"]) || str(event["transcript"]) || str(event["text"]);
    return { type, note: who, chars: text.length };
  }
  if (type === "error") {
    const err = (event["error"] ?? {}) as Record<string, unknown>;
    return { type, note: safeText(str(err["message"]) || str(err["code"]) || "error") };
  }
  if (type === "session.started") {
    const session = (event["session"] ?? {}) as Record<string, unknown>;
    const deleg = (session["delegation"] ?? null) as Record<string, unknown> | null;
    const resp = (deleg?.["responses"] ?? {}) as Record<string, unknown>;
    const tools = Array.isArray(resp["tools"])
      ? (resp["tools"] as Record<string, unknown>[]).map((t) => str(t["name"]) || str(t["type"])).join(",")
      : "";
    return {
      type,
      note: `model=${str(session["model"]) || "?"} delegation=${deleg ? str(deleg["type"]) || "?" : "none"} backend=${str(resp["model"]) || "?"} tools=${tools || "none"}`,
    };
  }
  if (type === "session.delegation.created") {
    const d = (event["delegation"] ?? {}) as Record<string, unknown>;
    return { type, note: `target=${str(d["target"]) || "?"}` };
  }
  if (type === "session.closed") {
    return { type, note: safeText(str(event["reason"])) };
  }
  if (type === "response.event") {
    const inner = (event["event"] ?? {}) as Record<string, unknown>;
    const innerType = str(inner["type"]) || "unknown";
    const full = `response.event/${innerType}`;
    if (innerType.endsWith(".delta")) {
      return { type: full, note: "backend", chars: str(inner["delta"]).length };
    }
    const item = (inner["item"] ?? {}) as Record<string, unknown>;
    if (item["type"] === "function_call") {
      return { type: full, note: `tool=${str(item["name"]) || "?"} status=${str(item["status"]) || (innerType.endsWith("done") ? "done" : "started")}` };
    }
    const response = (inner["response"] ?? {}) as Record<string, unknown>;
    if (innerType === "error" || innerType === "response.failed") {
      const err = ((innerType === "error" ? inner["error"] : response["error"]) ?? {}) as Record<string, unknown>;
      return { type: full, note: safeText(str(err["message"]) || "failed") };
    }
    if (str(response["status"])) return { type: full, note: `status=${str(response["status"])}` };
    if (item["type"]) return { type: full, note: `item=${str(item["type"])}` };
    return { type: full, note: "" };
  }
  return { type, note: "" };
}

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
  const recordFn = useServerFn(recordFromTranscript);

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
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [eventLogDropped, setEventLogDropped] = useState(0);
  const [sessionConfig, setSessionConfig] = useState<SessionConfigSummary | null>(null);
  const callStartMsRef = useRef(0);
  const eventLogRef = useRef<EventLogEntry[]>([]);
  const eventDroppedRef = useRef(0);
  const mergeRef = useRef<{ type: string; note: string; chars: number; count: number } | null>(null);
  const elapsedRef = useRef(0);
  const watchdogLoggedRef = useRef(false);

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
  const [saving, setSaving] = useState(false);
  const transcriptRef = useRef<TranscriptTurn[]>([]);
  const personSpokeRef = useRef(false);
  const recordInFlightRef = useRef<Promise<boolean> | null>(null);
  const recordSeqRef = useRef(0);
  const lastMissingNoteRef = useRef<string | null>(null);
  const allInSentRef = useRef(false);
  // Backend responses that received tool results and need a continue.
  const needsContinueRef = useRef<Set<string>>(new Set());
  const callResponseRef = useRef<Map<string, string>>(new Map());

  const finish = useCallback(
    (reason: FinishReason) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      teardown();
      flushEventLog();
      setStatus("ended");
      onFinish(reason);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onFinish],
  );

  function flushEventLog() {
    setEventLog([...eventLogRef.current]);
    setEventLogDropped(eventDroppedRef.current);
  }

  function recordEvent(event: Record<string, unknown>) {
    const d = describeEvent(event);
    if (!d) return;
    const at = callStartMsRef.current
      ? Math.round((performance.now() - callStartMsRef.current) / 100) / 10
      : 0;
    const log = eventLogRef.current;
    const last = log[log.length - 1];
    const merge = mergeRef.current;
    // Fold consecutive streaming deltas of one type into a single entry.
    if (d.chars !== undefined && merge && last && merge.type === d.type && last.type === d.type) {
      merge.chars += d.chars;
      merge.count += 1;
      last.note = `${merge.note}, ${merge.chars} chars, ${merge.count} events`;
      return;
    }
    if (log.length >= EVENT_LOG_CAP) {
      eventDroppedRef.current += 1;
      mergeRef.current = null;
      return;
    }
    if (d.chars !== undefined) {
      mergeRef.current = { type: d.type, note: d.note, chars: d.chars, count: 1 };
      log.push({ at, type: d.type, note: `${d.note}, ${d.chars} chars, 1 events` });
    } else {
      mergeRef.current = null;
      log.push({ at, type: d.type, note: d.note });
    }
  }

  /** App-side notes in event_log (recording requests and how they ended). */
  function logAppEvent(type: string, note: string) {
    const log = eventLogRef.current;
    mergeRef.current = null;
    if (log.length >= EVENT_LOG_CAP) {
      eventDroppedRef.current += 1;
      return;
    }
    const at = callStartMsRef.current
      ? Math.round((performance.now() - callStartMsRef.current) / 100) / 10
      : 0;
    log.push({ at, type, note });
  }

  function appendTranscript(role: TranscriptTurn["role"], delta: string) {
    const list = transcriptRef.current;
    const last = list[list.length - 1];
    if (last && last.role === role) last.text += delta;
    else list.push({ role, text: delta });
  }

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
    const safe = safeText(text);
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

  /** Tell the interviewer what is still required, only when the list changes. */
  const noteMissing = () => {
    if (endingRef.current || finishedRef.current) return;
    const missing = missingRequired(fieldsRef.current);
    const key = missing.join(",");
    if (key === lastMissingNoteRef.current) return;
    lastMissingNoteRef.current = key;
    if (missing.length) {
      sendLiveNoteRef.current(`Still needed: ${missing.map(requiredKeyLabel).join(", ")}.`);
      logAppEvent("app.note", `still needed: ${missing.length}`);
    } else if (!allInSentRef.current) {
      allInSentRef.current = true;
      sendLiveNoteRef.current("All required answers are in.");
      logAppEvent("app.note", "all required answers are in");
    }
  };

  /** Merge one record_answers payload, from either source. */
  const handleRecordArgs = (parsed: RecordInput, source: "app" | "interviewer") => {
    const keys =
      parsed && typeof parsed.fields === "object" && parsed.fields !== null ? Object.keys(parsed.fields) : [];
    try {
      const result = applyRecord(parsed);
      logTool({ tool: "record_answers", keys, ok: result.ok, rejected: result.rejected, source });
      noteMissing();
      return result;
    } catch (e) {
      logError(`record_answers handler (${source})`, e);
      logTool({ tool: "record_answers", keys, ok: false, rejected: [], source });
      return null;
    }
  };

  /** One recording request from the app. Never two at once: a due request is skipped if one is running. */
  const runRecording = async (kind: "interval" | "final"): Promise<boolean> => {
    if (recordInFlightRef.current) {
      logAppEvent("app.record.skipped", `${kind}: previous request still running`);
      return false;
    }
    const transcript = transcriptRef.current
      .filter((t) => t.text.trim())
      .map((t) => ({ role: t.role, text: t.text }));
    if (!transcript.some((t) => t.role === "person")) {
      logAppEvent("app.record.skipped", `${kind}: the person has not spoken yet`);
      return kind === "final";
    }
    personSpokeRef.current = false;
    const n = (recordSeqRef.current += 1);
    const t0 = performance.now();
    logAppEvent("app.record.request", `#${n} ${kind}, ${transcript.length} turns`);
    const promise = (async () => {
      try {
        const r = await recordFn({ data: { transcript } });
        const ms = Math.round(performance.now() - t0);
        const tokens = r.usage ? `, in ${r.usage.input_tokens} out ${r.usage.output_tokens} tokens` : "";
        if (!r.ok || !r.args) {
          logAppEvent("app.record.failed", `#${n} ${ms}ms ${safeText(r.error ?? "failed")}${tokens}`);
          logError("app record", r.error ?? "failed");
          return false;
        }
        if (finishedRef.current) {
          logAppEvent("app.record.late", `#${n} ${ms}ms arrived after the call closed`);
          return false;
        }
        const result = handleRecordArgs(r.args as RecordInput, "app");
        logAppEvent(
          "app.record.done",
          `#${n} ${ms}ms captured ${result?.captured.length ?? 0} rejected ${result?.rejected.length ?? 0}${tokens}`,
        );
        return true;
      } catch (e) {
        logAppEvent("app.record.failed", `#${n} ${safeText(e instanceof Error ? e.message : "error")}`);
        logError("app record", e);
        return false;
      }
    })();
    recordInFlightRef.current = promise;
    try {
      return await promise;
    } finally {
      recordInFlightRef.current = null;
    }
  };
  const runRecordingRef = useRef(runRecording);
  runRecordingRef.current = runRecording;

  /**
   * End the call for any reason: stop listening, make one final recording request
   * (up to 8 seconds, waiting for a running one first), then open review.
   */
  const endCall = async (reason: FinishReason) => {
    if (finishedRef.current || endingRef.current) return;
    endingRef.current = true;
    endReasonRef.current = reason;
    logAppEvent("app.ending", reason);
    send({ type: "session.input_audio.mute", event_id: "closing_mute" });
    micRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = false;
    });
    setSaving(true);
    const t0 = performance.now();
    const timeout = new Promise<boolean>((resolve) =>
      window.setTimeout(() => resolve(false), FINAL_RECORD_TIMEOUT_MS),
    );
    const final = (async () => {
      const running = recordInFlightRef.current;
      if (running) await running.catch(() => false);
      return runRecordingRef.current("final");
    })();
    const ok = await Promise.race([final, timeout]);
    let finalReason = reason;
    if (!ok) {
      logError("final record", "the final recording request failed or timed out");
      if (reason === "complete" || reason === "voice_early") finalReason = "unconfirmed";
    }
    // After a spoken closing, let the voice finish its line (within the same 8 seconds).
    if (reason === "complete" || reason === "voice_early") {
      await new Promise<void>((resolve) => {
        const id = window.setInterval(() => {
          const now = performance.now();
          const quiet = now - Math.max(lastAgentSoundRef.current, t0) >= SILENCE_AFTER_CLOSING_MS;
          if (quiet || now - t0 >= FINAL_RECORD_TIMEOUT_MS) {
            window.clearInterval(id);
            resolve();
          }
        }, 100);
      });
    }
    setSaving(false);
    finishRef.current(finalReason);
  };
  const endCallRef = useRef(endCall);
  endCallRef.current = endCall;

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
  const sendLiveNoteRef = useRef(sendLiveNote);
  sendLiveNoteRef.current = sendLiveNote;

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
        // The app ends the call from the spoken closing line; this is acknowledged only.
        logTool({ tool: "finish_session", keys: ["reason"], ok: true, rejected: [], source: "interviewer" });
        sendToolResult(responseId, callId, { ok: true, note: "the app ends the call" });
        return;
      }
      if (name !== "record_answers") {
        logTool({ tool: String(name), keys: [], ok: false, rejected: [], source: "interviewer" });
        sendToolResult(responseId, callId, { ok: false, reason: `unknown function ${name}` });
        return;
      }
      let parsed: RecordInput = {};
      try {
        parsed = JSON.parse(argsText || "{}") as RecordInput;
      } catch {
        logTool({ tool: "record_answers", keys: [], ok: false, rejected: [], source: "interviewer" });
        logError("record_answers", "arguments were not valid JSON");
        sendToolResult(responseId, callId, { ok: false, reason: "arguments were not valid JSON" });
        return;
      }
      const result = handleRecordArgs(parsed, "interviewer");
      sendToolResult(
        responseId,
        callId,
        result ?? { ok: false, captured: [], rejected: [], reason: "the app could not process this call" },
      );
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
        flushEventLog();
        sendLiveNote(
          "Greet the person now in English by first name, in one short sentence, then ask the opening question for section 1. Then pause and listen.",
        );
        return;
      }
      if (type === "session.closed") {
        if (!finishedRef.current && !endingRef.current) void endCallRef.current("dropped");
        return;
      }
      if (type === "error") {
        const err = (event["error"] ?? {}) as Record<string, unknown>;
        logError("live", (err["message"] as string | undefined) ?? err);
        return;
      }
      if (type === "session.input_transcript.delta" && typeof event["delta"] === "string") {
        if (event["delta"].trim() && !endingRef.current) {
          appendTranscript("person", event["delta"]);
          personSpokeRef.current = true;
        }
        return;
      }
      if (type === "session.output_transcript.delta" && typeof event["delta"] === "string") {
        appendTranscript("interviewer", event["delta"]);
        outputTranscriptRef.current = (outputTranscriptRef.current + event["delta"]).slice(-400);
        if (!closingHeardRef.current && CLOSING_LINE.test(outputTranscriptRef.current)) {
          closingHeardRef.current = true;
          const stopping = STOPPING_LINE.test(outputTranscriptRef.current);
          void endCallRef.current(stopping ? "voice_early" : "complete");
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
    callStartMsRef.current = performance.now();
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
      flushEventLog();
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
          const parsed = JSON.parse(e.data as string) as Record<string, unknown>;
          recordEvent(parsed);
          handleServerEvent(parsed);
        } catch (err) {
          logError("event handler", err);
        }
      });

      pc.addEventListener("connectionstatechange", () => {
        if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
          if (!finishedRef.current && !endingRef.current) void endCallRef.current("dropped");
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
      if (result.sessionConfig) setSessionConfig(result.sessionConfig);
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
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      fail("connection", "The call could not connect.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstName, startSession, handleServerEvent, status]);

  // Elapsed timer plus the hard seven-minute cap. Side effects run outside the
  // state updater so React's double-invoked updaters can't repeat them.
  useEffect(() => {
    if (status !== "live") return;
    const id = window.setInterval(() => {
      const next = elapsedRef.current + 1;
      elapsedRef.current = next;
      setElapsed(next);
      flushEventLog();
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
          "Six and a half minutes have passed. Begin the wrap now and keep it brief.",
        );
      }
      if (next === WATCHDOG_SECONDS && !recordedOkRef.current && !watchdogLoggedRef.current) {
        watchdogLoggedRef.current = true;
        setNothingRecordedWarning(true);
        setErrors((p) => [...p, { at: WATCHDOG_SECONDS, where: "watchdog", message: "no successful record_answers" }]);
      }
      if (next % RECORD_INTERVAL_SECONDS === 0 && personSpokeRef.current && !endingRef.current) {
        void runRecordingRef.current("interval");
      }
      if (next >= HARD_CAP_SECONDS) void endCallRef.current("capped");
    }, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    eventLog,
    eventLogDropped,
    sessionConfig,
    nothingRecordedWarning,
    saving,
    start,
    finish: (reason: FinishReason) => void endCallRef.current(reason),
    toggleMute,
  };
}
