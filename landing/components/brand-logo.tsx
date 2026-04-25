// SkyBrandMX brand logo — rocket icon + "SKYBRANDMX" wordmark with the
// cyan gradient on letters A, N, X and the brand underline accent.
// Adapted from the master brand asset for the light-themed landing.

interface BrandLogoProps {
  size?: "sm" | "md" | "lg";
  variant?: "light" | "dark"; // light = light background; dark = dark bg
}

export function BrandLogo({ size = "md", variant = "light" }: BrandLogoProps) {
  const iconClass =
    size === "sm" ? "h-6 w-6" : size === "lg" ? "h-9 w-9" : "h-8 w-8";
  const textClass =
    size === "sm"
      ? "text-base"
      : size === "lg"
        ? "text-2xl"
        : "text-lg";

  const inkColor = variant === "dark" ? "#f8fafc" : "#0f1d2c";
  const rocketColor = variant === "dark" ? "#70D1C6" : "#105971";
  const gradientFrom = "#70D1C6";
  const gradientTo = variant === "dark" ? "#f8fafc" : "#0f1d2c";

  return (
    <div className="flex items-center gap-2" aria-label="SkyBrandMX">
      <div className="relative flex h-10 w-10 items-center justify-center">
        <svg
          className={`${iconClass} relative`}
          style={{ color: rocketColor }}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden
        >
          <g style={{ transformOrigin: "center bottom" }}>
            <g
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2L15 6V14C15 14 15 17 12 17C9 17 9 14 9 14V6L12 2Z" />
              <path d="M9 11L6 14H9V11Z" fill="currentColor" />
              <path d="M15 11L18 14H15V11Z" fill="currentColor" />
            </g>
            <g style={{ transformOrigin: "center bottom" }}>
              <path
                d="M9 17C10.5 20 12 22 12 22C12 22 13.5 20 15 17H9Z"
                fill="#ff6600"
              />
              <path
                d="M10 17.5C11 19.5 12 21 12 21C12 21 13 19.5 14 17.5H10Z"
                fill="#ef6f6f"
              />
            </g>
          </g>
        </svg>
      </div>
      <div className="relative inline-flex flex-col">
        <div
          className={`flex items-center font-bold tracking-tight ${textClass}`}
          style={{ color: inkColor }}
        >
          <span>SKYBR</span>
          <span
            className="bg-clip-text text-transparent"
            style={{
              backgroundImage: `linear-gradient(to bottom right, ${gradientFrom} 45%, ${gradientTo} 55%)`,
            }}
          >
            A
          </span>
          <span
            className="bg-clip-text text-transparent"
            style={{
              backgroundImage: `linear-gradient(to bottom right, ${gradientFrom} 45%, ${gradientTo} 55%)`,
            }}
          >
            N
          </span>
          <span>DM</span>
          <span
            className="bg-clip-text text-transparent"
            style={{
              backgroundImage: `linear-gradient(to bottom right, ${gradientFrom} 45%, ${gradientTo} 55%)`,
            }}
          >
            X
          </span>
        </div>
        <div
          className="absolute -bottom-1 left-0 h-[3px] w-[55%] rounded-full"
          style={{
            backgroundImage: "linear-gradient(to right, #70D1C6, #105971)",
          }}
        />
      </div>
    </div>
  );
}
