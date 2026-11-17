interface OrbitMarkProps {
  size?: number;
  className?: string;
}

export function OrbitMark({ size = 40, className = '' }: OrbitMarkProps) {
  return (
    <span
      className={`orbit-mark ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 64 64" width="100%" height="100%" fill="none">
        <circle className="orbit-mark__rim" cx="32" cy="32" r="27" />
        <ellipse
          className="orbit-mark__orbit"
          cx="32"
          cy="32"
          rx="27"
          ry="12.5"
          transform="rotate(-28 32 32)"
        />
        <circle className="orbit-mark__core" cx="32" cy="32" r="7.5" />
        <circle className="orbit-mark__core-halo" cx="32" cy="32" r="12.5" />
        <circle className="orbit-mark__star" cx="52.6" cy="19.5" r="2.4" />
        <circle className="orbit-mark__spark" cx="12.2" cy="44.4" r="1.4" />
      </svg>
    </span>
  );
}
