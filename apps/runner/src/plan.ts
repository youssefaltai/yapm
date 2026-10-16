import type {
  AccountInfo,
  SDKControlGetUsageResponse,
  SDKRateLimitInfo,
} from "@anthropic-ai/claude-agent-sdk";

// What this machine's Claude login says about its plan. Claude Code knows how full each usage
// window is (as a percentage) and when it resets, but not the window's size in tokens, so the
// runner passes on percentages and reset times and nothing it would have to guess.

export interface ClaudeAccount {
  email: string | null;
  organization: string | null;
  subscriptionType: string | null;
  apiProvider: string | null;
}

export interface PlanLimit {
  kind: string;
  label: string;
  /** Percent of the window used, 0–100. */
  utilization: number | null;
  /** Epoch ms. */
  resetsAt: number | null;
  status: string | null;
}

export interface PlanUsage {
  observedAt: number;
  /** The login (its email) the reading was taken on; another login's reading is never used. */
  account?: string | null;
  source: "usage" | "rate_limit";
  available: boolean;
  limits: PlanLimit[];
  extraUsage: {
    enabled: boolean;
    monthlyLimit: number | null;
    usedCredits: number | null;
    utilization: number | null;
    currency: string | null;
  } | null;
}

/** A plan OpenCode runs on, as its provider's responses describe it. */
export interface OpencodePlan {
  provider: "chatgpt" | "copilot";
  /** plus, pro…, when the provider says. */
  name: string | null;
  usage: PlanUsage;
}

/** Something a session or a probe learned about the plan. */
export type PlanUpdate =
  /** Null when Claude Code isn't signed in. */
  | { account: ClaudeAccount | null }
  | { usage: PlanUsage }
  | { rateLimit: SDKRateLimitInfo }
  | { plan: OpencodePlan };

const LABELS: Record<string, string> = {
  five_hour: "Current session (5 hours)",
  seven_day: "This week, all models",
  seven_day_opus: "This week, Opus",
  seven_day_sonnet: "This week, Sonnet",
  seven_day_oauth_apps: "This week, apps",
  seven_day_overage_included: "This week, with extra usage",
  overage: "Extra usage",
};
const WINDOWS = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_oauth_apps",
] as const;

const time = (iso: string | null | undefined) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** The login Claude Code uses; null when it's signed out (no token, key or cloud login). */
export function accountFrom(info: AccountInfo): ClaudeAccount | null {
  const signedIn =
    info.email ||
    info.subscriptionType ||
    info.apiKeySource ||
    (info.tokenSource && info.tokenSource !== "none") ||
    (info.apiProvider && info.apiProvider !== "firstParty");
  if (!signedIn) return null;
  return {
    email: info.email ?? null,
    organization: info.organization ?? null,
    subscriptionType: info.subscriptionType ?? null,
    apiProvider: info.apiProvider ?? null,
  };
}

/** A full reading from Claude Code's /usage. */
export function usageFrom(response: SDKControlGetUsageResponse, at: number): PlanUsage {
  const limits: PlanLimit[] = [];
  const windows = response.rate_limits;
  for (const kind of WINDOWS) {
    const window = windows?.[kind];
    if (!window) continue;
    limits.push({
      kind,
      label: LABELS[kind] ?? kind,
      utilization: window.utilization,
      resetsAt: time(window.resets_at),
      status: null,
    });
  }
  for (const scoped of windows?.model_scoped ?? []) {
    limits.push({
      kind: `model:${scoped.display_name}`,
      label: `This week, ${scoped.display_name}`,
      utilization: scoped.utilization,
      resetsAt: time(scoped.resets_at),
      status: null,
    });
  }
  const extra = windows?.extra_usage;
  return {
    observedAt: at,
    source: "usage",
    available: response.rate_limits_available && windows !== null,
    limits,
    extraUsage: extra
      ? {
          enabled: extra.is_enabled,
          monthlyLimit: extra.monthly_limit,
          usedCredits: extra.used_credits,
          utilization: extra.utilization,
          currency: extra.currency ?? null,
        }
      : null,
  };
}

/**
 * Folds a rate-limit event from a session into the last reading. Events carry one window at a
 * time, with utilization as a fraction and the reset in epoch seconds.
 */
export function applyRateLimit(
  current: PlanUsage | null,
  info: SDKRateLimitInfo,
  at: number,
): PlanUsage | null {
  const kind = info.rateLimitType;
  if (!kind) return current;
  const before = current?.limits.find((l) => l.kind === kind);
  const utilization =
    typeof info.utilization === "number"
      ? Math.round((info.utilization <= 1 ? info.utilization * 100 : info.utilization) * 10) / 10
      : (before?.utilization ?? null);
  const limit: PlanLimit = {
    kind,
    label: LABELS[kind] ?? kind,
    utilization,
    resetsAt: typeof info.resetsAt === "number" ? info.resetsAt * 1000 : (before?.resetsAt ?? null),
    status: info.status,
  };
  const limits = current?.limits.filter((l) => l.kind !== kind) ?? [];
  const index = current?.limits.findIndex((l) => l.kind === kind) ?? -1;
  limits.splice(index >= 0 ? index : limits.length, 0, limit);
  return {
    observedAt: at,
    source: current?.source ?? "rate_limit",
    available: true,
    limits,
    extraUsage: current?.extraUsage ?? null,
  };
}

