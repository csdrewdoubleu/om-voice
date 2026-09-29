interface Props {
  minutes: number;
  editedCount: number;
  onRestart: () => void;
}

export function DoneScreen({ minutes, editedCount, onRestart }: Props) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="label-mono">done</div>
      <h1 className="mt-2 text-3xl leading-tight text-ink">
        Saved. Session {minutes} minutes, {editedCount} fields edited on review.
      </h1>
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
