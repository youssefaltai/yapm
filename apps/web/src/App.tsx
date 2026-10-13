import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError, api, session, type Viewer } from "./api.js";
import { Shell } from "./Shell.js";

type State =
  | { screen: "loading" }
  | { screen: "setup" }
  | { screen: "login" }
  | { screen: "home"; viewer: Viewer }
  | { screen: "error"; message: string };

export function App() {
  const [state, setState] = useState<State>({ screen: "loading" });

  const load = useCallback(async () => {
    try {
      const { needsSetup } = await api<{ needsSetup: boolean }>("/api/setup");
      if (needsSetup) return setState({ screen: "setup" });
      const { viewer } = await api<{ viewer: Viewer }>("/api/auth/me");
      setState({ screen: "home", viewer });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return setState({ screen: "login" });
      setState({
        screen: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void load();
    session.onEnd = () => setState({ screen: "login" });
  }, [load]);

  switch (state.screen) {
    case "loading":
      return null;
    case "setup":
      return <SetupScreen onDone={(viewer) => setState({ screen: "home", viewer })} />;
    case "login":
      return <LoginScreen onDone={(viewer) => setState({ screen: "home", viewer })} />;
    case "home":
      return (
        <Shell
          viewer={state.viewer}
          onSignOut={async () => {
            await api("/api/auth/logout", {});
            setState({ screen: "login" });
          }}
        />
      );
    case "error":
      return (
        <Centered>
          <p className="text-muted">Couldn't reach the hub: {state.message}</p>
        </Centered>
      );
  }
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-full items-center justify-center px-4 py-12">{children}</div>;
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <Centered>
      <div className="w-full max-w-sm animate-rise-in">
        <img src="/icon.svg" alt="" className="mb-6 size-10" />
        <h1 className="text-xl font-medium">{title}</h1>
        <p className="mt-1 mb-6 text-muted">{subtitle}</p>
        {children}
      </div>
    </Centered>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="mb-3 block">
      <span className="mb-1.5 block text-muted">{props.label}</span>
      <input
        className="w-full rounded-md border border-line bg-panel px-3 py-2 text-[14px] outline-none placeholder:text-faint focus:border-accent"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        required
      />
    </label>
  );
}

function SubmitButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="mt-2 w-full rounded-md bg-accent px-3 py-2 text-[14px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-60"
    >
      {children}
    </button>
  );
}

function ErrorText({ error }: { error: string | null }) {
  return error ? <p className="mt-3 text-[13px] text-critical">{error}</p> : null;
}

function describe(error: unknown): string {
  if (error instanceof Error && error.name === "NotAllowedError")
    return "Passkey request was cancelled.";
  return error instanceof Error ? error.message : String(error);
}

function SetupScreen({ onDone }: { onDone: (viewer: Viewer) => void }) {
  const [companyName, setCompanyName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: never }>(
        "/api/setup/options",
        // Cycles and rituals follow the owner's clock.
        { companyName, ownerName, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      );
      const response = await startRegistration({ optionsJSON: options });
      const { viewer } = await api<{ viewer: Viewer }>("/api/setup/verify", {
        challengeId,
        response,
      });
      onDone(viewer);
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Start your company"
      subtitle="You're the owner. Your AI employees, led by a CEO, will run the rest."
    >
      <form onSubmit={submit}>
        <Field
          label="Company name"
          value={companyName}
          onChange={setCompanyName}
          placeholder="Acme Life"
        />
        <Field
          label="Your name"
          value={ownerName}
          onChange={setOwnerName}
          placeholder="Your name"
        />
        <SubmitButton busy={busy}>Create passkey and start</SubmitButton>
        <ErrorText error={error} />
      </form>
    </Card>
  );
}

function LoginScreen({ onDone }: { onDone: (viewer: Viewer) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: never }>(
        "/api/auth/login/options",
        {},
      );
      const response = await startAuthentication({ optionsJSON: options });
      const { viewer } = await api<{ viewer: Viewer }>("/api/auth/login/verify", {
        challengeId,
        response,
      });
      onDone(viewer);
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Welcome back" subtitle="Sign in with your passkey.">
      <form onSubmit={submit}>
        <SubmitButton busy={busy}>Sign in with passkey</SubmitButton>
        <ErrorText error={error} />
      </form>
    </Card>
  );
}
