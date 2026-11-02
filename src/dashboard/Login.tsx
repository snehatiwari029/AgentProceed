import { AgentProceedLogo } from '../shared/brand/Logo'

export default function Login({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-b from-dash-page-top to-dash-page-bottom px-4">
      <div aria-hidden="true" className="dash-glow left-[-8rem] top-[-6rem] h-[24rem] w-[24rem] bg-dash-purple/45" />
      <div aria-hidden="true" className="dash-glow bottom-[-8rem] right-[-6rem] h-[22rem] w-[22rem] bg-dash-teal/20" />
      <main className="dash-glass relative z-10 w-full max-w-sm rounded-2xl p-8">
        <p><AgentProceedLogo variant="dark" size={28} /></p>
        <h1 className="mt-2 text-2xl font-bold text-dash-ink">Merchant sign-in</h1>
        <p className="mt-3 text-sm text-dash-body">
          Northwind Outfitters merchant view. This is a demo sign-in: there is no password and no real account.
        </p>
        <button
          type="button"
          onClick={onSignIn}
          className="mt-6 w-full rounded-full bg-dash-teal px-4 py-2.5 text-sm font-bold text-dash-page-bottom hover:opacity-90"
        >
          Sign in as demo merchant
        </button>
        <p className="mt-2 text-xs text-dash-label">Demo merchant — no real auth in hackathon build</p>
      </main>
    </div>
  )
}
