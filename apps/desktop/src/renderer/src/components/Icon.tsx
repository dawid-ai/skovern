// SF-Symbol-style line icons, drawn by hand for design A (loop 049). Inline SVG only: the
// strict CSP allows nothing remote, and icons are decoration, so every one is aria-hidden.
// Paths are copied from the approved mockup (app-a.html) so the app matches it stroke for stroke.

const PATHS = {
  sparkles: ["M11 3.5l1.7 4.6 4.6 1.7-4.6 1.7L11 16.1l-1.7-4.6-4.6-1.7 4.6-1.7z", "M18.5 14l.8 2.1 2.2.9-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.9z"],
  chat: ["M4 11.5C4 7.4 7.6 4.5 12 4.5s8 2.9 8 7-3.6 7-8 7c-1 0-2-.1-2.9-.4L5 19.5l1.2-3.3C4.8 15 4 13.4 4 11.5z"],
  brain: [
    "M12 5.6A3 3 0 0 0 6.7 4.9 3 3 0 0 0 4.3 9a3 3 0 0 0 .3 5.2A3 3 0 0 0 7.6 19a3 3 0 0 0 4.4.4",
    "M12 5.6a3 3 0 0 1 5.3-.7A3 3 0 0 1 19.7 9a3 3 0 0 1-.3 5.2 3 3 0 0 1-3 4.8 3 3 0 0 1-4.4.4",
    "M12 5.6v13.8M8 10.5c1 0 2 .6 2 1.8M16 10.5c-1 0-2 .6-2 1.8",
  ],
  envelope: ["M6 5.5h12a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 16V8A2.5 2.5 0 0 1 6 5.5z", "M4.3 7.3 12 13l7.7-5.7"],
  wand: ["M4.5 19.5 14 10", "M14.5 4l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z", "M19 11.5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z"],
  receipt: ["M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3z", "M9 8h6M9 11.5h6M9 15h4"],
  sliders: [
    "M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1",
    "M17 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM11 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM19 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0z",
  ],
  arrowUp: ["M12 19V5.5M6.5 11 12 5.5l5.5 5.5"],
  arrowDown: ["M12 5v13.5M6.5 13l5.5 5.5 5.5-5.5"],
  house: ["M4 11.2 12 4.5l8 6.7", "M6.2 9.5V19h11.6V9.5", "M10 19v-4.5h4V19"],
  compose: ["M12.5 4.5h-6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6", "M17.5 3.5l3 3L12 15l-4 1 1-4z"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  chevUp: ["M6 14.5l6-6 6 6"],
  chevDown: ["M6 9.5l6 6 6-6"],
  chevLeft: ["M14.5 5.5 8 12l6.5 6.5"],
  chevRight: ["M9.5 5.5 16 12l-6.5 6.5"],
  top: ["M6 5h12M7 14l5-5 5 5M12 9v10"],
  bottom: ["M6 19h12M7 10l5 5 5-5M12 15V5"],
  lock: ["M8 10.5h8a2.5 2.5 0 0 1 2.5 2.5v4.5A2.5 2.5 0 0 1 16 20H8a2.5 2.5 0 0 1-2.5-2.5V13A2.5 2.5 0 0 1 8 10.5z", "M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"],
  refresh: ["M19.5 12a7.5 7.5 0 1 1-2.2-5.3", "M19.5 4.5v4h-4"],
  stop: [],
  share: ["M12 15V4M8 8l4-4 4 4", "M6 11.5v7a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-7"],
  cpu: ["M8.5 6.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z", "M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"],
  download: ["M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17z", "M12 7.5v8M8.5 12.5 12 16l3.5-3.5"],
  gift: ["M5 9h14a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1z", "M5.5 13v6.5h13V13M12 9v10.5M12 9c-1-3-4.5-4-5-2s2.5 2 5 2c2.5 0 5.5 0 5-2s-4-1-5 2"],
  signOut: ["M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14", "M10 16l-4-4 4-4M6 12h9.5"],
  link: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ? `ic ${className}` : "ic"} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {name === "stop" ? (
        <rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none" />
      ) : (
        PATHS[name].map((d) => <path key={d} d={d} />)
      )}
    </svg>
  );
}
