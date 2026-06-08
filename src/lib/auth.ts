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
import { prisma } from "./db";
import { DEFAULT_TRIAL_DAYS } from "./subscription";

// Apple web sign-in disabled. The Apple form_post callback needed
// SameSite=None cookies for pkceCodeVerifier — that broke Google
// sign-in on privacy-strict browsers (Chrome incognito, Brave,
// Safari ITP) with InvalidCheck. Apple web traffic was tiny;
// re-introduce later via a different flow that doesn't require
// SameSite=None. iOS app users still get Apple via the native
// Capacitor plugin → /api/auth/native-oauth, unaffected by this.

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true, // we serve under www.markforyou.com behind proxies
  // Don't issue NextAuth's own session cookie as a long-lived
  // identity — we set yuna_session manually in /post-login. JWT
  // mode keeps the lib happy without persisting Sessions in the DB.
  session: { strategy: "jwt", maxAge: 60 * 60 }, // short — only used during the OAuth handshake

  // Cookie defaults left at NextAuth's stock SameSite=Lax. We
  // previously overrode pkceCodeVerifier / state / callbackUrl /
  // nonce to SameSite=None so Apple's response_mode=form_post POST
  // callback could carry them. That broke Google sign-in on
  // privacy-strict browsers (Chrome incognito, Brave, Safari ITP)
  // because those clients refuse to store / send SameSite=None
  // cookies — every Google OAuth round-trip would fail PKCE check
  // with "InvalidCheck: pkceCodeVerifier value could not be parsed".
  // Apple web sign-in is the casualty (very low traffic; iOS native
  // sign-in via /api/auth/native-oauth is unaffected and still
  // works). Re-introducing Apple web later needs a different
  // mechanism (e.g. response_mode=query) that doesn't lose Lax
  // cookies on POST.

  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      // Email scope is the default; explicit so anyone reading the
      // file knows what we ask for.
      authorization: { params: { scope: "openid email profile" } },
    }),
  ],

  // Custom error / signin pages. Without these, NextAuth's default
  // error path is /api/auth/error — a built-in plain HTML page that
  // doesn't link back anywhere. When an OAuth round-trip fails (mid-
  // deploy state lost, CSRF mismatch, Google rejected the consent),
  // the user lands on /api/auth/error and is stuck. Pointing
  // `pages.error` at /login makes NextAuth redirect there with
  // `?error=<code>` so we can surface a message and the user can
  // retry. signIn similarly returns to /login.
  pages: {
    signIn: "/login",
    error: "/login",
  },

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
      const provider = account?.provider; // "google" | "apple"
      const providerAccountId = account?.providerAccountId;
      console.log(`[oauth] signIn provider=${provider} accountId=${providerAccountId} userEmail=${user?.email ?? "none"} profileEmail=${(profile as { email?: string } | undefined)?.email ?? "none"}`);
      if (!account) {
        console.warn("[oauth] no account on signIn callback — aborting");
        return false;
      }
      // Apple only sends name on the very first sign-in for a user.
      // Google sends it every time. Both come through `user.name`
      // when present — fall back to email-derived for Apple repeats.
      const email =
        (profile as { email?: string } | undefined)?.email ??
        user.email ??
        null;
      if (!email) {
        console.warn(`[oauth] no email from ${provider} — aborting`);
        return false;
      }
      const name = user.name ?? email.split("@")[0];

      // Step 1: provider-id match (fastest path for repeat users)
      const idColumn = provider === "google" ? "googleId" : provider === "apple" ? "appleId" : null;
      if (!idColumn) {
        console.warn(`[oauth] unknown provider ${provider}`);
        return false;
      }

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

      // NOTE: deliberately NOT calling setSession() here. Auth.js v5
      // doesn't reliably propagate cookies written inside the
      // signIn callback to the final OAuth-callback response — the
      // browser would receive the redirect without the cookie and
      // /post-login would think no one was signed in. Instead we
      // stash the user id on the NextAuth JWT (see jwt callback
      // below) and let /post-login read it through auth() and set
      // yuna_session there. NextAuth's own session cookie carries
      // the JWT to the next request reliably.
      console.log(`[oauth] signIn ok: ${provider} → user=${dbUser.id} (${dbUser.email})`);

      return true;
    },

    /** Stamp our internal user id onto the NextAuth JWT so the
     *  post-login dispatcher can read it without another DB
     *  lookup. */
    async jwt({ token, user, account }) {
      // First time through after a successful signIn — `user` and
      // `account` are populated. Re-read our user by provider id
      // so we get the upserted DB row.
      if (account && user?.email) {
        const idColumn = account.provider === "google" ? "googleId" : account.provider === "apple" ? "appleId" : null;
        if (idColumn) {
          const dbUser = await prisma.user.findFirst({
            where: { [idColumn]: account.providerAccountId },
            select: { id: true },
          });
          if (dbUser) (token as { uid?: string }).uid = dbUser.id;
        }
      }
      return token;
    },

    /** Copy the JWT-stamped uid into the session object so
     *  /post-login can read it via auth(). */
    async session({ session, token }) {
      const t = token as { uid?: string };
      if (t.uid) (session as unknown as { uid?: string }).uid = t.uid;
      return session;
    },

    /**
     * Where to send the user after a successful sign-in. The signIn
     * callback above already set our `yuna_session` cookie, but
     * NextAuth's default redirect to "/" / baseUrl just lands the
     * user on the marketing homepage. Bouncing through /post-login
     * lets a server route read the cookie and redirect to
     * /home/<id>. Honour an explicit same-site path when one is
     * passed (e.g. parent-deeplinks landing here via `next=`).
     */
    async redirect({ url, baseUrl }) {
      console.log(`[oauth] redirect callback url=${url} baseUrl=${baseUrl}`);
      // Bare baseUrl / "/" → our dispatcher.
      if (url === "/" || url === baseUrl || url === `${baseUrl}/`) {
        return `${baseUrl}/post-login`;
      }
      if (url.startsWith("/") && !url.startsWith("//")) return `${baseUrl}${url}`;
      if (url.startsWith(baseUrl)) return url;
      return `${baseUrl}/post-login`;
    },
  },
});
