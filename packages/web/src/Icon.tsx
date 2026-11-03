const PATHS: Record<string, string> = {
  folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l2 2.4h7.3A2.5 2.5 0 0 1 20.5 10v6.5A2.5 2.5 0 0 1 18 19H5.5A2.5 2.5 0 0 1 3 16.5z',
  download: 'M12 3.5v10.5M7.5 10.5 12 15l4.5-4.5M4.5 19.5h15',
  check: 'M4.5 12.5 9.5 17.5 19.5 6.5',
  hash: 'M4 9h16M4 15h16M10 3.5v17M14 3.5v17',
  alert: 'M12 8v5M12 16.8v.2M12 3.8 2.9 19.2h18.2z',
  'chevron-down': 'M6.5 9.5 12 15l5.5-5.5',
  'chevron-up': 'M17.5 14.5 12 9l-5.5 5.5',
  mcp: 'M3.5 6.5h17v11h-17zM7 11l3 2.5-3 2.5',
  skill: 'M12 3.5l2.3 5.4 5.4 2.3-5.4 2.3L12 19l-2.3-5.5L4.3 11.2l5.4-2.3z',
  prompt: 'M3.5 5.5h17v10h-9l-4.5 3.5v-3.5h-3.5z',
  knowledge: 'M4 5.5A2 2 0 0 1 6 3.5h5v17H6a2 2 0 0 1-2-2zM13 3.5h5a2 2 0 0 1 2 2v13h-7',
  config: 'M4 8h8M16 8h4M4 16h4M12 16h8',
  tool: 'M14.5 3.5a5 5 0 0 0-6.4 6.2L3.5 14.3a2 2 0 1 0 2.8 2.8l4.6-4.6a5 5 0 0 0 6.2-6.4l-2.6 2.6-2.4-.4-.4-2.4z',
};

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const d = PATHS[name] ?? PATHS.tool!;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}
