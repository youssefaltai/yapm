import type { Team } from "../data.js";
import { TabLink, TabRow } from "../layout.js";
import { paths, type TeamView } from "../router.js";

/** A team's views as header tabs; the Cycles page shows them too, so the header holds still. */
export function TeamTabs({ team, active }: { team: Team; active: TeamView | "cycles" }) {
  return (
    <TabRow>
      <TabLink group="view-tabs" active={active === "all"} to={paths.team(team.key, "all")}>
        All issues
      </TabLink>
      <TabLink group="view-tabs" active={active === "active"} to={paths.team(team.key, "active")}>
        Active
      </TabLink>
      <TabLink group="view-tabs" active={active === "backlog"} to={paths.team(team.key, "backlog")}>
        Backlog
      </TabLink>
      {team.triageEnabled && (
        <TabLink group="view-tabs" active={active === "triage"} to={paths.team(team.key, "triage")}>
          Triage
        </TabLink>
      )}
      {team.cyclesEnabled && (
        <TabLink group="view-tabs" active={active === "cycles"} to={paths.cycles(team.key)}>
          Cycles
        </TabLink>
      )}
    </TabRow>
  );
}
