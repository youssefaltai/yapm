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

/** Something a session or a probe learned about the plan. */
export type PlanUpdate =
  | { account: ClaudeAccount }
  | { usage: PlanUsage }
  | { rateLimit: SDKRateLimitInfo };

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

export function accountFrom(info: AccountInfo): ClaudeAccount {
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

/** The machine's latest picture of its plan, and what the hub hasn't heard yet. */
export class PlanTracker {
  account: ClaudeAccount | null = null;
  usage: PlanUsage | null = null;
  /** When the last full /usage reading came in. */
  private fullAt = 0;
  private triedAt = 0;
  private dirty = { account: false, usage: false };

  constructor(
    /** How often to take a full reading. */
    readonly everyMs = 10 * 60_000,
  ) {}

  update(update: PlanUpdate, at = Date.now()) {
    if ("account" in update) {
      if (JSON.stringify(update.account) !== JSON.stringify(this.account)) {
        this.account = update.account;
        this.dirty.account = true;
      }
    } else if ("usage" in update) {
      this.usage = update.usage;
      this.fullAt = at;
      this.dirty.usage = true;
    } else {
      const next = applyRateLimit(this.usage, update.rateLimit, at);
      if (next !== this.usage) {
        this.usage = next;
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
      ...(this.dirty.account && this.account ? { claudeAccount: this.account } : {}),
      ...(this.dirty.usage && this.usage ? { planUsage: this.usage } : {}),
    };
  }

  sent(report: ReturnType<PlanTracker["pending"]>) {
    if (report.claudeAccount === this.account) this.dirty.account = false;
    if (report.planUsage === this.usage) this.dirty.usage = false;
  }
}
