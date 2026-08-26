import type { NextConfig } from "next";

const apiInternalBaseUrl = process.env.API_INTERNAL_BASE_URL ?? "http://127.0.0.1:3001";
const parsedApiUrl = new URL(apiInternalBaseUrl);
if (
  (parsedApiUrl.protocol !== "http:" && parsedApiUrl.protocol !== "https:")
  || parsedApiUrl.origin !== apiInternalBaseUrl
  || parsedApiUrl.username !== ""
  || parsedApiUrl.password !== ""
) {
  throw new Error("API_INTERNAL_BASE_URL must be an HTTP origin without credentials or a path");
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  poweredByHeader: false,
  reactStrictMode: true,
  headers: () => [{
    source: "/verify",
    headers: [
      { key: "Cache-Control", value: "no-store" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
      { key: "X-Content-Type-Options", value: "nosniff" }
    ]
  }],
  rewrites: () => [{
    source: "/api/:path*",
    destination: `${apiInternalBaseUrl}/api/:path*`
  }],
  turbopack: {
    resolveAlias: {
      "@certificate-platform/contracts": "../../packages/contracts/dist/index.js",
      "@certificate-platform/template-engine": "../../packages/template-engine/dist/index.js"
    }
  }
};

export default nextConfig;
