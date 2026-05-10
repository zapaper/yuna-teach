// Auth.js v5 mounts both GET and POST handlers at this catch-all.
// The /api/auth/* routes used here:
//   GET  /api/auth/signin           — Auth.js' built-in provider list page
//   GET  /api/auth/csrf             — CSRF token for the POST below
//   POST /api/auth/signin/<provider>— start OAuth dance
//   GET  /api/auth/callback/<provider> — OAuth callback
//   GET  /api/auth/session          — current session (we don't use this — see hybrid note in src/lib/auth.ts)
//   POST /api/auth/signout          — Auth.js sign-out (our app uses
//                                     DELETE /api/auth instead, which
//                                     clears our yuna_session cookie)

import { handlers } from "@/lib/auth";
export const { GET, POST } = handlers;
