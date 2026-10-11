import { type Engine, type EngineRun, MODELS, type PlanProbe } from "./engine.js";
import { type Claim, type Completion, type HubClient, HubError, type Usage } from "./hub.js";
import { decideTool } from "./permissions.js";
import { PlanTracker } from "./plan.js";

export interface RunnerOptions {
  hub: HubClient;
  /** The machine's secret (`lrn_…`). */
  token: string;
  engine: Engine;
  capacity: number;
  version: string;
  /** The machine's own MCP servers, from its config; the hub's for the run come on top. */
  mcpServers?: EngineRun["mcpServers"];
  /** Where agents start; they may work anywhere on the machine. */
  cwd: string;
  /** Reads the plan's limits while no session is running; left out, only sessions read them. */
  probe?: PlanProbe;
  /** How often to take a full reading of the plan's limits. */
  planEveryMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  logFlushMs?: number;
  log?: (line: string) => void;
}

interface Active {
  claim: Claim;
  abort: AbortController;
  stopReason: string | null;
  done: Promise<void>;
}

/**
 * The runner daemon: checks in, claims what this machine may run, runs it, streams the
 * transcript, and reports the result. The hub decides everything else.
 */
export class Runner {
  private readonly active = new Map<string, Active>();
  private stopped = false;
  /** The owner asked for the latest runner: take no more work, finish what's running. */
  private upgrading = false;
  private waitingNoted = false;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly logFlushMs: number;
  private readonly log: (line: string) => void;
  readonly plan: PlanTracker;
  private probing = false;

  constructor(private readonly options: RunnerOptions) {
    this.pollMs = options.pollMs ?? 5000;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.logFlushMs = options.logFlushMs ?? 2000;
    this.log = options.log ?? ((line) => console.log(line));
    this.plan = new PlanTracker(options.planEveryMs);
  }

  get running() {
    return [...this.active.keys()];
  }

  /** One check-in: stops what the hub wants stopped, then claims up to capacity. */
  async heartbeat() {
    const { hub, token } = this.options;
    const plan = this.plan.pending();
    const answer = await hub.heartbeat(token, {
      capacity: this.options.capacity,
      version: this.options.version,
      runIds: this.running,
      ...plan,
    });
    this.plan.sent(plan);
    for (const stop of answer?.stop ?? []) this.stop(stop.id, stop.reason);
    if (answer?.upgrade && !this.upgrading) {
      this.upgrading = true;
      this.log("Upgrading once the runs in progress finish…");
    }
    return answer?.status ?? "active";
  }

  /** Claims and starts runs while there is room. Returns how many started. */
  async claim() {
    let started = 0;
    while (!this.stopped && !this.upgrading && this.active.size < this.options.capacity) {
      let claim: Claim | null;
      try {
        claim = await this.options.hub.claim(this.options.token);
      } catch (error) {
        if (error instanceof HubError && error.status === 403) {
          if (!this.waitingNoted) this.log("Waiting for the owner to approve this machine…");
          this.waitingNoted = true;
          return started;
        }
        throw error;
      }
      if (!claim) break;
      if (this.waitingNoted) this.log("Approved. Taking work.");
      this.waitingNoted = false;
      this.start(claim);
      started++;
    }
    return started;
  }

  stop(runId: string, reason: string | null) {
    const run = this.active.get(runId);
    if (!run || run.abort.signal.aborted) return;
    run.stopReason = reason ?? "Stopped";
    this.log(`Stopping ${run.claim.agent.name}'s run: ${run.stopReason}`);
    run.abort.abort();
  }

  /** Waits for every run in progress to end. */
  async idle() {
    await Promise.all([...this.active.values()].map((a) => a.done));
  }

  private start(claim: Claim) {
    const abort = new AbortController();
    const entry: Active = { claim, abort, stopReason: null, done: Promise.resolve() };
    this.active.set(claim.run.id, entry);
    entry.done = this.execute(entry)
      .catch((error) => this.log(`Run ${claim.run.id} crashed: ${String(error)}`))
      .finally(() => this.active.delete(claim.run.id));
  }

