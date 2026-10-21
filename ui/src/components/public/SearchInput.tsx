import { useId, useRef, useState, type FormEvent } from "react";
import { DOMAINS, validateSearchForm, type FieldErrors, type FieldName, type RecallPayload, type SearchFormValues } from "../../lib/recall";

export interface SearchInputProps {
  /** Receives a validated request body. The page sends it with signedFetch (see useRecall). */
  onSearch: (payload: RecallPayload) => void | Promise<void>;
  /** A search is running: the button is disabled. */
  busy: boolean;
  /** Field errors reported by the server, shown next to the local ones. */
  serverErrors?: FieldErrors;
}

const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  fintech: "Fintech and banking",
  industrial_iot: "Industrial IoT",
  robotics: "Robotics",
  devsecops: "DevSecOps",
};

const INITIAL: SearchFormValues = { domain: DOMAINS[0], tool: "", taskDescription: "", argumentsJson: "" };

const FIELD =
  "mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 placeholder:text-slate-500 focus:border-slate-900 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 aria-[invalid=true]:border-blocked";

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-sm font-medium text-blocked">
      {message}
    </p>
  );
}

/**
 * The search form. Recall is a structured lookup, so it asks for the four things the service matches on:
 * the domain, the exact tool name, a plain-language description of the task (matched exactly and then by
 * meaning) and the arguments the call would use (only their key names are compared).
 */
export default function SearchInput({ onSearch, busy, serverErrors }: SearchInputProps) {
  const [values, setValues] = useState<SearchFormValues>(INITIAL);
  const [localErrors, setLocalErrors] = useState<FieldErrors>({});
  const ids = { domain: useId(), tool: useId(), task: useId(), args: useId() };
  const domainRef = useRef<HTMLSelectElement>(null);
  const toolRef = useRef<HTMLInputElement>(null);
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const argumentsRef = useRef<HTMLTextAreaElement>(null);
  const errors: FieldErrors = { ...serverErrors, ...localErrors };

  const set = <K extends keyof SearchFormValues>(key: K, value: SearchFormValues[K]) => setValues((current) => ({ ...current, [key]: value }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const result = validateSearchForm(values);
    if (!result.ok) {
      setLocalErrors(result.errors);
      // Focus the first field that needs attention.
      const order: Array<[FieldName, { current: HTMLElement | null }]> = [
        ["domain", domainRef],
        ["tool", toolRef],
        ["taskDescription", taskRef],
        ["arguments", argumentsRef],
      ];
      order.find(([field]) => result.errors[field] !== undefined)?.[1].current?.focus();
      return;
    }
    setLocalErrors({});
    void onSearch(result.payload);
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Simulate a recall" className="space-y-5">
      <div>
        <label htmlFor={ids.domain} className="block text-sm font-semibold text-slate-900">
          Domain
        </label>
        <select
          id={ids.domain}
          ref={domainRef}
          value={values.domain}
          onChange={(event) => set("domain", event.target.value)}
          aria-invalid={errors.domain ? true : undefined}
          aria-describedby={errors.domain ? `${ids.domain}-error` : undefined}
          className={FIELD}
        >
          {DOMAINS.map((domain) => (
            <option key={domain} value={domain}>
              {DOMAIN_LABELS[domain] ?? domain}
            </option>
          ))}
        </select>
        <FieldError id={`${ids.domain}-error`} message={errors.domain} />
      </div>

      <div>
        <label htmlFor={ids.tool} className="block text-sm font-semibold text-slate-900">
          Tool name
        </label>
        <input
          id={ids.tool}
          ref={toolRef}
          type="text"
          value={values.tool}
          onChange={(event) => set("tool", event.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="transfer_funds"
          aria-invalid={errors.tool ? true : undefined}
          aria-describedby={`${ids.tool}-hint${errors.tool ? ` ${ids.tool}-error` : ""}`}
          className={`${FIELD} font-mono`}
        />
        <p id={`${ids.tool}-hint`} className="mt-1 text-sm text-slate-600">
          The exact name your agent calls. Lessons are matched to one tool only.
        </p>
        <FieldError id={`${ids.tool}-error`} message={errors.tool} />
      </div>

      <div>
        <label htmlFor={ids.task} className="block text-sm font-semibold text-slate-900">
          What are you trying to do?
        </label>
        <textarea
          id={ids.task}
          ref={taskRef}
          rows={2}
          value={values.taskDescription}
          onChange={(event) => set("taskDescription", event.target.value)}
          placeholder="Move client funds to the settlement account for the March batch"
          aria-invalid={errors.taskDescription ? true : undefined}
          aria-describedby={`${ids.task}-hint${errors.taskDescription ? ` ${ids.task}-error` : ""}`}
          className={FIELD}
        />
        <p id={`${ids.task}-hint`} className="mt-1 text-sm text-slate-600">
          Say what the call is for, in plain words and without amounts, dates or names. The same wording finds an exact match; similar wording finds similar lessons.
        </p>
        <FieldError id={`${ids.task}-error`} message={errors.taskDescription} />
      </div>

      <div>
        <label htmlFor={ids.args} className="block text-sm font-semibold text-slate-900">
          Arguments of the call (JSON)
        </label>
        <textarea
          id={ids.args}
          ref={argumentsRef}
          rows={6}
          value={values.argumentsJson}
          onChange={(event) => set("argumentsJson", event.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={'{\n  "amount": 50000,\n  "currency": "GBP"\n}'}
          aria-invalid={errors.arguments ? true : undefined}
          aria-describedby={`${ids.args}-hint${errors.arguments ? ` ${ids.args}-error` : ""}`}
          className={`${FIELD} font-mono text-sm`}
        />
        <p id={`${ids.args}-hint`} className="mt-1 text-sm text-slate-600">
          Only the key names are used to find similar lessons. Do not paste secrets or personal data. This is also what the fix is compared with.
        </p>
        <FieldError id={`${ids.args}-error`} message={errors.arguments} />
      </div>

      <button
        type="submit"
        disabled={busy}
        aria-busy={busy}
        className="inline-flex items-center rounded-md bg-slate-900 px-5 py-2.5 text-base font-semibold text-white hover:bg-slate-700 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 disabled:cursor-not-allowed disabled:bg-slate-500"
      >
        {busy ? "Searching…" : "Search lessons"}
      </button>
    </form>
  );
}
