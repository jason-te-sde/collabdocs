/**
 * Whether a request may reach the credentials sign-in. Auth.js takes the action and the
 * provider from the path after the base, ignoring empty segments (`parseActionAndProviderId`),
 * so `/callback/credentials/`, `/callback//credentials` and similar all sign in. A suffix
 * match on the raw path would miss them. Here the path is split the same way and the
 * limiter applies when any segment names the credentials provider, in any case and after
 * percent-decoding: it fails closed, so no spelling of the URL can skip it. Next.js
 * redirects most of these spellings to the canonical one before this handler runs
 * (308, keeping the method and body), but that is a routing setting, not a guarantee.
 */
export function reachesCredentials(pathname: string): boolean {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Not decodable: Auth.js would not read it as a provider either, but the raw segments are checked.
  }
  return [pathname, decoded].some((path) =>
    path
      .split("/")
      .filter(Boolean)
      .some((segment) => segment.toLowerCase() === "credentials"),
  );
}
