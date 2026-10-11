// The hero demo: ask for something, and watch the company file it, staff it, do it, ask before it
// spends, and learn from your answer. Every name and step mirrors what the real app does.
const SCENARIOS = [
  {
    chip: "Renew my passport",
    ask: "renew my pasport before lisbon mornings only pls",
    title: "Renew passport before the Lisbon trip",
    team: { key: "TRV", name: "Travel" },
    id: "TRV-1",
    agent: { name: "Travel Manager", charter: "trips, documents and bookings" },
    priority: "High",
    label: "Documents",
    due: "Apr 12",
    goal: "Booking the renewal appointment",
    work: "Filled in the renewal form from your profile. Earliest morning slot is Tue 10:30 at the Baixa office; the fee is €95.",
    request: { title: "Pay the €95 fee and book Tue 10:30", action: "tool:payments__pay" },
    done: "Booked Tue 10:30 and paid €95. Bring your old passport and two photos; it's in your calendar.",
    lesson: "The owner only takes morning appointments.",
    reject: {
      reason: "not that week im away",
      reply: "Understood. I let the slot go and will book the first morning after you're back.",
      lesson: "Check the owner's calendar for trips before booking anything.",
    },
    ritual: "Monthly: check every travel document for expiry",
    later: {
      id: "TRV-4",
      title: "Renew the EU health card",
      text: "Travel Manager's monthly check found it expiring in June. It needed nothing new from you, so it just did it and told you after.",
    },
  },
  {
    chip: "Find a cheaper gym",
    ask: "cancel my gym and find a cheaper one near me i go mornings allegedly",
    title: "Cancel the gym and find a cheaper one nearby",
    team: { key: "FIN", name: "Finance", exists: true },
    id: "FIN-17",
    agent: { name: "Finance Manager", charter: "bills, subscriptions and savings" },
    priority: "Medium",
    label: "Subscriptions",
    due: "Fri",
    goal: "Comparing gyms within 2 km",
    work: "Gym & Tonic needs 30 days' notice, so the cancellation email is drafted. Best match: Early Bird Gym, €34 a month, opens at 6am, 900 m away.",
    request: {
      title: "Send the cancellation email to Gym & Tonic",
      action: "tool:gmail__send_email",
    },
    done: "Sent. Your last Gym & Tonic charge is May 1, and Early Bird Gym saves you €21 a month. The trial pass is in your inbox.",
    lesson: "The owner trains mornings; only suggest places open by 7am.",
    reject: {
      reason: "keep it till the contract ends in june",
      reply: "Held. I'll send it on May 1 so you lose nothing.",
      lesson: "Check contract end dates before cancelling anything.",
    },
    ritual: "Weekly: review subscriptions for anything unused",
    later: {
      id: "FIN-23",
      title: "Cancel two unused subscriptions",
      text: "Finance Manager's weekly review found two you hadn't used in three months and asked to cancel both. Two approvals save €18 a month.",
    },
  },
  {
    chip: "Plan Mom's birthday",
    ask: "plan moms 60th bday dinner like 12 ppl shes vegetarian dont let her find out",
    title: "Plan Mom's 60th birthday dinner",
    team: { key: "FAM", name: "Family" },
    id: "FAM-1",
    agent: { name: "Event Planner", charter: "family events, gifts and invites" },
    priority: "Medium",
    label: "Family",
    due: "Sat 18",
    goal: "Shortlisting restaurants and inviting family",
    work: "Shortlisted 3 places with a vegetarian menu and a private room. Top pick: Casa Lentil, Sat 7:30pm, €45 a head, €120 deposit to hold it.",
    request: {
      title: "Book Casa Lentil for 12 and pay the €120 deposit",
      action: "tool:payments__pay",
    },
    done: "Booked for Sat 7:30pm. Invites went to the family group with an RSVP link.",
    lesson: "Mom is vegetarian; check menus first for anything with her.",
    reject: {
      reason: "somewhere closer to her place",
      reply: "Got it. Two closer options are on the issue; I'll hold neither until you pick.",
      lesson: "For Mom's events, stay near her place.",
    },
    ritual: "Monthly: start family birthdays three weeks ahead",
    later: {
      id: "FAM-4",
      title: "Dad's birthday gift",
      text: "Event Planner filed it three weeks ahead and shortlisted three gifts from what Dad liked last year. You just pick one.",
    },
  },
  {
    chip: "Move to Lisbon",
    ask: "move me to lisbon by march visa flat near the river movers all of it",
    title: "Move to Lisbon by March",
    team: { key: "MOV", name: "Relocation" },
    id: "MOV-1",
    agent: { name: "Head of Relocation", charter: "the whole move, end to end" },
    priority: "High",
    label: "Move",
    due: "Mar 1",
    goal: "Planning the move and staffing it",
    plan: "Three parts that can run at once. I'm hiring someone for each and splitting the work.",
    reports: [
      {
        name: "Visa Specialist",
        charter: "visas and residency",
        id: "MOV-2",
        task: "Apply for the digital nomad visa",
        done: "filed the visa application; the consulate interview is Jan 14",
      },
      {
        name: "Property Scout",
        charter: "finding and securing homes",
        id: "MOV-3",
        task: "Find a 2-bed flat near the river under €1,900",
        done: "signed the lease from Feb 20",
      },
      {
        name: "Moving Coordinator",
        charter: "movers, shipping and utilities",
        id: "MOV-4",
        task: "Book movers and set up utilities",
        done: "booked movers for Feb 18, with power and fibre on from Feb 20",
      },
    ],
    work: "Viewed 14 listings. Best: a quiet 2-bed in Santos, 5 minutes from the river, €1,850 a month. The landlord wants a two-month deposit.",
    request: {
      from: "Property Scout",
      title: "Pay the €3,700 deposit for the Santos flat",
      action: "tool:payments__pay",
    },
    done: "The move is set: visa interview Jan 14, movers Feb 18, keys and utilities Feb 20. Your checklist for each date is on the issue.",
    lesson: "The owner wants quiet streets near the river.",
    reject: {
      reason: "too pricey stay under 1700",
      reply:
        "Understood. I'm narrowing it to €1,700 and will bring two new flats tomorrow. The visa and movers carry on.",
      lesson: "The owner's rent ceiling in Lisbon is €1,700.",
    },
    ritualBy: "Head of Relocation",
    ritual: "Weekly: move check-in with the whole Relocation team",
    later: {
      id: "MOV-12",
      title: "Register with the local health centre",
      text: "Head of Relocation filed it the week you landed, and the Visa Specialist got it done. Nothing needed from you.",
    },
  },
  {
    chip: "Moonlight for two clients",
    ask: "fix the checkout bug for parsnip and review okay labs pr today dont mix there code",
    title: "Clear today's client work for Parsnip and Okay Labs",
    team: { key: "ENG", name: "Engineering" },
    id: "ENG-1",
    agent: { name: "Engineering Lead", charter: "client work, kept apart per client" },
    priority: "High",
    label: "Clients",
    due: "Today",
    goal: "Splitting today's work by client",
    plan: "Two clients, two laptops. Each gets its own engineer, who only runs on that client's machine.",
    reports: [
      {
        name: "Parsnip Engineer",
        charter: "Parsnip's code, on the Parsnip laptop",
        id: "ENG-2",
        task: "Fix the double charge at Parsnip checkout",
        machine: "parsnip-macbook",
        done: "opened PR #482 with the fix and a test",
      },
      {
        name: "Okay Labs Engineer",
        charter: "Okay Labs' code, on the Okay Labs laptop",
        id: "ENG-3",
        task: "Review Okay Labs' rate-limit PR",
        machine: "okaylabs-thinkpad",
        done: "posted 6 review comments on PR #91, one blocking",
      },
    ],
    isolation:
      "Parsnip Engineer only runs on parsnip-macbook, Okay Labs Engineer only on okaylabs-thinkpad, each machine with its own sign-in. Neither client's code reaches the other's machine.",
    work: "Found it: the pay button retries without an idempotency key, so slow networks charge twice. The fix is ready; its test needs a migration on staging.",
    request: {
      from: "Parsnip Engineer",
      title: "Run the migration on Parsnip's staging database",
      action: "tool:Bash",
      on: "pnpm db:migrate --env staging",
    },
    done: "Both done. Parsnip: PR #482 is green and ready for your review. Okay Labs: review posted, one blocking comment on retries. Nothing crossed between the two.",
    lesson: "Parsnip staging migrations are safe to run before tests.",
    reject: {
      reason: "never touch parsnip staging ask their dba",
      reply:
        "Understood. I drafted the request to Parsnip's DBA in your voice; it's on the issue for you to send.",
      lesson: "Parsnip staging changes go through their DBA.",
    },
    ritualBy: "Engineering Lead",
    ritual: "Weekdays: standup notes for each client",
    later: {
      id: "ENG-14",
      title: "Parsnip on-call handover",
      text: "Engineering Lead wrote Monday's handover from the week's PRs, on the Parsnip laptop only. Okay Labs never saw a line of it.",
    },
  },
];

