export default function Login({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-dash-page-top to-dash-page-bottom px-4">
      <main className="w-full max-w-sm rounded-xl border border-dash-edge bg-dash-card p-8">
        <p className="text-sm font-semibold uppercase tracking-widest text-dash-teal">Agent Proceed</p>
        <h1 className="mt-2 text-2xl font-bold text-dash-ink">Merchant sign-in</h1>
        <p className="mt-3 text-sm text-dash-body">
          Northwind Outfitters merchant view. This is a demo sign-in: there is no password and no real account.
        </p>
        <button
          type="button"
          onClick={onSignIn}
          className="mt-6 w-full rounded-md bg-dash-teal px-4 py-2.5 text-sm font-bold text-dash-page-bottom hover:opacity-90"
        >
          Sign in as demo merchant
        </button>
        <p className="mt-2 text-xs text-dash-label">Demo merchant — no real auth in hackathon build</p>
      </main>
    </div>
  )
}