const number = (value: string | undefined) => {
  const n = value?.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const CHATGPT_WINDOWS: Record<number, [string, string]> = {
  300: ["five_hour", "Current session (5 hours)"],
  10080: ["seven_day", "This week"],
};

/**
 * A plan from the rate-limit headers on a ChatGPT (Codex) or Copilot response; OpenCode's
 * plugin passes them on, and nothing else, so no sign-in or extra call is involved.
 */
export function planFromHeaders(headers: Record<string, string>, at: number): OpencodePlan | null {
  const usage = (limits: PlanLimit[]): PlanUsage => ({
    observedAt: at,
    source: "rate_limit",
    available: true,
    limits,
    extraUsage: null,
  });
  if (Object.keys(headers).some((h) => h.startsWith("x-codex-"))) {
    const limits: PlanLimit[] = [];
    for (const window of ["primary", "secondary"]) {
      const used = number(headers[`x-codex-${window}-used-percent`]);
      const minutes = number(headers[`x-codex-${window}-window-minutes`]);
      const reset = number(headers[`x-codex-${window}-reset-at`]);
      if (used === null && minutes === null && reset === null) continue;
      const [kind, label] = CHATGPT_WINDOWS[minutes ?? 0] ?? [
        minutes === null ? window : `window:${minutes}`,
        minutes === null ? window : `${minutes} minutes`,
      ];
      limits.push({
        kind,
        label,
        utilization: used,
        resetsAt: reset === null ? null : reset * 1000,
        status: null,
      });
    }
    return {
      provider: "chatgpt",
      name: headers["x-codex-plan-type"] ?? null,
      usage: usage(limits),
    };
  }
  // Copilot's premium requests, as `ent=300&rem=72.5&rst=<date>`; `ent=-1` is unlimited.
  const snapshot =
    headers["x-quota-snapshot-premium_models"] ?? headers["x-quota-snapshot-premium_interactions"];
  if (snapshot === undefined) return null;
  const quota = new URLSearchParams(snapshot);
  const remaining = number(quota.get("rem") ?? undefined);
  const limits: PlanLimit[] =
    quota.get("ent") === "-1"
      ? []
      : [
          {
            kind: "monthly",
            label: "Premium requests this month",
            utilization: remaining === null ? null : 100 - remaining,
            resetsAt: time(quota.get("rst")),
            status: null,
          },
        ];
  return { provider: "copilot", name: null, usage: usage(limits) };
}

const loginOf = (account: ClaudeAccount | null | undefined) =>
  account?.email?.toLowerCase() ?? null;

/** The machine's latest picture of its plan, and what the hub hasn't heard yet. */
export class PlanTracker {
  /** Null when signed out; undefined until read. */
  account: ClaudeAccount | null | undefined = undefined;
  usage: PlanUsage | null = null;
  /** OpenCode's plans, newest reading per provider. */
  plans = new Map<OpencodePlan["provider"], OpencodePlan>();
  /** When the last full /usage reading came in. */
  private fullAt = 0;
  private triedAt = 0;
  private dirty = { account: false, usage: false, plans: false };

  constructor(
    /** How often to take a full reading. */
    readonly everyMs = 10 * 60_000,
  ) {}

  update(update: PlanUpdate, at = Date.now()) {
    if ("account" in update) {
      if (JSON.stringify(update.account) !== JSON.stringify(this.account)) {
        // Another login's reading says nothing about this one's plan.
        if (loginOf(update.account) !== loginOf(this.account)) {
          this.usage = null;
          this.fullAt = 0;
          this.triedAt = 0;
          this.dirty.usage = false;
        }
        this.account = update.account;
        this.dirty.account = true;
      }
    } else if ("plan" in update) {
      this.plans.set(update.plan.provider, update.plan);
      this.dirty.plans = true;
    } else if ("usage" in update) {
      this.usage = { ...update.usage, account: loginOf(this.account) };
      this.fullAt = at;
      this.dirty.usage = true;
    } else {
      const next = applyRateLimit(this.usage, update.rateLimit, at);
      if (next && next !== this.usage) {
        this.usage = { ...next, account: loginOf(this.account) };
        this.dirty.usage = true;
      }
    }
  }

  /** Whether a full reading is due; claims the attempt so only one caller takes it. */
  claimReading(at = Date.now()) {
    if (at - this.fullAt < this.everyMs || at - this.triedAt < this.everyMs) return false;
    this.triedAt = at;
    return true;
  }

  /** What to send with the next heartbeat. */
  pending() {
    return {
      ...(this.dirty.account && this.account !== undefined ? { claudeAccount: this.account } : {}),
      ...(this.dirty.usage && this.usage ? { planUsage: this.usage } : {}),
      ...(this.dirty.plans ? { plans: [...this.plans.values()] } : {}),
    };
  }

  sent(report: ReturnType<PlanTracker["pending"]>) {
    if (report.claudeAccount === this.account) this.dirty.account = false;
    if (report.planUsage === this.usage) this.dirty.usage = false;
    if (report.plans?.every((p) => this.plans.get(p.provider) === p)) this.dirty.plans = false;
  }
}
