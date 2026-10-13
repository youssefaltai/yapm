export interface Viewer {
  id: string;
  name: string;
  displayName: string;
  kind: "owner" | "agent";
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Identifies this tab, so live updates can skip the echo of its own changes. */
export const CLIENT_ID = crypto.randomUUID();

/** Called when the session has ended, like after it expires, so the app can ask to sign in. */
export const session = { onEnd: () => {} };

export async function api<T>(
  path: string,
  body?: unknown,
  /** Lets the request finish after the page closes, for a last save. */
  { keepalive = false } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? {} : { "content-type": "application/json", "x-yapm-client": CLIENT_ID },
    body: body === undefined ? null : JSON.stringify(body),
    credentials: "same-origin",
    keepalive,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (response.status === 401 && !path.startsWith("/api/auth/")) session.onEnd();
  if (!response.ok) throw new ApiError(data.error ?? response.statusText, response.status);
  return data;
}

// How many requests the owner is waiting on, for the loading bar. Background refetches and
// optimistic changes pass `quiet`, since there's nothing to wait for.
let waiting = 0;
const waitingListeners = new Set<() => void>();
const setWaiting = (change: number) => {
  waiting += change;
  for (const listener of waitingListeners) listener();
};
export const waitingStore = {
  get: () => waiting > 0,
  subscribe(listener: () => void) {
    waitingListeners.add(listener);
    return () => {
      waitingListeners.delete(listener);
    };
  },
};

export async function graphql<T>(
  query: string,
  variables?: Record<string, unknown>,
  { quiet = false, keepalive = false } = {},
): Promise<T> {
  if (!quiet) setWaiting(1);
  const result = await api<{
    data?: T;
    errors?: { message: string; extensions?: { code?: string } }[];
  }>("/graphql", { query, variables }, { keepalive }).finally(() => {
    if (!quiet) setWaiting(-1);
  });
  // GraphQL answers 200 even when signed out, and says so in the error.
  if (result.errors?.some((e) => e.extensions?.code === "UNAUTHENTICATED")) session.onEnd();
  if (result.errors?.length)
    throw new ApiError(result.errors.map((e) => e.message).join("\n"), 200);
  if (!result.data) throw new ApiError("Empty response", 200);
  return result.data;
}
