interface Props {
  minutes: number;
  editedCount: number;
  cost: number;
  onRestart: () => void;
}

export function DoneScreen({ minutes, editedCount, cost, onRestart }: Props) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="label-mono">done</div>
      <h1 className="mt-2 text-3xl leading-tight text-ink">
        Saved. Session {minutes} minutes, {editedCount} fields edited on review.
      </h1>
      <p className="mt-3 font-mono text-sm text-muted-foreground">
        Session cost: ${cost.toFixed(2)} (voice only)
      </p>
      <button
        type="button"
        onClick={onRestart}
        className="mt-8 self-start text-sm text-terracotta underline underline-offset-4"
      >
        Start again
      </button>
    </div>
  );
}