const $ = (name) => document.querySelector(`[data-${name}]`);
const esc = (text) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

const page = document.querySelector(".page");
const feed = $("feed");
const sheet = $("sheet");
const rail = [...$("rail").children];

let playing = 0; // Bumped on every new play, so an older one stops at its next step.
let clock = 0;

function time() {
  const minutes = 2 + clock++ * 3;
  return `9:${String(minutes).padStart(2, "0")}`;
}

function step(n) {
  rail.forEach((li, i) => {
    li.classList.toggle("on", i === n);
    li.classList.toggle("done", i < n);
  });
}

function scrollFeed() {
  const box = $("scroll");
  box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
}

function avatar(who) {
  const cls = who === "You" ? "av-you" : who === "CEO" ? "av-ceo" : "";
  return `<i class="av ${cls}">${who[0]}</i>`;
}

function event(who, html) {
  add("ev", `${avatar(who)}<span><b>${esc(who)}</b> ${html} · ${time()}</span>`);
}

function comment(who, text) {
  add(
    "cm",
    `<div class="cm-h">${avatar(who)}<b>${esc(who)}</b> · ${time()}</div><p>${esc(text)}</p>`,
  );
}

function note(kind, text) {
  add("note", `<span class="note-k">${kind}</span><p>${esc(text)}</p>`);
}

