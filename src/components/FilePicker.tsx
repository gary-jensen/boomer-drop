"use client";

import { useCallback, useRef, useState } from "react";

interface FilePickerProps {
  onSend: (files: File[]) => void;
  disabled?: boolean;
  sending?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function FilePicker({ onSend, disabled, sending }: FilePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const addFiles = useCallback((fileList: FileList | null) => {
    if (!fileList?.length) return;
    setSelected((prev) => [...prev, ...Array.from(fileList)]);
  }, []);

  const removeFile = (index: number) => {
    setSelected((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSend = () => {
    if (!selected.length || disabled || sending) return;
    onSend(selected);
    setSelected([]);
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          addFiles(event.dataTransfer.files);
        }}
        className={`flex min-h-[140px] cursor-pointer flex-col items-center justify-center rounded-3xl border border-dashed px-4 py-9 text-center transition-all ${
          dragOver
            ? "border-accent bg-accent/5"
            : "border-ink/20 bg-white/50 hover:border-ink/40 hover:bg-white"
        }`}
      >
        <p className="font-display text-xl text-ink">Tap to choose files</p>
        <p className="mt-1 text-sm text-ink-faint">
          Or drag and drop — any size
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => addFiles(event.target.files)}
        />
      </div>

      {selected.length > 0 ? (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white">
          {selected.map((file, index) => (
            <li
              key={`${file.name}-${file.size}-${file.lastModified}`}
              className="flex items-center gap-3 px-4 py-3"
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                {file.name}
              </span>
              <span className="shrink-0 text-xs text-ink-faint">
                {formatSize(file.size)}
              </span>
              <button
                type="button"
                onClick={() => removeFile(index)}
                className="shrink-0 text-xs font-semibold text-ink-faint transition-colors hover:text-error"
                aria-label={`Remove ${file.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <button
        type="button"
        onClick={handleSend}
        disabled={!selected.length || disabled || sending}
        className={`btn !min-h-[3.5rem] text-base ${
          selected.length && !sending
            ? "!bg-accent hover:!bg-[#1a68e0] !shadow-[0_2px_4px_rgba(47,124,246,0.25),0_12px_24px_-8px_rgba(47,124,246,0.45)]"
            : ""
        }`}
      >
        {sending
          ? "Sending…"
          : selected.length
            ? `Send ${selected.length} file${selected.length === 1 ? "" : "s"}`
            : "Send files"}
      </button>
    </div>
  );
}
