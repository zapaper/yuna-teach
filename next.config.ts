import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: path.resolve(__dirname),
  },
  // @napi-rs/canvas ships a .node native binding loaded via require(), and
  // pdfjs-dist's legacy build uses Node-only APIs. Both need to stay
  // out of the bundler so Node loads them at runtime on the server.
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  // pdfjs-dist dynamically imports its worker file at runtime; the
  // standalone tracer doesn't see that import, so we tell it to copy
  // the worker into the deployed bundle for the inbound-email route.
  outputFileTracingIncludes: {
    "/api/inbound-email/route": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  // Off-load avatar assets to Cloudflare R2 so they don't ship with
  // every Railway deploy (333 MB → 0 in the build context). Any
  // request to /avatars/X here gets a 308 to R2; the browser caches
  // the redirect so subsequent visits hit R2 directly. Set
  // NEXT_PUBLIC_AVATAR_BASE_URL on Railway to your R2 public URL
  // (e.g. https://pub-xxxxx.r2.dev or https://cdn.markforyou.com).
  async redirects() {
    const avatarBase = process.env.NEXT_PUBLIC_AVATAR_BASE_URL;
    if (!avatarBase) return [];
    return [
      {
        source: "/avatars/:path*",
        destination: `${avatarBase}/avatars/:path*`,
        permanent: true,
      },
    ];
  },
  // Long-lived immutable caching for static assets (pet clips, landscape
  // images, stickers, sound effects). These files are named per pet/action so
  // a change means a new filename anyway — safe to set a 1-year max-age.
  async headers() {
    return [
      {
        source: "/avatars/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/stickers/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/sounds/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      // Signup / login hero images and logo — rarely change, large-ish PNGs.
      {
        source: "/:file(step1|step2|step3|logo_t).png",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      // Landing-page hero photo. Same idea — content rarely changes, and a
      // re-fetch on every new tab is wasteful (~225 KB).
      {
        source: "/:file(girlmom).jpg",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      // OpenCV.js runtime for the in-app document scanner. 10MB; copied
      // out of node_modules at install time (scripts/copy-opencv.mjs).
      // First scanner open downloads it, every subsequent open is
      // instant from cache.
      {
        source: "/vendor/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
