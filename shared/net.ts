/**
 * Returns true when the given hostname is a loopback address
 * (localhost, 127.0.0.1, or ::1).
 */
export function isLoopbackHost(hostname: string | undefined | null): boolean {
  const value = String(hostname || "").trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

/**
 * Returns true when the Origin (or Referer) header comes from a trusted
 * loopback address (127.0.0.1 / localhost / ::1).  Requests with no Origin
 * header (e.g. same-origin navigations, curl) are also accepted since the
 * CORS policy already blocks cross-origin preflights from untrusted origins.
 */
export function isLoopbackOrigin(headerValue: string | undefined): boolean {
  if (!headerValue) return true; // same-origin / non-browser
  try {
    const url = new URL(headerValue);
    return isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}
