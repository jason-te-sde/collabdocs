import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  transpilePackages: ["@collabdocs/shared"],
  serverExternalPackages: ["@node-rs/argon2", "pg", "ioredis"],
  // The repo root is the workspace root, so Next resolves @collabdocs/shared from there.
  turbopack: { root: path.join(import.meta.dirname, "../..") },
};

export default config;
