import { lazy, Suspense, type ReactNode } from "react";
import PublicPage from "./components/public/PublicPage";
import SiteFooter from "./components/public/SiteFooter";
import SiteHeader from "./components/public/SiteHeader";
import { resolveRoute } from "./lib/router";

// Loaded only when that path is visited, so the public bundle carries none of its code.
const AdminPage = lazy(() => import("./components/admin/AdminPage"));

/** The frame every page shares. The home page brings its own full-width hero, so it manages its own padding. */
function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-30 focus:rounded focus:bg-slate-900 focus:px-3 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  )
}

/** Pages other than the home page: a padded column and a (hidden) page title. */
function Page({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="sr-only">Achromat MOM</h1>
      {children}
    </div>
  )
}

function NotFound() {
  return (
    <section aria-labelledby="missing-heading">
      <h2 id="missing-heading" className="text-xl font-semibold tracking-tight text-slate-900">
        Page not found
      </h2>
      <p className="mt-2 text-base text-slate-700">
        <a href="/" className="font-medium underline underline-offset-4">
          Back to the feed
        </a>
      </p>
    </section>
  )
}

function App() {
  const route = resolveRoute(window.location.pathname)
  return (
    <Layout>
      {route.name === "home" ? <PublicPage /> : null}
      {route.name === "review" ? (
        <Page>
          <Suspense fallback={<p role="status" className="text-sm text-slate-700">Loading…</p>}>
            <AdminPage />
          </Suspense>
        </Page>
      ) : null}
      {route.name === "not-found" ? (
        <Page>
          <NotFound />
        </Page>
      ) : null}
    </Layout>
  )
}

export default App
