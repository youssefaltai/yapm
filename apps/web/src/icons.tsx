import type { ReactNode } from "react";

// The app's line icons: 16px, drawn on a 16-unit grid with a 1.5 stroke in the current text
// colour, so they sit beside 13px labels in the sidebar, menus and buttons.

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="block shrink-0"
    >
      {children}
    </svg>
  );
}

const paths = {
  chat: (
    <path d="M4 2.5h8A1.5 1.5 0 0 1 13.5 4v6a1.5 1.5 0 0 1-1.5 1.5H7.5l-3 2.5v-2.5H4A1.5 1.5 0 0 1 2.5 10V4A1.5 1.5 0 0 1 4 2.5z" />
  ),
  inbox: (
    <>
      <path d="M2 9 3.6 3.8A1.2 1.2 0 0 1 4.7 3h6.6a1.2 1.2 0 0 1 1.1.8L14 9" />
      <path d="M2 9v3a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 12V9h-3.2l-.8 1.5H6L5.2 9z" />
    </>
  ),
  myIssues: (
    <>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="6.5" r="2" />
      <path d="M4.3 12.7a4.2 4.2 0 0 1 7.4 0" />
    </>
  ),
  approval: (
    <>
      <path d="M8 1.75 13.25 3.7v4.1c0 3.1-2.2 5.6-5.25 6.6-3.05-1-5.25-3.5-5.25-6.6V3.7z" />
      <path d="m5.75 8 1.6 1.6 2.9-3.1" />
    </>
  ),
  project: (
    <>
      <path d="M8 1.75 13.5 4.9v6.2L8 14.25 2.5 11.1V4.9z" />
      <path d="M2.7 5 8 8l5.3-3M8 8v6" />
    </>
  ),
  document: (
    <>
      <path d="M4.5 1.75h4.75l3 3v8.25a1.25 1.25 0 0 1-1.25 1.25h-6.5A1.25 1.25 0 0 1 3.25 13V3a1.25 1.25 0 0 1 1.25-1.25z" />
      <path d="M9.25 1.75V5h3M5.75 8.25h4.5M5.75 11h3" />
    </>
  ),
  run: <path d="M9 1.75 3.5 9h4l-.75 5.25L12.5 7h-4z" />,
  insights: <path d="M2.5 13.5h11M4.5 11V8M8 11V3.5M11.5 11V6" />,
  usage: (
    <>
      <path d="M2.25 11.5a5.75 5.75 0 1 1 11.5 0" />
      <path d="m8 11.5 2.75-3.75" />
    </>
  ),
  company: (
    <>
      <path d="M3 14V3a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v11M10 6.5h2a1 1 0 0 1 1 1V14M1.75 14h12.5" />
      <path d="M5.5 5h1.5M5.5 8h1.5M5.5 11h1.5" />
    </>
  ),
  handbook: (
    <>
      <path d="M3 12.75v-9.5a1.5 1.5 0 0 1 1.5-1.5H13v9.5H4.5a1.5 1.5 0 0 0 0 3H13" />
      <path d="M6 5h4" />
    </>
  ),
  roadmap: <path d="M2.5 2.5v11M2.5 4h6M5 8h7.5M7.5 12h6" />,
  initiative: (
    <>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="3" />
      <circle cx="8" cy="8" r="0.5" fill="currentColor" />
    </>
  ),
  machine: (
    <>
      <rect x="2.5" y="2.75" width="11" height="7.75" rx="1.25" />
      <path d="M1.25 13.25h13.5M6.75 5.5 5.25 6.75l1.5 1.25M9 8h1.75" />
    </>
  ),
  triage: <path d="M2 3h12L9.5 8.5V13l-3-1.5v-3z" />,
  active: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" stroke="none" />
    </>
  ),
  backlog: <circle cx="8" cy="8" r="6" strokeDasharray="1.6 1.9" />,
  cycle: (
    <>
      <path d="M13.25 8a5.25 5.25 0 0 1-9.2 3.45M2.75 8a5.25 5.25 0 0 1 9.2-3.45" />
      <path d="M12.25 1.75v3h-3M3.75 14.25v-3h3" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.4 3.6l-1.05 1.05M4.65 11.35 3.6 12.4M12.4 12.4l-1.05-1.05M4.65 4.65 3.6 3.6" />
      <circle cx="8" cy="8" r="4.25" />
    </>
  ),
  view: (
    <>
      <path d="M8 2 14 5 8 8 2 5z" />
      <path d="m2 8 6 3 6-3M2 11l6 3 6-3" />
    </>
  ),
  team: (
    <>
      <circle cx="6" cy="5.5" r="2.25" />
      <path d="M1.75 13.5a4.25 4.25 0 0 1 8.5 0" />
      <path d="M10.5 3.4a2.25 2.25 0 0 1 0 4.2M12 9.6a4.25 4.25 0 0 1 2.25 3.9" />
    </>
  ),
  hire: (
    <>
      <circle cx="6.5" cy="5.5" r="2.5" />
      <path d="M2 13.5a4.5 4.5 0 0 1 9 0M12.5 5v4M10.5 7h4" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  newIssue: (
    <>
      <path d="M13.5 8.75v3.75a1.5 1.5 0 0 1-1.5 1.5H3.5A1.5 1.5 0 0 1 2 12.5V4a1.5 1.5 0 0 1 1.5-1.5h3.75" />
      <path d="M11.5 1.75a1.4 1.4 0 0 1 2 2L8 9.25 5.75 10l.75-2.25z" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.25 3.25" />
    </>
  ),
  menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  signOut: (
    <>
      <path d="M6 13.5H3.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1H6" />
      <path d="M10.5 11 13.5 8l-3-3M13.5 8H6" />
    </>
  ),
  link: (
    <path d="M6.8 9.2a2.5 2.5 0 0 0 3.5 0l2.2-2.2a2.5 2.5 0 0 0-3.5-3.5l-.8.8M9.2 6.8a2.5 2.5 0 0 0-3.5 0L3.5 9a2.5 2.5 0 0 0 3.5 3.5l.8-.8" />
  ),
  newTab: (
    <>
      <path d="M12.5 9v3.5a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1H7" />
      <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </>
  ),
  edit: (
    <>
      <path d="M10.5 2.5a1.4 1.4 0 0 1 2 2L5.25 11.75l-2.75.75.75-2.75z" />
      <path d="m9.25 3.75 2 2" />
    </>
  ),
  archive: (
    <>
      <rect x="1.75" y="2.5" width="12.5" height="3" rx="0.75" />
      <path d="M3 5.5v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-7M6.5 8.5h3" />
    </>
  ),
  unarchive: (
    <>
      <rect x="1.75" y="2.5" width="12.5" height="3" rx="0.75" />
      <path d="M3 5.5v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-7M8 12V8M6.25 9.5 8 7.75 9.75 9.5" />
    </>
  ),
  trash: (
    <>
      <path d="M2.5 4h11M6 4V2.75A.75.75 0 0 1 6.75 2h2.5a.75.75 0 0 1 .75.75V4" />
      <path d="M3.75 4l.6 8.6a1 1 0 0 0 1 .9h5.3a1 1 0 0 0 1-.9l.6-8.6M6.75 7v3.5M9.25 7v3.5" />
    </>
  ),
  label: (
    <>
      <path d="M2 2.75v4.5a1 1 0 0 0 .3.7l6 6a1 1 0 0 0 1.4 0l4-4a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-.7-.3H2.75a.75.75 0 0 0-.75.5z" />
      <circle cx="5" cy="5" r="0.75" fill="currentColor" />
    </>
  ),
  estimate: (
    <>
      <path d="M8 2.25 14 13H2z" />
      <path d="M8 6.75v2.5" />
    </>
  ),
  calendar: (
    <>
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M5.25 1.75v2.5M10.75 1.75v2.5" />
    </>
  ),
  subIssue: (
    <>
      <path d="M3.5 2.5v6a2 2 0 0 0 2 2H9" />
      <circle cx="11.25" cy="10.5" r="2.25" />
    </>
  ),
  parent: (
    <>
      <circle cx="4.75" cy="4" r="2.25" />
      <path d="M4.75 6.25v3.25a2 2 0 0 0 2 2h6.75M11 9l2.5 2.5L11 14" />
    </>
  ),
  relation: (
    <>
      <circle cx="4" cy="8" r="2" />
      <circle cx="12" cy="8" r="2" />
      <path d="M6 8h4" />
    </>
  ),
  keyboard: (
    <>
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
      <path d="M4.25 6.5h.01M6.75 6.5h.01M9.25 6.5h.01M11.75 6.5h.01M5 9.75h6" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.5v1.25M8 13.25v1.25M14.5 8h-1.25M2.75 8H1.5M12.6 3.4l-.9.9M4.3 11.7l-.9.9M12.6 12.6l-.9-.9M4.3 4.3l-.9-.9" />
    </>
  ),
  moon: <path d="M13.5 9.75A5.75 5.75 0 0 1 6.25 2.5a5.75 5.75 0 1 0 7.25 7.25z" />,
  monitor: (
    <>
      <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.25" />
      <path d="M5.5 14h5M8 11v3" />
    </>
  ),
  open: <path d="M3 8h10M9 4l4 4-4 4" />,
  send: <path d="M8 13V3M4 7l4-4 4 4" />,
  read: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="m5.5 8 1.75 1.75L10.5 6.5" />
    </>
  ),
  unread: <circle cx="8" cy="8" r="3" fill="currentColor" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function AppIcon({ name }: { name: IconName }) {
  return <Icon>{paths[name]}</Icon>;
}

/** An icon for a menu entry or command: `icon: icon("archive")`. */
export const icon = (name: IconName) => <AppIcon name={name} />;
