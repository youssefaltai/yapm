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

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? {} : { "content-type": "application/json", "x-yapm-client": CLIENT_ID },
    body: body === undefined ? null : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
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
  { quiet = false } = {},
): Promise<T> {
  if (!quiet) setWaiting(1);
  const result = await api<{ data?: T; errors?: { message: string }[] }>("/graphql", {
    query,
    variables,
  }).finally(() => {
    if (!quiet) setWaiting(-1);
  });
  if (result.errors?.length)
    throw new ApiError(result.errors.map((e) => e.message).join("\n"), 200);
  if (!result.data) throw new ApiError("Empty response", 200);
  return result.data;
}
