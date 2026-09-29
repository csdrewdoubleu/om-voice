import { useState } from "react";

interface Props {
  onStart: (firstName: string) => void;
  busy: boolean;
  notice?: string | null;
}

export function StartScreen({ onStart, busy, notice }: Props) {
  const [name, setName] = useState("");
  const [showTapNote, setShowTapNote] = useState(false);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="label-mono">prototype</div>
      <h1 className="mt-2 text-4xl leading-tight text-ink">Operating Map Voice</h1>

      <label className="mt-10 block">
        <span className="label-mono">First name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="given-name"
          placeholder="Your first name"
          className="mt-2 w-full rounded-lg border border-border bg-cream-deep px-4 py-3 text-base text-ink outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-forest"
        />
      </label>

      <p className="mt-4 text-sm text-muted-foreground">
        About five minutes. Audio is processed live and never saved.
      </p>

      {notice ? (
        <p className="mt-4 rounded-lg border border-terracotta/40 bg-peach px-4 py-3 text-sm text-ink">
          {notice}
        </p>
      ) : null}

      <button
        type="button"
        disabled={busy || name.trim().length === 0}
        onClick={() => onStart(name.trim())}
        className="btn-base btn-primary mt-8 w-full disabled:opacity-50"
      >
        {busy ? "Connecting" : "Talk it through"}
      </button>

      <button
        type="button"
        onClick={() => setShowTapNote(true)}
        className="mt-5 text-sm text-terracotta underline underline-offset-4"
      >
        I can't talk right now
      </button>

      {showTapNote ? (
        <p className="mt-3 text-sm text-muted-foreground">
          The tap version lives in the main app.
        </p>
      ) : null}
    </div>
  );
}
