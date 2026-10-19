import { useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { AdminAuthError, type AdminSession } from "../../lib/adminSession";
import { PemError } from "../../lib/pem";

/** A PKCS#8 Ed25519 PEM is about 120 bytes. Anything much larger is not a key. */
const MAX_KEY_FILE_BYTES = 4096;

function messageFor(error: unknown): string {
  if (error instanceof PemError || error instanceof AdminAuthError) return error.message;
  return "The key could not be checked. Check your connection and try again.";
}

/**
 * Takes the operator's key as PEM text or a file and hands it to the session, which keeps only a
 * non-extractable signer in memory. The field is uncontrolled and emptied before anything is awaited, so
 * the PEM is never held in React state. When the session unlocks, the parent unmounts this form.
 */
export default function AdminAuth({ session }: { session: AdminSession }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyId = useId();
  const hintId = useId();
  const errorId = useId();

  async function unlock(pem: string) {
    setBusy(true);
    setError(null);
    try {
      await session.unlock(pem);
    } catch (failure) {
      setError(messageFor(failure));
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const field = area.current;
    if (busy || !field) return;
    const pem = field.value;
    field.value = "";
    if (pem.trim() === "") {
      setError("Paste the key first.");
      return;
    }
    void unlock(pem);
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file || busy) return;
    if (file.size > MAX_KEY_FILE_BYTES) {
      setError("That file is too large to be a key.");
      return;
    }
    await unlock(await file.text());
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Unlock the console" className="max-w-xl space-y-4">
      <div>
        <label htmlFor={keyId} className="block text-sm font-semibold text-slate-900">
          Private key (PEM)
        </label>
        <textarea
          id={keyId}
          ref={area}
          name="key"
          rows={6}
          defaultValue=""
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"}
          aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
          aria-invalid={error ? true : undefined}
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 placeholder:text-slate-500 focus:border-slate-900 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 aria-[invalid=true]:border-blocked"
        />
        <p id={hintId} className="mt-1 text-sm text-slate-600">
          The key is used in this tab only. It is cleared from this box as soon as you submit, never saved, and forgotten when you lock the console, stay idle for ten minutes or close the tab.
        </p>
        {error ? (
          <p id={errorId} role="alert" className="mt-2 text-sm font-medium text-blocked">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={busy}
          aria-busy={busy}
          className="rounded-md bg-slate-900 px-5 py-2.5 text-base font-semibold text-white hover:bg-slate-700 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 disabled:cursor-not-allowed disabled:bg-slate-500"
        >
          {busy ? "Checking…" : "Unlock"}
        </button>
        <label className="cursor-pointer text-sm font-medium text-slate-900 underline decoration-slate-400 underline-offset-4 hover:decoration-slate-900">
          Choose a key file instead
          <input type="file" accept=".pem,.key,text/plain" onChange={(event) => void chooseFile(event)} disabled={busy} className="sr-only" />
        </label>
      </div>
    </form>
  );
}
