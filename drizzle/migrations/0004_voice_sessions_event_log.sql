ALTER TABLE public.voice_sessions
  ADD COLUMN IF NOT EXISTS event_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS event_log_dropped integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS session_config jsonb;