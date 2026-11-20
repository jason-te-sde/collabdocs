/**
 * Where the browser finds the collab server. Next.js inlines NEXT_PUBLIC_*
 * variables at build time, so this is fixed when the app is built.
 */
export const COLLAB_URL = process.env.NEXT_PUBLIC_COLLAB_URL ?? "http://localhost:4000";
