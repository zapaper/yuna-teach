// Auth.js (NextAuth v5) configuration. This sits ALONGSIDE the
// existing username/password flow — it only handles Google + Apple
// OAuth. After a successful OAuth sign-in we upsert into our User
// table and set our existing `yuna_session` cookie (HMAC-signed,
// see src/lib/session.ts) so all the gates and admin code that
// trust that cookie keep working unchanged.
//
// Why hybrid: full NextAuth would force a database adapter,
// Account/Session tables, and a different session cookie shape.
// We already have a working session, gates, redirect logic, etc.
// — switching everything is much more risk than benefit. Letting
// Auth.js own only the OAuth dance is the cheap path.

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Apple from "next-auth/providers/apple";
import { prisma } from "./db";
import { setSession } from "./session";
import { DEFAULT_TRIAL_DAYS } from "./subscription";

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true, // we serve under www.markforyou.com behind proxies
  // Don't issue NextAuth's own session cookie — we set yuna_session
  // manually in the signIn callback. JWT mode keeps the lib happy
  // without persisting Sessions in the DB.
  session: { strategy: "jwt", maxAge: 60 * 60 }, // short — only used during the OAuth handshake

  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      // Email scope is the default; explicit so anyone reading the
      // file knows what we ask for.
      authorization: { params: { scope: "openid email profile" } },
    }),
    Apple({
      clientId: process.env.APPLE_CLIENT_ID,
      // The "client secret" for Apple is a JWT signed with the .p8
      // key from Apple Developer. Auth.js generates it for us when
      // given the components below. Set these in env vars:
      //   APPLE_TEAM_ID       — 10-char team id from Apple Developer
      //   APPLE_KEY_ID        — 10-char key id of the .p8
      //   APPLE_PRIVATE_KEY   — full .p8 contents (BEGIN/END lines)
      clientSecret: undefined, // Auth.js builds it from the env triple
    }),
  ],

  callbacks: {
    /**
     * Runs after the OAuth provider returns. We use it to:
     * 1. Find or create the User in our table (lookup by provider id
     *    first, fall back to email — auto-links an existing
     *    username+password user who later signs in with Google).
     * 2. Set our `yuna_session` cookie so the redirect downstream
     *    works with all our existing gates.
     * Returning false aborts the sign-in. We always return true.
     */
    async signIn({ user, account, profile }) {
      if (!account) return false;
      const provider = account.provider; // "google" | "apple"
      const providerAccountId = account.providerAccountId;
      // Apple only sends name on the very first sign-in for a user.
      // Google sends it every time. Both come through `user.name`
      // when present — fall back to email-derived for Apple repeats.
      const email =
        (profile as { email?: string } | undefined)?.email ??
        user.email ??
        null;
      if (!email) return false;
      const name = user.name ?? email.split("@")[0];

      // Step 1: provider-id match (fastest path for repeat users)
      const idColumn = provider === "google" ? "googleId" : provider === "apple" ? "appleId" : null;
      if (!idColumn) return false;

      let dbUser = await prisma.user.findFirst({
        where: { [idColumn]: providerAccountId },
      });

      // Step 2: email match — auto-link an existing local account
      if (!dbUser) {
        dbUser = await prisma.user.findFirst({
          where: { email: { equals: email, mode: "insensitive" } },
        });
        if (dbUser) {
          await prisma.user.update({
            where: { id: dbUser.id },
            data: { [idColumn]: providerAccountId, emailVerified: true },
          });
        }
      }

      // Step 3: brand-new user — create with role PARENT (only
      // parents have email) and a fresh trial window matching the
      // /api/users signup flow.
      if (!dbUser) {
        const trialEndsAt = new Date(Date.now() + DEFAULT_TRIAL_DAYS * 24 * 60 * 60 * 1000);
        dbUser = await prisma.user.create({
          data: {
            name,
            email,
            password: crypto.randomUUID(), // unguessable, never used — OAuth-only
            role: "PARENT",
            emailVerified: true,
            subscriptionStatus: "trialing",
            trialEndsAt,
            [idColumn]: providerAccountId,
          },
        });
      }

      // Set our session cookie. signIn callback runs server-side in
      // the OAuth callback route, so cookies().set() works here.
      await setSession(dbUser.id);

      return true;
    },

    /**
     * Where to send the user after a successful sign-in. The signIn
     * callback above already set our `yuna_session` cookie, but
     * NextAuth's default redirect to "/" doesn't know which home
     * page belongs to which user. Bouncing through /post-login lets
     * a server route read the cookie and redirect to /home/<id>.
     * Honour an explicit callbackUrl when it's a same-site path.
     */
    async redirect({ url, baseUrl }) {
      if (url.startsWith("/") && !url.startsWith("//")) return `${baseUrl}${url}`;
      if (url.startsWith(baseUrl)) return url;
      return `${baseUrl}/post-login`;
    },
  },
});
