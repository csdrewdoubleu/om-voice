# OM-Voice

**Status: working prototype (not production).** Built September to October 2026 by Drew Williams at [Cascade Studios](https://cascadestudios.co), with Lovable as the build agent and Claude for the interview script, the extraction schema, and the review passes.

OM-Voice is the voice front end for [Operating Map](https://github.com/csdrewdoubleu/screen-repro-magic). Instead of filling in a five-section survey, a person has a five-minute spoken conversation with an interviewer that asks about their role, the tools they use, how to reach them, their working style, and who they hand work to. While they talk, a second model listens to the transcript and fills in the same structured profile the survey would produce. The person then reviews and edits the answers on screen and can download them as JSON. The two apps are not yet integrated; this one writes to its own `voice_sessions` table.

## How it works

1. **Start screen**: first name, then microphone permission.
2. **Live conversation**: the browser opens a WebRTC session with OpenAI's Live API (`POST /v1/live/sessions`) through a TanStack Start server function, so the API key never reaches the client. The interviewer model gets a script-style prompt (`src/lib/prompt.ts`): one question at a time, short reactions, no scales read aloud, and fixed closing and stopping lines that the app listens for to end the call. Sessions are capped at seven minutes and 40 conversations a day.
3. **Background extraction**: at intervals the app sends the transcript so far to a Responses-API model with a single tool, `record_answers`, forced via `tool_choice`. The tool's arguments are the structured profile: allowed values only, a confidence per field, and short verbatim quotes for free-text fields. The interviewer is told what is still missing through notes, not the other way round, so the voice never records anything itself.
4. **Review screen**: every captured field is editable; edits are tracked separately from the model's values.
5. **Done**: the session, fields, confidence, quotes, edited fields, an event log, and an estimated cost are saved to Supabase, and the JSON can be downloaded.

## Stack

- TanStack Start (React 19), TypeScript, Vite, Tailwind 4, shadcn/ui
- OpenAI Live API over WebRTC for the conversation; OpenAI Responses API with tool calling for extraction
- Supabase (Postgres) with Drizzle ORM and migrations in `drizzle/`
- Hosted on Lovable; two-way synced with this repo

Key files:

- `src/lib/live.functions.ts`: server functions that create the live session and run extraction
- `src/lib/prompt.ts`: the interviewer and extraction prompts
- `src/lib/schema.ts`: allowed values, score poles, and the tool definitions
- `src/hooks/useVoiceInterview.ts`: client-side session state, transcript, and timing
- `drizzle/schema.ts`, `drizzle/migrations/`: the `voice_sessions` table and its five migrations

## Running locally

```sh
npm i
npm run dev
```

Set `OPENAI_API_KEY` as a server-side secret (in Lovable: Settings → Secrets). The `.env` in this repo holds only the Supabase project URL and **publishable** key, which are safe to expose by design.

## Known limitations

- Prototype access model: anonymous inserts into `voice_sessions` are allowed; there is no authentication.
- Not yet connected to Operating Map; the output shape matches, the write path does not.
- Tested in real spoken sessions on a desktop browser; mobile and noisy-room behavior not yet checked.

## How it was built

The interview script and the extraction schema were written first as documents, then handed to Lovable to implement against the OpenAI APIs. Each round after that was a written change brief, an agent build, and a review of the diff. See `AGENTS.md` for the conventions the agent follows in this repo.
