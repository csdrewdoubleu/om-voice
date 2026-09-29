CREATE TABLE public.voice_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  quotes JSONB NOT NULL DEFAULT '{}'::jsonb,
  edited_fields TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT INSERT ON public.voice_sessions TO anon;
GRANT INSERT ON public.voice_sessions TO authenticated;
GRANT ALL ON public.voice_sessions TO service_role;

ALTER TABLE public.voice_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert a voice session"
  ON public.voice_sessions
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE INDEX voice_sessions_created_at_idx ON public.voice_sessions (created_at DESC);