  private async execute(entry: Active) {
    const { claim, abort } = entry;
    const { hub, token } = this.options;
    const label = `${claim.agent.name} · ${claim.run.kind}${claim.run.issue ? ` on ${claim.run.issue}` : ""}${claim.run.model ? ` (${claim.run.model}, ${claim.run.effort ?? "default"} effort)` : ""}`;
    this.log(`Starting ${label}`);

    let seq = 0;
    const buffer: Record<string, unknown>[] = [];
    let sessionId = claim.run.sessionId;
    let usage: Usage = {};
    let flushing: Promise<void> = Promise.resolve();
    const flush = () => {
      flushing = flushing.then(async () => {
        if (!buffer.length) return;
        const events = buffer.splice(0, 500);
        const answer = await hub
          .logs(token, claim.run.id, { seq: seq++, events, sessionId, usage })
          .catch((error) => {
            this.log(`Couldn't upload the transcript: ${String(error)}`);
            buffer.unshift(...events);
            seq--;
            return null;
          });
        if (answer?.stop) this.stop(claim.run.id, answer.stopReason);
      });
      return flushing;
    };
    const timer = setInterval(flush, this.logFlushMs);
    const onEvent = (event: Record<string, unknown>) => {
      buffer.push({ at: Date.now(), ...event });
      if (buffer.length >= 50) void flush();
    };

    let completion: Completion;
    try {
      const result = await this.options.engine({
        input: claim.input,
        model: claim.run.model ?? MODELS[claim.run.modelTier] ?? MODELS.standard,
        modelTier: claim.run.modelTier,
        ...(claim.run.effort ? { effort: claim.run.effort } : {}),
        hubMcp: { url: claim.mcpUrl, token: claim.token },
        mcpServers: { ...this.options.mcpServers, ...claim.mcpServers },
        resume: claim.run.sessionId,
        cwd: this.options.cwd,
        signal: abort.signal,
        canUseTool: (tool, input, readOnly) =>
          decideTool(
            {
              hub,
              token: claim.token,
              agent: claim.agent.name,
              issue: claim.run.issue,
              issueId: claim.run.issueId,
              pollMs: this.pollMs,
              signal: abort.signal,
              onEvent,
            },
            tool,
            input,
            readOnly,
          ),
        onEvent,
        onSession: (id) => {
          sessionId = id;
        },
        onPlan: (update) => this.plan.update(update),
        readUsage: this.plan.claimReading(),
      });
      sessionId = result.sessionId ?? sessionId;
      usage = result.usage;
      if (abort.signal.aborted) {
        completion = { status: "stopped", error: entry.stopReason ?? "Stopped" };
      } else if (result.error || result.output == null) {
        completion = {
          status: "failed",
          error: result.error ?? "The session ended without a result",
        };
      } else {
        completion = { status: "completed", result: result.output };
      }
    } catch (error) {
      completion = {
        status: abort.signal.aborted ? "stopped" : "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    clearInterval(timer);
    await flush();
    await flush();
    const answer = await hub.complete(token, claim.run.id, { ...completion, sessionId, usage });
    const status = answer?.status ?? completion.status;
    this.log(
      `Finished ${label}: ${status}${completion.error && status !== "completed" ? ` (${completion.error})` : ""}`,
    );
  }

  /**
   * Takes a full reading of the plan when one is due and no session is running to take it.
   * Runs in the background; a failed reading waits for the next turn.
   */
  readPlan() {
    const { probe } = this.options;
    if (!probe || this.probing || this.active.size > 0 || !this.plan.claimReading()) return;
    this.probing = true;
    void probe()
      .then((updates) => {
        for (const update of updates) this.plan.update(update);
      })
      .catch((error) => this.log(`Couldn't read the plan's usage: ${String(error)}`))
      .finally(() => {
        this.probing = false;
      });
  }

  /**
   * Runs until `shutdown()`: heartbeats on a timer, claims on every poll. Resolves "upgrade"
   * when the owner asked for the latest runner and nothing is running any more.
   */
  async run(): Promise<"upgrade" | undefined> {
    let lastBeat = 0;
    while (!this.stopped) {
      try {
        if (Date.now() - lastBeat >= this.heartbeatMs) {
          const status = await this.heartbeat();
          lastBeat = Date.now();
          if (status === "revoked") {
            this.log("The owner removed this machine. Enrol again to rejoin.");
            break;
          }
        }
        if (this.upgrading && this.active.size === 0) return "upgrade";
        await this.claim();
        this.readPlan();
      } catch (error) {
        if (error instanceof HubError && error.status === 401) {
          this.log("The hub doesn't know this machine any more. Enrol again to rejoin.");
          break;
        }
        this.log(`Hub unreachable: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
    await this.idle();
  }

  /** Stops claiming; runs in progress are stopped and reported. */
  async shutdown(reason = "The machine is shutting down") {
    this.stopped = true;
    for (const id of this.running) this.stop(id, reason);
    await this.idle();
  }
}
