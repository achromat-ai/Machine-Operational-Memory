/** Small inline icons. Decorative: each is hidden from assistive technology, and the control that holds it carries the name. */

const BASE = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false } as const;

export function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg {...BASE} {...(className ? { className } : {})}>
      <path d="M6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5" />
      <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5" />
    </svg>
  );
}

export function CopyIcon({ className }: { className?: string }) {
  return (
    <svg {...BASE} {...(className ? { className } : {})}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </svg>
  );
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg {...BASE} {...(className ? { className } : {})}>
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

export function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg {...BASE} {...(className ? { className } : {})}>
      <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
    </svg>
  );
}
