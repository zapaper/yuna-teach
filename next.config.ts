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
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
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
    ];
  },
};

export default nextConfig;
