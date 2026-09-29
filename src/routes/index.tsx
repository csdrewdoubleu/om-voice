import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { StartScreen } from "@/components/StartScreen";
import { ConversationScreen } from "@/components/ConversationScreen";
import { ReviewScreen } from "@/components/ReviewScreen";
import { DoneScreen } from "@/components/DoneScreen";
import { useVoiceInterview } from "@/hooks/useVoiceInterview";
import { supabase } from "@/integrations/supabase/client";
import {
  fullFields,
  fullKeyed,
  sectionsCompleted,
  type Confidence,
  type EndedBy,
  type FieldKey,
  type OperatingMap,
  type Quotes,
  type SessionExport,
} from "@/lib/schema";

const REASON_TO_ENDED_BY: Record<string, EndedBy> = {
  complete: "wrap",
  early: "finish_early",
  capped: "cap",
  dropped: "dropped",
};

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Operating Map Voice — spoken intake prototype" },
      {
        name: "description",
        content:
          "A five minute spoken conversation that maps how you work, then hands you an editable summary you can download.",
      },
      { property: "og:title", content: "Operating Map Voice" },
      {
        property: "og:description",
        content:
          "A five minute spoken conversation that maps how you work, then hands you an editable summary you can download.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
  ssr: false,
});

type Screen = "start" | "conversation" | "review" | "done";

const STORAGE_KEY = "operating-map-voice-session";

interface StoredSession {
  firstName: string;
  fields: OperatingMap;
  confidence: Confidence;
  quotes: Quotes;
  startedAt: number;
  durationSeconds: number;
  sessionId?: string;
  endedAt?: number;
  endedBy?: EndedBy;
}