function add(cls, html) {
  const li = document.createElement("li");
  li.className = cls;
  li.innerHTML = html;
  feed.append(li);
  scrollFeed();
}

function status(name, state) {
  $("status").textContent = name;
  $("st").dataset.s = state;
}

function addRun(who, goal) {
  const row = document.createElement("div");
  row.className = "runrow";
  row.innerHTML = `<i class="pulse"></i><span class="rn">${esc(who)}</span><span class="rk">${esc(goal)}</span><span class="rs"></span>`;
  $("runlist").append(row);
  document.querySelector(".runs-sec").classList.add("on");
  return row;
}

function run(row, text, live) {
  row.querySelector(".rs").textContent = text;
  row.classList.toggle("live", live);
  $("runs").textContent = document.querySelectorAll(".runrow.live").length || "";
}

function addSub(r) {
  const li = document.createElement("li");
  li.innerHTML = `<i class="st" data-s="todo"></i><span class="sid">${r.id}</span><span class="stt">${esc(r.task)}</span>${avatar(r.name)}`;
  $("subs").append(li);
  document.querySelector(".subs-sec").classList.add("on");
  return li.querySelector(".st");
}

function orgNode(who, charter) {
  return `<span class="node">${avatar(who)}<b>${esc(who)}</b>${charter ? `<small>${esc(charter)}</small>` : ""}</span>`;
}

async function showSheet(html) {
  sheet.classList.remove("on");
  await wait(sheet.innerHTML ? 400 : 0);
  sheet.innerHTML = html;
  sheet.classList.add("on");
  // Keep the newest activity above the sheet where it overlaps the app.
  const overlap = document.querySelector(".window").offsetHeight - sheet.offsetTop;
  $("scroll").style.paddingBottom = `${Math.max(40, overlap + 24)}px`;
  scrollFeed();
}

function hideSheet() {
  sheet.classList.remove("on");
}

function chips() {
  $("chips").innerHTML = SCENARIOS.map(
    (s, i) => `<button type="button" class="chip" data-i="${i}">${esc(s.chip)}</button>`,
  ).join("");
}

function reset() {
  feed.innerHTML = "";
  $("scroll").style.paddingBottom = "";
  sheet.classList.remove("on");
  sheet.innerHTML = "";
  $("pill").classList.remove("on");
  $("typed").textContent = "";
  document.querySelector(".ask-go").classList.remove("ready");
  for (const li of document.querySelectorAll("[data-team].new")) li.remove();
  for (const li of document.querySelectorAll("[data-team]")) li.classList.remove("on");
  $("runlist").innerHTML = "";
  $("subs").innerHTML = "";
  $("runs").textContent = "";
  document.querySelector(".runs-sec").classList.remove("on");
  document.querySelector(".subs-sec").classList.remove("on");
  page.dataset.stage = "ask";
  $("crumb").textContent = "Ask CEO";
  $("url").textContent = "";
  clock = 0;
  step(-1);
}

