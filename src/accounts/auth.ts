// Accounts on Engines' page (spec #1 §5, decision Q12; E-15): Better Auth with
// email and Google sign-in, organisations, members and invitations.
//
// Better Auth's tables use Engines' naming (snake_case), and its organisation
// model *is* Engines' `organisations` table, so every `org_id` in the schema
// points at the same organisations people sign in to. API keys stay Engines'
// own (`api_keys`: hashed, per-key caps and provider), managed on the page;
// see ADR 0002.
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { organization } from "better-auth/plugins";
import type pg from "pg";
import type { AuthSettings } from "../shared/config.ts";
import { newId } from "../shared/ids.ts";

/** camelCase field names → snake_case columns. */
function snake(...fields: string[]): Record<string, string> {
  return Object.fromEntries(
    fields.map((f) => [f, f.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]),
  );
}

const ID_PREFIX: Record<string, string> = {
  user: "usr",
  session: "ses",
  account: "acc",
  verification: "ver",
  organization: "org",
  member: "mem",
  invitation: "inv",
};

export function authOptions(pool: pg.Pool, config: AuthSettings) {
  return {
    database: pool,
    baseURL: config.baseURL,
    basePath: "/api/auth",
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    ...(config.google
      ? {
          socialProviders: {
            google: {
              clientId: config.google.clientId,
              clientSecret: config.google.clientSecret,
            },
          },
        }
      : {}),
    advanced: {
      // Cloud Run puts the caller's address here; sign-in rate limits key on it.
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
      database: {
        generateId: ({ model }) => newId(ID_PREFIX[model] ?? model.slice(0, 3)),
      },
    },
    user: {
      modelName: "users",
      fields: snake("emailVerified", "createdAt", "updatedAt"),
    },
    session: {
      modelName: "sessions",
      fields: snake(
        "expiresAt",
        "createdAt",
        "updatedAt",
        "ipAddress",
        "userAgent",
        "userId",
      ),
    },
    account: {
      modelName: "accounts",
      fields: snake(
        "accountId",
        "providerId",
        "userId",
        "accessToken",
        "refreshToken",
        "idToken",
        "accessTokenExpiresAt",
        "refreshTokenExpiresAt",
        "createdAt",
        "updatedAt",
      ),
    },
    verification: {
      modelName: "verifications",
      fields: snake("expiresAt", "createdAt", "updatedAt"),
    },
    plugins: [
      organization({
        // Invitations are shared as links on the page until email sending
        // exists, so nobody's email is verified by mail yet. Accepting still
        // needs the invited email signed in, and the link (ADR 0002).
        sendInvitationEmail: () => Promise.resolve(),
        requireEmailVerificationOnInvitation: false,
        // Documents, keys and the credit ledger belong to the organisation.
        disableOrganizationDeletion: true,
        schema: {
          organization: {
            modelName: "organisations",
            fields: snake("createdAt"),
          },
          member: {
            modelName: "members",
            fields: {
              organizationId: "org_id",
              ...snake("userId", "createdAt"),
            },
          },
          invitation: {
            modelName: "invitations",
            fields: {
              organizationId: "org_id",
              ...snake("expiresAt", "inviterId", "createdAt"),
            },
          },
          session: { fields: snake("activeOrganizationId") },
        },
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(pool: pg.Pool, config: AuthSettings) {
  return betterAuth(authOptions(pool, config));
}

export type Auth = ReturnType<typeof createAuth>;
