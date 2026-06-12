import type { ReactNode } from "react";

interface PageShellProps {
  children: ReactNode;
  variant?: "host" | "guest";
}

export function PageShell({ children, variant = "host" }: PageShellProps) {
  const isGuest = variant === "guest";

  return (
    <div
      className={`mx-auto flex min-h-screen w-full flex-col px-4 py-6 sm:px-6 sm:py-8 ${
        isGuest ? "max-w-md" : "max-w-3xl"
      }`}
    >
      <header className="rise mb-8 sm:mb-12">
        <div className="flex items-center gap-4">
          <p className="text-2xl tracking-tight text-ink sm:text-3xl">
            <span className="font-display italic">Boomer</span>
            <span className="font-semibold">Drop</span>
          </p>
        </div>

        <div className="mt-10 text-center sm:mt-14">
          <h1 className="text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            {isGuest ? (
              <>
                Catch files on{" "}
                <em className="font-display font-normal italic">this phone</em>
              </>
            ) : (
              <>
                Send files to your{" "}
                <em className="font-display font-normal italic">phone</em>
              </>
            )}
          </h1>
          <p className="mx-auto mt-3 max-w-md text-base text-ink-soft sm:text-lg">
            {isGuest
              ? "Check that the code below matches the one on the computer."
              : "Scan the code with your phone, match the code, and drop your files."}
          </p>
        </div>
      </header>

      <main className="rise-1 flex-1">{children}</main>

      <footer className="rise-2 mt-10 text-center">
        <p className="text-xs text-ink-faint">
          Peer-to-peer and encrypted — files travel device to device, nothing
          is stored.
        </p>
      </footer>
    </div>
  );
}
