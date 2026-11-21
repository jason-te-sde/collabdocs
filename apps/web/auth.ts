import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import { authenticate } from "@/lib/credentials";
import { getDb } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";
import { bindPendingInvites } from "@/lib/verification";

const providers: Provider[] = [
  Credentials({
    credentials: { email: {}, password: {} },
    authorize: (credentials) => authenticate(credentials),
  }),
];

// The GitHub button exists only when the OAuth app is configured.
if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
  // No allowDangerousEmailAccountLinking: a GitHub email is not proof that the
  // person owns the password account with the same email, so Auth.js refuses
  // to merge them.
  providers.push(GitHub);
}

/**
 * Asks GitHub whether it verified this address. Auth.js does not carry that fact
 * into the user it creates, so it is asked again, with the account's own token.
 */
async function githubVerifiedEmail(email: string, accessToken: string): Promise<boolean> {
  try {
    const response = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "collabdocs" },
    });
    if (!response.ok) return false;
    const emails = (await response.json()) as Array<{ email?: string; verified?: boolean }>;
    return emails.some(
      (entry) =>
        entry.verified === true &&
        typeof entry.email === "string" &&
        normalizeEmail(entry.email) === normalizeEmail(email),
    );
  } catch {
    return false;
  }
}

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const db = getDb();
  const base = PrismaAdapter(db);
  return {
    // The credentials provider requires JWT sessions, so the adapter serves
    // only the GitHub users and accounts.
    adapter: {
      ...base,
      createUser: (data) =>
        db.user.create({ data: { ...data, email: normalizeEmail(data.email) } }),
      getUserByEmail: (email) => db.user.findUnique({ where: { email: normalizeEmail(email) } }),
    },
    providers,
    session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
    events: {
      // A new GitHub user's address counts as verified when GitHub says that it verified
      // it; the invitations held for the address are then applied. Otherwise the user
      // verifies it like anyone else, with the emailed link.
      async linkAccount({ user, account }) {
        if (account.provider !== "github") return;
        if (!user.id || !user.email || typeof account.access_token !== "string") return;
        const { id, email } = user;
        if (!(await githubVerifiedEmail(email, account.access_token))) return;
        await db.$transaction(async (tx) => {
          await tx.user.update({ where: { id }, data: { emailVerified: new Date() } });
          await bindPendingInvites(tx, id, email);
        });
      },
    },
    callbacks: {
      session({ session, token }) {
        if (token.sub && session.user) session.user.id = token.sub;
        return session;
      },
    },
  };
});
