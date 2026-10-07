ALTER TABLE public.voice_sessions
  ADD COLUMN IF NOT EXISTS tool_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS errors jsonb NOT NULL DEFAULT '[]'::jsonb;