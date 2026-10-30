import { Select } from "../controls.js";
import { propertyButton } from "../ui.js";

export type Tier = "small" | "standard" | "top";
export interface TierModel {
  provider: string;
  model: string;
  effort: string | null;
}
export type Tiers = Record<Tier, TierModel>;
export interface AiProvider {
  id: string;
  name: string;
  models: { id: string; name: string; efforts: string[] }[];
}

/** The catalog the editor picks from: every provider and model some machine has. */
export const AI_PROVIDERS = "aiProviders { id name models { id name efforts } }";

const TIERS: { value: Tier; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "standard", label: "Standard" },
  { value: "top", label: "Top" },
];

// Provider ids don't hold a colon; model ids may hold a slash.
const key = (m: { provider: string; model: string }) => `${m.provider}:${m.model}`;

/** Keep the effort if the model has it, else medium, else its first, else none. */
const effortFor = (efforts: string[], current: string | null) =>
  current && efforts.includes(current)
    ? current
    : efforts.includes("medium")
      ? "medium"
      : (efforts[0] ?? null);

/** Which model and effort each tier of work runs on; read-only without `onChange`. */
export function TierTable({
  tiers,
  providers,
  onChange,
}: {
  tiers: Tiers;
  providers: AiProvider[];
  onChange?: (tiers: Tiers) => void;
}) {
  const options = providers.flatMap((p) =>
    p.models.map((m) => ({
      value: key({ provider: p.id, model: m.id }),
      label: `${m.name} · ${p.name}`,
      efforts: m.efforts,
    })),
  );
  return (
    // Narrow, as beside an agent's page, each tier's name sits above its pickers.
    <div className="@container">
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 @sm:grid-cols-[4rem_minmax(0,1fr)_auto]">
        {TIERS.map(({ value: tier, label }) => {
          const current = tiers[tier];
          const found = options.find((o) => o.value === key(current));
          // A model no machine reports yet still shows, so nothing changes behind the owner's back.
          const choices = found
            ? options
            : [
                ...options,
                {
                  value: key(current),
                  label: `${current.model} · ${providers.find((p) => p.id === current.provider)?.name ?? (current.provider === "anthropic" ? "Claude" : current.provider)}`,
                  efforts: current.effort ? [current.effort] : [],
                },
              ];
          const chosen = choices.find((o) => o.value === key(current));
          const efforts = chosen?.efforts ?? [];
          const set = (next: TierModel) => onChange?.({ ...tiers, [tier]: next });
          return (
            <div key={tier} className="contents">
              <dt className="col-span-2 text-faint @sm:col-span-1">{label}</dt>
              <dd className="min-w-0">
                {onChange ? (
                  <Select
                    aria-label={`${label} model`}
                    value={key(current)}
                    options={choices}
                    onChange={(value) => {
                      const i = value.indexOf(":");
                      const next = choices.find((o) => o.value === value)?.efforts ?? [];
                      set({
                        provider: value.slice(0, i),
                        model: value.slice(i + 1),
                        effort: effortFor(next, current.effort),
                      });
                    }}
                    className={`${propertyButton} w-full`}
                  />
                ) : (
                  <span className="block truncate px-2 py-1 text-muted">{chosen?.label}</span>
                )}
              </dd>
              <dd className="text-muted">
                {onChange && efforts.length ? (
                  <Select
                    aria-label={`${label} effort`}
                    value={current.effort ?? ""}
                    options={efforts.map((e) => ({ value: e, label: e }))}
                    onChange={(effort) => set({ ...current, effort })}
                    className={propertyButton}
                  />
                ) : (
                  <span className="block px-2 py-1">{current.effort ?? "—"}</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
