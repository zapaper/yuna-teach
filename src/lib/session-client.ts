// Client-side companion to src/lib/session.ts.
//
// The real session cookie (`yuna_session`) is HttpOnly — JS can't
// read it, by design, so it can't be exfiltrated by an XSS. To let
// the client cheaply skip /api/* fetches when the user has no
// session, src/lib/session.ts mirrors a NON-HttpOnly presence flag
// (`yuna_session_present=1`) at login and clears it at logout. JS
// reads that flag here.
//
// What this gives us: pages with mount-time data fetches (the
// parent dashboard, admin views, etc.) can skip the fetch when
// hasSessionCookie() === false, instead of firing 401-bound
// requests that pollute the server log and waste a round-trip.
//
// Security: the real /api/* auth check still happens in the
// middleware via the signed cookie. This is purely a client-side
// optimisation — a malicious client setting the flag manually
// gains nothing, because the middleware ignores it entirely.

export function hasSessionCookie(): boolean {
  if (typeof document === "undefined") return false; // SSR
  // document.cookie is a single "k=v; k=v; ..." string. A presence
  // flag of literal "1" is what setSession writes; treat anything
  // else (or an explicit empty value from clearSession) as "no
  // session".
  return /(?:^|; )yuna_session_present=1(?:;|$)/.test(document.cookie);
}
