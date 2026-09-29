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
- Two prompts in `src/lib/prompt.ts`: a live voice prompt (no tool mechanics) and a backend extractor prompt that owns `record_answers`/`finish_session`.
- Tool calls arrive nested in `response.event`; the client replies with `response.item.create` and continues with `response.create` after the backend response completes.
