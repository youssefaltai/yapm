import { useState } from "react";
import { dateMenu, linkEntries, workspaceStore } from "../actions.js";
import { contextMenu } from "../contextMenu.js";
import { confirmDialog } from "../controls.js";
import { mutate, useQuery } from "../data.js";
import { navigate, paths } from "../router.js";
import { EmptyState } from "../states.js";
import { Avatar, Crumb, type MenuSpec, openMenu, shortDate } from "../ui.js";
import { type Health, HealthBadge, ProjectDot } from "./Projects.js";

type Status = "planned" | "active" | "completed";
const STATUS: Record<Status, { label: string; className: string }> = {
  planned: { label: "Planned", className: "text-muted" },
  active: { label: "Active", className: "text-accent" },
  completed: { label: "Completed", className: "text-emerald-400" },
};

interface Initiative {
  id: string;
  name: string;
  description: string | null;
  status: Status;
  targetDate: string | null;
  owner: { id: string; name: string; kind: "owner" | "agent" } | null;
  projects: {
    nodes: {
      id: string;
      name: string;
      color: string;
      health: Health | null;
      progress: { progress: number };
    }[];
  };
}

const update = (id: string, input: Record<string, unknown>) =>
  mutate(
    "mutation($id: String!, $input: InitiativeUpdateInput!) { initiativeUpdate(id: $id, input: $input) { success } }",
    { id, input },
  );

function statusMenu(i: Initiative): MenuSpec {
  return {
    placeholder: "Status…",
    items: (Object.keys(STATUS) as Status[]).map((s) => ({
      id: s,
      label: STATUS[s].label,
      checked: s === i.status,
      onSelect: () => void update(i.id, { status: s }),
    })),
  };
}

function ownerMenu(i: Initiative): MenuSpec {
  return {
    placeholder: "Who owns it?",
    items: (workspaceStore.get()?.users.nodes ?? []).map((u) => ({
      id: u.id,
      label: u.name,
      checked: u.id === i.owner?.id,
      icon: <Avatar name={u.name} kind={u.kind} size={16} />,
      onSelect: () => void update(i.id, { ownerId: u.id }),
    })),
  };
}

