<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture
- Voice uses OpenAI GPT-Live (`gpt-live-1`) with Responses delegation; the server fn `src/lib/live.functions.ts` does the SDP exchange at `POST /v1/live/sessions` so the API key never reaches the browser.
- Recording is app-driven: `recordFromTranscript` in `src/lib/live.functions.ts` sends the client-kept transcript to the backend model every 30s (if the person spoke) and once at call end, one request at a time; the interviewer never hands off and the call ends when the app hears a fixed spoken line containing "next screen". Why: the interviewer handed off in under half of test runs.
- Two prompts in `src/lib/prompt.ts`: a live voice prompt (no tool mechanics, fixed closing/stopping lines) and a backend extractor prompt that re-reads the whole conversation each request.
- Tool calls arrive nested in `response.event`; the client replies with `response.item.create` and continues with `response.create` after the backend response completes.
- Every received session event goes through describeEvent in useVoiceInterview.ts into event_log (capped, streaming deltas folded, no words/audio/keys); the server fn returns a key-free session_config summary. Why: recording failures must be diagnosable from the export alone.
- Notes to the interviewer (status, play-back, time) are held and sent only when the interviewer finishes a spoken turn (turnStep in useVoiceInterview.ts), newest per kind; a 4s stall guard nudges via session.instructions.append. Why: notes landing mid-speech or in the reply gap caused 8-12s stalls.