async function play(s) {
  const id = ++playing;
  const next = async (ms) => {
    await wait(ms);
    if (id !== playing) throw new Error("replaced");
  };
  reset();
  step(0);

  // You yap.
  const typed = $("typed");
  for (const ch of s.ask) {
    typed.textContent += ch;
    await next(22);
  }
  // Let the prompt sit long enough to read before it's sent.
  document.querySelector(".ask-go").classList.add("ready");
  await next(1800);

  page.dataset.stage = "issue";
  $("title").textContent = s.title;
  $("crumb").textContent = "New issue";
  status("Todo", "todo");
  $("priority").textContent = "No priority";
  $("assignee").textContent = "Unassigned";
  $("labels").innerHTML = "";
  $("due").textContent = "";
  // It runs itself.
  step(1);
  event("CEO", "filed it from Ask CEO");
  await next(900);
  if (!s.team.exists) {
    const li = document.createElement("li");
    li.dataset.team = s.team.key;
    li.className = "new";
    li.innerHTML = `<span class="tk">${s.team.key}</span>${esc(s.team.name)}`;
    $("teams").append(li);
    event("CEO", `created the team <b>${esc(s.team.name)}</b>`);
    await next(900);
  }
  event("CEO", `hired <b>${esc(s.agent.name)}</b> to own ${esc(s.agent.charter)}`);
  note("Grant", "You always allowed every agent to create teams and hire.");
  await next(1000);

  document.querySelector(`[data-team="${s.team.key}"]`).classList.add("on");
  $("crumb").innerHTML = `${esc(s.team.name)}<b>›</b>${s.id}`;
  $("url").textContent = `issue/${s.id}`;
  status("Todo", "todo");
  $("priority").innerHTML = `<i class="pr"></i>${s.priority}`;
  $("labels").innerHTML = `<span class="lb">${esc(s.label)}</span>`;
  $("due").textContent = s.due;
  $("assignee").innerHTML = `${avatar(s.agent.name)}${esc(s.agent.name)}`;
  event("CEO", `assigned it to <b>${esc(s.agent.name)}</b>, ${s.priority.toLowerCase()} priority`);
  await next(1100);

  const lead = addRun(s.agent.name, s.goal);
  run(lead, "Running", true);
  status("In Progress", "progress");
  event(s.agent.name, "started working on your Mac");
  await next(1500);

  // A manager hires a report for each part, and they work at once.
  const reports = [];
  async function finishReports(list) {
    for (const r of list) {
      event(r.name, `closed ${r.id}: ${esc(r.done)}`);
      run(r.run, "Done", false);
      r.st.dataset.s = "done";
      await next(900);
    }
  }

  if (s.reports) {
    comment(s.agent.name, s.plan);
    await next(1200);
    add(
      "orgcard",
      `<span class="note-k">Org chart</span><ul class="tree"><li>${orgNode("CEO")}<ul><li>${orgNode(s.agent.name, s.agent.charter)}<ul data-org></ul></li></ul></li></ul>`,
    );
    const org = feed.querySelector("[data-org]");
    org.removeAttribute("data-org");
    await next(700);
    for (const r of s.reports) {
      const li = document.createElement("li");
      li.innerHTML = orgNode(r.name, r.charter);
      org.append(li);
      reports.push({ ...r, st: addSub(r) });
      event(s.agent.name, `hired <b>${esc(r.name)}</b> and gave them ${r.id}`);
      await next(800);
    }
    if (s.isolation) {
      note("Runs on", s.isolation);
      await next(1100);
    }
    run(lead, "Done", false);
    for (const r of reports) {
      r.run = addRun(r.name, r.machine ? `${r.task} · ${r.machine}` : r.task);
      run(r.run, "Running", true);
      r.st.dataset.s = "progress";
      await next(350);
    }
    await next(1000);
  }

  const asker = s.request.from ?? s.agent.name;
  const askerRun = reports.find((r) => r.name === asker)?.run ?? lead;
  comment(asker, s.work);
  await next(1300);

  // You approve.
  step(2);
  run(askerRun, "Needs input", false);
  event(asker, "asked for your OK");
  $("pill").classList.add("on");
  await showSheet(`
    <p class="sheet-k">Request from <b>${esc(asker)}</b></p>
    <p class="sheet-t">${esc(s.request.title)}</p>
    <p class="sheet-on"><span>Permission</span><code>${s.request.action}</code></p>
    ${s.request.on ? `<p class="sheet-on"><span>On</span><code>${esc(s.request.on)}</code></p>` : ""}
    <p class="sheet-on"><span>Issue</span>${s.id} ${esc(s.title)}</p>
    <div class="sheet-a">
      <button type="button" class="b b-ok" data-answer="approve">Approve once</button>
      <button type="button" class="b" data-answer="always">Always allow</button>
      <button type="button" class="b b-no" data-answer="reject">Reject</button>
    </div>`);
  const answer = await new Promise((done) => {
    sheet.onclick = (e) => {
      const button = e.target.closest("[data-answer]");
      if (button) done(button.dataset.answer);
    };
  });
  sheet.onclick = null;
  if (id !== playing) return;
  hideSheet();
  $("pill").classList.remove("on");

  if (answer === "reject") {
    event("You", `rejected: “${esc(s.reject.reason)}”`);
    run(askerRun, "Running", true);
    await next(1100);
    comment(asker, s.reject.reply);
    run(askerRun, "Done", false);
    await finishReports(reports.filter((r) => r.name !== asker));
    if (!reports.length) status("Todo", "todo");
  } else {
    event(
      "You",
      answer === "always"
        ? `approved, and always allowed ${esc(asker)} <code>${s.request.action}</code>`
        : "approved",
    );
    run(askerRun, "Running", true);
    await next(1300);
    if (reports.length) {
      await finishReports(reports);
      comment(s.agent.name, s.done);
    } else {
      comment(s.agent.name, s.done);
      run(askerRun, "Done", false);
    }
    status("Done", "done");
  }
  await next(1100);

  // It learns.
  step(3);
  if (answer === "reject") {
    note(
      "Feedback",
      `Your reason goes straight to ${asker}, and stays as feedback until it's addressed.`,
    );
    await next(1000);
  }
  if (answer === "always") {
    note("Grant", `${asker} can use ${s.request.action} without asking now. Revoke it anytime.`);
    await next(1000);
  }
  note("Lesson", `${asker} wrote down: “${answer === "reject" ? s.reject.lesson : s.lesson}”`);
  await next(1100);
  event(s.ritualBy ?? "CEO", `set up a recurring issue: <b>${esc(s.ritual)}</b>`);
  await next(1600);

  await showSheet(`
    <p class="sheet-k">A month later, on its own</p>
    <p class="sheet-t">${s.later.id} ${esc(s.later.title)}</p>
    <p class="sheet-p">${esc(s.later.text)}</p>
    <div class="sheet-a">
      <button type="button" class="b b-ok" data-again>Try another</button>
      <a class="b" href="#self-host">Self-host it</a>
    </div>`);
  sheet.querySelector("[data-again]").onclick = () => {
    playing++;
    reset();
    step(0);
  };
}

chips();
reset();
step(0);

let touched = false;
$("chips").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-i]");
  if (!chip) return;
  touched = true;
  play(SCENARIOS[chip.dataset.i]).catch(() => {});
});

// Nobody picked one? Play the first once the app is in view, and wait at the approval.
new IntersectionObserver(
  async ([entry], observer) => {
    if (!entry.isIntersecting) return;
    observer.disconnect();
    await wait(3500);
    if (!touched) play(SCENARIOS[0]).catch(() => {});
  },
  { threshold: 0.5 },
).observe(document.querySelector(".window"));

// Sections rise in once, as they come into view.
const reveal = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("in");
      reveal.unobserve(entry.target);
    }
  },
  { rootMargin: "0px 0px -10% 0px" },
);
for (const el of document.querySelectorAll(
  ".section-title, .grid li, .hosts li, .host-more, .faqs > div",
)) {
  el.classList.add("reveal");
  reveal.observe(el);
}

// A soft light that follows the pointer across the cards.
for (const card of document.querySelectorAll(".grid li, .hosts li")) {
  card.addEventListener("pointermove", (e) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty("--x", `${e.clientX - r.left}px`);
    card.style.setProperty("--y", `${e.clientY - r.top}px`);
  });
}
