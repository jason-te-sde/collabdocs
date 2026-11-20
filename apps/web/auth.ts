import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import { authenticate } from "@/lib/credentials";
import { getDb } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";

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
    callbacks: {
      session({ session, token }) {
        if (token.sub && session.user) session.user.id = token.sub;
        return session;
      },
    },
  };
});
