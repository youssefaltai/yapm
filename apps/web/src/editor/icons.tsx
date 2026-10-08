import type { ReactNode } from "react";

function Icon({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function Glyph({ text }: { text: string }) {
  return (
    <span aria-hidden className="text-[11px] font-semibold leading-none">
      {text}
    </span>
  );
}

export const icons = {
  text: <Glyph text="T" />,
  h1: <Glyph text="H1" />,
  h2: <Glyph text="H2" />,
  h3: <Glyph text="H3" />,
  bold: <Glyph text="B" />,
  italic: (
    <span aria-hidden className="font-serif text-[13px] italic leading-none">
      I
    </span>
  ),
  strike: (
    <span aria-hidden className="text-[12px] leading-none line-through">
      S
    </span>
  ),
  bullet: (
    <Icon>
      <circle cx="3" cy="4" r="0.8" fill="currentColor" />
      <circle cx="3" cy="8" r="0.8" fill="currentColor" />
      <circle cx="3" cy="12" r="0.8" fill="currentColor" />
      <path d="M6.5 4h7M6.5 8h7M6.5 12h7" />
    </Icon>
  ),
  numbered: (
    <Icon>
      <path d="M2.5 3h1v3M2.5 6h2M2.3 10a1 1 0 0 1 1.9.3c0 .8-1.9 1.4-1.9 2.2h2M6.5 4h7M6.5 8h7M6.5 12h7" />
    </Icon>
  ),
  check: (
    <Icon>
      <rect x="2" y="2" width="12" height="12" rx="3" />
      <path d="m5 8 2 2 4-4" />
    </Icon>
  ),
  quote: (
    <Icon>
      <path d="M3 3v10M6.5 4.5h7M6.5 8h7M6.5 11.5h4" />
    </Icon>
  ),
  code: (
    <Icon>
      <path d="m5.5 4.5-3 3.5 3 3.5M10.5 4.5l3 3.5-3 3.5" />
    </Icon>
  ),
  codeBlock: (
    <Icon>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="m6 6.5-1.5 1.5L6 9.5M10 6.5l1.5 1.5L10 9.5" />
    </Icon>
  ),
  divider: (
    <Icon>
      <path d="M2 8h12" />
    </Icon>
  ),
  table: (
    <Icon>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M2 10h12M6.5 6.5v7" />
    </Icon>
  ),
  collapsible: (
    <Icon>
      <path d="m4 6 2 2-2 2M8.5 8h5.5M2 3h12M2 13h12" />
    </Icon>
  ),
  link: (
    <Icon>
      <path d="M6.8 9.2a2.5 2.5 0 0 0 3.5 0l2.2-2.2a2.5 2.5 0 0 0-3.5-3.5l-.8.8M9.2 6.8a2.5 2.5 0 0 0-3.5 0L3.5 9a2.5 2.5 0 0 0 3.5 3.5l.8-.8" />
    </Icon>
  ),
  mention: (
    <Icon>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M10.5 8v1a1.8 1.8 0 0 0 3.5 0V8a6 6 0 1 0-2.4 4.8" />
    </Icon>
  ),
  emoji: (
    <Icon>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.5 9.5a3 3 0 0 0 5 0" />
      <circle cx="6" cy="6.5" r="0.5" fill="currentColor" />
      <circle cx="10" cy="6.5" r="0.5" fill="currentColor" />
    </Icon>
  ),
  image: (
    <Icon>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <circle cx="6" cy="6.5" r="1.2" />
      <path d="m2.5 12 3.5-3.5 2.5 2.5 2-2 3 3" />
    </Icon>
  ),
  chevron: (
    <Icon size={12}>
      <path d="m6 4 4 4-4 4" />
    </Icon>
  ),
  copy: (
    <Icon size={12}>
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </Icon>
  ),
};
