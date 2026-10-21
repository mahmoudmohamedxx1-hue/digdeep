/**
 * v3.4.1 AUDIT FIX — SSRF guard for user-supplied callback/probe URLs.
 *
 * Webhook destinations and endpoint probes are fetched BY OUR SERVER, so a
 * URL is a request the platform will make on someone's behalf. Before this
 * guard, http://localhost:9222, http://169.254.169.254/ (cloud metadata),
 * http://10.0.0.5/… were all accepted — classic SSRF surface.
 *
 * Blocked: non-http(s) schemes, embedded credentials, localhost/.local/
 * .internal names, IPv4 loopback/private/CGNAT/link-local/multicast/reserved
 * ranges, IPv6 loopback/ULA/link-local/multicast, and invalid IPv4 literals.
 *
 * Honest limitation (documented, accepted): a PUBLIC DNS name that resolves
 * to a private address (DNS-rebinding style) still passes — IP-literal and
 * name-based blocking cannot see through DNS. Full protection would need
 * resolve-then-connect pinning, out of scope for a Hobby deployment.
 */
export function isPublicHttpUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false; // no credentialed URLs
  const h = u.hostname.toLowerCase().replace(/\.$/, ""); // strip FQDN dot

  // localhost-family names
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return false;

  // IPv4 literal
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return false;
    const [a, b] = o;
    if (a === 0 || a === 10 || a === 127) return false; // this-network, private, loopback
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
    if (a === 169 && b === 254) return false; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a >= 224) return false; // multicast + reserved
    return true;
  }

  // IPv6 literal (hostname keeps brackets for URLs like http://[::1]:8080/)
  if (h.startsWith("[") && h.endsWith("]")) {
    const v6 = h.slice(1, -1).toLowerCase();
    if (v6 === "::" || v6 === "::1") return false; // unspecified + loopback
    if (/^f[cd][0-9a-f]{2}:/.test(v6)) return false; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(v6)) return false; // fe80::/10 link-local
    if (v6.startsWith("ff")) return false; // multicast
    return true;
  }

  return true; // ordinary public DNS name
}
