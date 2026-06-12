interface VerificationBadgeProps {
  code: string;
  layout?: "side" | "center";
}

export function VerificationBadge({
  code,
  layout = "side",
}: VerificationBadgeProps) {
  return (
    <div className="flex flex-col items-center justify-center p-6 text-center sm:p-8">
      <p className="mb-5 text-xl font-semibold text-ink">
        Match this code
      </p>
      <div
        className="flex gap-2.5"
        role="img"
        aria-label={`Code ${code.split("").join(" ")}`}
      >
        {code.split("").map((char, index) => (
          <span
            key={index}
            className="flex h-16 w-13 items-center justify-center rounded-2xl border border-line bg-white text-3xl font-semibold tracking-tight text-ink shadow-[0_6px_16px_-6px_rgba(16,24,40,0.16)] sm:h-[4.5rem] sm:w-14 sm:text-4xl"
            aria-hidden
          >
            {char}
          </span>
        ))}
      </div>
      <p className="mt-5 max-w-[240px] text-sm text-ink-faint">
        The same four characters must appear on both screens.
      </p>
    </div>
  );
}