/** Company-level goals, each with the projects that move it. */
export function InitiativesView() {
  const { data, error } = useQuery<{ initiatives: { nodes: Initiative[] } }>(
    "{ initiatives { nodes { id name description status targetDate owner { id name kind } projects { nodes { id name color health progress { progress } } } } } }",
  );
  const [name, setName] = useState("");
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4 md:px-6">
        <Crumb onClick={() => navigate(paths.projects())}>Projects</Crumb>
        <span className="font-medium">Initiatives</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
          {error && <p className="text-red-400">{error}</p>}
          <p className="mb-4 text-muted">
            The few big things the company is going after this year. Link projects to them from
            here.
          </p>
          <form
            className="mb-6 flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await mutate(
                  "mutation($name: String!) { initiativeCreate(input: { name: $name, status: active }) { success } }",
                  { name },
                )
              )
                setName("");
            }}
          >
            <input
              aria-label="New initiative"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New initiative, e.g. Get fit"
              className="min-w-0 flex-1 rounded-md border border-line bg-panel px-3 py-1.5 outline-none placeholder:text-faint focus:border-faint"
            />
            <button
              type="submit"
              disabled={!name.trim()}
              className="rounded-md bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40"
            >
              Add
            </button>
          </form>
          {data && data.initiatives.nodes.length === 0 && (
            <EmptyState
              compact
              icon="initiative"
              title="No initiatives yet"
              description="Name one above, like “Get fit” or “Buy a home”, then link the projects that move it."
              className="rounded-xl border border-dashed border-line"
            />
          )}
          <div className="space-y-4">
            {data?.initiatives.nodes.map((i) => (
              <section key={i.id} className="rounded-lg border border-line">
                {/* biome-ignore lint/a11y/noStaticElementInteractions: the right-click menu repeats its buttons */}
                <header
                  className="flex items-center gap-3 border-b border-line px-4 py-3"
                  onContextMenu={contextMenu(() => [
                    { id: "status", label: "Status", submenu: () => statusMenu(i) },
                    { id: "owner", label: "Owner", submenu: () => ownerMenu(i) },
                    {
                      id: "target",
                      label: "Target date",
                      submenu: () =>
                        dateMenu({
                          placeholder: "Target date… try “dec 31”",
                          value: i.targetDate,
                          onPick: (targetDate) => update(i.id, { targetDate }),
                        }),
                    },
                    "divider",
                    {
                      id: "archive",
                      label: "Archive…",
                      onSelect: async () => {
                        if (
                          await confirmDialog({
                            title: `Archive ${i.name}?`,
                            body: "Its projects stay as they are.",
                            confirmLabel: "Archive",
                          })
                        )
                          await mutate(
                            "mutation($id: String!) { initiativeArchive(id: $id) { success } }",
                            { id: i.id },
                          );
                      },
                    },
                  ])}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{i.name}</span>
                  <button
                    type="button"
                    onClick={() => openMenu(statusMenu(i))}
                    className={`rounded-md px-1.5 text-[12px] hover:bg-raised ${STATUS[i.status].className}`}
                  >
                    {STATUS[i.status].label}
                  </button>
                  <button
                    type="button"
                    aria-label="Owner"
                    onClick={() => openMenu(ownerMenu(i))}
                    className="rounded-md px-1 hover:bg-raised"
                  >
                    {i.owner ? (
                      <Avatar name={i.owner.name} kind={i.owner.kind} size={18} />
                    ) : (
                      <span className="text-[12px] text-faint">No owner</span>
                    )}
                  </button>
                  {i.targetDate && (
                    <span className="text-[12px] text-faint">{shortDate(i.targetDate)}</span>
                  )}
                </header>
                <ul>
                  {i.projects.nodes.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => navigate(paths.project(p.id))}
                        onContextMenu={contextMenu(() => [
                          ...linkEntries(paths.project(p.id)),
                          "divider",
                          {
                            id: "unlink",
                            label: "Remove from initiative",
                            onSelect: () =>
                              mutate(
                                "mutation($id: String!) { projectUpdate(id: $id, input: { initiativeId: null }) { success } }",
                                { id: p.id },
                              ),
                          },
                        ])}
                        className="flex w-full animate-fade-in items-center gap-3 px-4 py-2 text-left hover:bg-raised"
                      >
                        <ProjectDot color={p.color} />
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        <HealthBadge health={p.health} />
                        <span className="w-10 text-right text-[12px] text-muted">
                          {Math.round(p.progress.progress * 100)}%
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <LinkProject initiativeId={i.id} linked={i.projects.nodes.map((p) => p.id)} />
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function LinkProject({ initiativeId, linked }: { initiativeId: string; linked: string[] }) {
  const { data } = useQuery<{ projects: { nodes: { id: string; name: string; color: string }[] } }>(
    "{ projects(first: 200) { nodes { id name color } } }",
  );
  const options = (data?.projects.nodes ?? []).filter((p) => !linked.includes(p.id));
  if (!options.length) return null;
  return (
    <button
      type="button"
      onClick={() =>
        openMenu({
          placeholder: "Add a project to this initiative…",
          items: options.map((p) => ({
            id: p.id,
            label: p.name,
            icon: <ProjectDot color={p.color} />,
            onSelect: () =>
              void mutate(
                "mutation($id: String!, $i: String!) { projectUpdate(id: $id, input: { initiativeId: $i }) { success } }",
                { id: p.id, i: initiativeId },
              ),
          })),
        })
      }
      className="w-full px-4 py-2 text-left text-muted hover:bg-raised hover:text-ink"
    >
      + Add project
    </button>
  );
}
