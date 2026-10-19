import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";

export interface CopyButtonProps {
  /** The text that goes on the clipboard. */
  text: string;
  /** What the button says before it is pressed. */
  label: string;
  /** What it says afterwards, and what is announced. */
  copiedLabel?: string;
  className?: string;
}

const RESET_MS = 2200;

/**
 * Copies `text` with one click. Uses the async clipboard API where the browser allows it. If it does not
 * (older browser, insecure context, permission refused) the text is shown selected in a read-only field, so
 * the visitor can still copy it by hand. The result is announced through a polite live region.
 */
export default function CopyButton({ text, label, copiedLabel = "Copied", className = "" }: CopyButtonProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "manual">("idle");
  const timer = useRef<number | undefined>(undefined);
  const field = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (status === "manual") field.current?.select();
  }, [status]);

  async function copy() {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
      timer.current = window.setTimeout(() => setStatus("idle"), RESET_MS);
    } catch {
      setStatus("manual");
    }
  }

  return (
    <div className="inline-flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={copy}
        className={`inline-flex min-h-11 items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 ${className}`}
      >
        {status === "copied" ? <CheckIcon /> : <CopyIcon />}
        <span>{status === "copied" ? copiedLabel : label}</span>
      </button>
      <span role="status" className="sr-only">
        {status === "copied" ? copiedLabel : ""}
      </span>
      {status === "manual" ? (
        <label className="block w-full max-w-md text-xs text-slate-700">
          Copy this text yourself:
          <input
            ref={field}
            readOnly
            value={text}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs text-slate-900"
          />
        </label>
      ) : null}
    </div>
  );
}
