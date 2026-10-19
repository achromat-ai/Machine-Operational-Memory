import { useEffect } from "react";
import AdminAuth from "./AdminAuth";
import ReviewQueue from "./ReviewQueue";
import { useAdminSession } from "./useAdminSession";

/** Keeps this page out of search indexes for as long as it is mounted. */
function useNoIndex(title: string) {
  useEffect(() => {
    const previousTitle = document.title;
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.append(meta);
    document.title = title;
    return () => {
      meta.remove();
      document.title = previousTitle;
    };
  }, [title]);
}

/**
 * The review console. It is not linked from anywhere. Locked, it asks for the key; unlocked, it shows the
 * queue. The key is dropped when the page is hidden or unloaded, on lock, and after ten idle minutes.
 */
export default function AdminPage() {
  const { session, state } = useAdminSession();
  useNoIndex("Review console");

  useEffect(() => {
    const drop = () => session.lock();
    window.addEventListener("pagehide", drop);
    return () => {
      window.removeEventListener("pagehide", drop);
      session.lock();
    };
  }, [session]);

  // Any interaction keeps the session alive; silence for ten minutes drops the key.
  useEffect(() => {
    if (state.status !== "unlocked") return;
    const touch = () => session.touch();
    window.addEventListener("pointerdown", touch);
    window.addEventListener("keydown", touch);
    return () => {
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
    };
  }, [session, state.status]);

  if (state.status === "locked" || state.agentKeyHex === null) {
    return (
      <section aria-labelledby="console-heading" className="space-y-4">
        <h2 id="console-heading" className="text-xl font-semibold tracking-tight text-slate-900">
          Review console
        </h2>
        <AdminAuth session={session} />
      </section>
    );
  }

  return (
    <section aria-labelledby="console-heading" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="console-heading" className="text-xl font-semibold tracking-tight text-slate-900">
          Review console
        </h2>
        <div className="flex items-center gap-4 text-sm text-slate-700">
          <span>
            Key <code className="font-mono">{state.fingerprint}</code>
          </span>
          <button
            type="button"
            onClick={() => session.lock()}
            className="rounded-md border border-slate-400 bg-white px-3 py-1.5 font-semibold text-slate-900 hover:bg-slate-100 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900"
          >
            Lock
          </button>
        </div>
      </div>
      <ReviewQueue session={session} agentKeyHex={state.agentKeyHex} />
    </section>
  );
}
