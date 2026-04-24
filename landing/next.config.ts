import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle at `.next/standalone/server.js` so the
  // Docker runtime stage can run Node directly without the full repo tree.
  // See: https://nextjs.org/docs/pages/api-reference/config/next-config-js/output
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