function Index() {
  const [screen, setScreen] = useState<Screen>("start");
  const [firstName, setFirstName] = useState("");
  const [reviewFields, setReviewFields] = useState<OperatingMap>({});
  const [reviewConfidence, setReviewConfidence] = useState<Confidence>({});
  const [reviewQuotes, setReviewQuotes] = useState<Quotes>({});
  const [edited, setEdited] = useState<string[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [startNotice, setStartNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const startedAtRef = useRef<number>(Date.now());
  const endedAtRef = useRef<number | null>(null);
  const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID());
  const [endedBy, setEndedBy] = useState<EndedBy>("dropped");

  const handleFinish = useCallback(
    (reason: "complete" | "dropped" | "capped" | "early") => {
      endedAtRef.current = Date.now();
      setEndedBy(REASON_TO_ENDED_BY[reason] ?? "dropped");
      setBanner(reason === "dropped" ? "The call dropped; here's what we got." : null);
      setScreen("review");
    },
    [],
  );

  const voice = useVoiceInterview({ firstName, onFinish: handleFinish });

  // Restore a refreshed session straight into review.
  useEffect(() => {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const stored = JSON.parse(raw) as StoredSession;
      if (!stored.fields) return;
      setFirstName(stored.firstName ?? "");
      setReviewFields(stored.fields);
      setReviewConfidence(stored.confidence ?? {});
      setReviewQuotes(stored.quotes ?? {});
      setDurationSeconds(stored.durationSeconds ?? 0);
      startedAtRef.current = stored.startedAt ?? Date.now();
      endedAtRef.current = stored.endedAt ?? Date.now();
      if (stored.sessionId) setSessionId(stored.sessionId);
      setEndedBy(stored.endedBy ?? "dropped");
      setScreen("review");
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  // Keep captured answers in sessionStorage while the call runs.
  useEffect(() => {
    if (screen !== "conversation") return;
    const stored: StoredSession = {
      firstName,
      fields: voice.fields,
      confidence: voice.confidence,
      quotes: voice.quotes,
      startedAt: startedAtRef.current,
      durationSeconds: voice.elapsed,
      sessionId,
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  }, [screen, firstName, voice.fields, voice.confidence, voice.quotes, voice.elapsed, sessionId]);

  // Persist the end details once in review so a refresh keeps them.
  useEffect(() => {
    if (screen !== "review") return;
    const stored: StoredSession = {
      firstName,
      fields: reviewFields,
      confidence: reviewConfidence,
      quotes: reviewQuotes,
      startedAt: startedAtRef.current,
      durationSeconds,
      sessionId,
      endedAt: endedAtRef.current ?? Date.now(),
      endedBy,
    };
    if (Object.keys(reviewFields).length) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  }, [screen, firstName, reviewFields, reviewConfidence, reviewQuotes, durationSeconds, sessionId, endedBy]);

  // Carry the live capture into review when the call ends.
  useEffect(() => {
    if (screen !== "review" || voice.status === "idle") return;
    setReviewFields((prev) => (Object.keys(prev).length > 1 ? prev : voice.fields));
    setReviewConfidence((prev) => (Object.keys(prev).length ? prev : voice.confidence));
    setReviewQuotes((prev) => (Object.keys(prev).length ? prev : voice.quotes));
    setDurationSeconds((prev) => prev || voice.elapsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  const handleStart = async (name: string) => {
    setFirstName(name);
    setStartNotice(null);
    startedAtRef.current = Date.now();
    setScreen("conversation");
  };

  // Kick off the call once the conversation screen is mounted with a name.
  useEffect(() => {
    if (screen !== "conversation" || !firstName) return;
    if (voice.status !== "idle") return;
    void voice.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, firstName, voice.status]);

  // Send connection problems back to the start screen with an explanation.
  useEffect(() => {
    if (voice.status !== "error") return;
    if (voice.errorKind === "connection") {
      endedAtRef.current = Date.now();
      setEndedBy("dropped");
      setBanner("The call dropped; here's what we got.");
      setScreen("review");
      return;
    }
    setStartNotice(
      voice.errorKind === "mic"
        ? "Voice needs the microphone. Allow it in your browser, or use the tap version in the main app."
        : voice.errorMessage,
    );
    setScreen("start");
  }, [voice.status, voice.errorKind, voice.errorMessage]);

  const handleChange = (key: FieldKey, value: unknown) => {
    setReviewFields((prev) => ({ ...prev, [key]: value }) as OperatingMap);
    setEdited((prev) => (prev.includes(key) ? prev : [...prev, key]));
  };

  const buildExport = (): SessionExport => ({
    session_id: sessionId,
    first_name: firstName || reviewFields.first_name || "",
    started_at: new Date(startedAtRef.current).toISOString(),
    ended_at: new Date(endedAtRef.current ?? Date.now()).toISOString(),
    duration_seconds: durationSeconds,
    ended_by: endedBy,
    fields: fullFields(reviewFields, firstName),
    confidence: fullKeyed(reviewConfidence),
    quotes: fullKeyed(reviewQuotes as Partial<Record<string, string>>),
    edited_fields: edited,
    sections_completed: sectionsCompleted(reviewFields, endedBy),
  });

  const handleDownload = () => {
    const blob = new Blob([JSON.stringify(buildExport(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `operating-map-${(firstName || "session").toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSave = async () => {
    setSaving(true);
    const x = buildExport();
    const { error } = await supabase.from("voice_sessions").insert({
      id: x.session_id,
      first_name: x.first_name,
      started_at: x.started_at,
      ended_at: x.ended_at,
      duration_seconds: x.duration_seconds,
      ended_by: x.ended_by,
      fields: x.fields as never,
      confidence: x.confidence as never,
      quotes: x.quotes as never,
      edited_fields: x.edited_fields,
      sections_completed: x.sections_completed,
    } as never);
    setSaving(false);
    if (error) {
      setBanner("That did not save. Try again.");
      return;
    }
    sessionStorage.removeItem(STORAGE_KEY);
    setScreen("done");
  };

  const restart = () => {
    sessionStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  };

  if (screen === "start") {
    return <StartScreen onStart={handleStart} busy={false} notice={startNotice} />;
  }

  if (screen === "conversation") {
    return (
      <ConversationScreen
        fields={voice.fields}
        confidence={voice.confidence}
        elapsed={voice.elapsed}
        muted={voice.muted}
        level={voice.level}
        speaker={voice.speaker}
        connecting={voice.status === "connecting"}
        onToggleMute={voice.toggleMute}
        onFinishEarly={() => voice.finish("early")}
      />
    );
  }

  if (screen === "review") {
    return (
      <ReviewScreen
        fields={reviewFields}
        confidence={reviewConfidence}
        quotes={reviewQuotes}
        edited={edited}
        banner={banner}
        saving={saving}
        onChange={handleChange}
        onSave={handleSave}
        onDownload={handleDownload}
      />
    );
  }

  return (
    <DoneScreen
      minutes={Math.max(1, Math.round(durationSeconds / 60))}
      editedCount={edited.length}
      onRestart={restart}
    />
  );
}
