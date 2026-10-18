import type { FastifyInstance } from "fastify";
import { hashIdentifier } from "./magic-link.js";
import {
  attachPhoneIfProvided,
  findOrCreateUserByEmailHash,
  stampEarlyAdopter,
  touchLastSeen,
} from "./users.js";

export type AuthSessionUser = {
  id: string;
  displayName: string | null;
  hasPhone: boolean;
  phoneRequired: boolean;
};

export type AuthSessionPayload = {
  token: string;
  user: AuthSessionUser;
};

export async function issueSessionForEmail(
  app: FastifyInstance,
  opts: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    phone?: string;
  },
): Promise<AuthSessionPayload> {
  const normalizedEmail = opts.email.trim().toLowerCase();
  const emailHash = hashIdentifier(normalizedEmail);

  const {
    userId,
    displayName,
    hasPhone: hadPhone,
  } = await findOrCreateUserByEmailHash(emailHash, {
    firstName: opts.firstName,
    lastName: opts.lastName,
  });

  let hasPhone = hadPhone;
  if (opts.phone) {
    const attached = await attachPhoneIfProvided(userId, opts.phone);
    if (attached) hasPhone = true;
  }

  await stampEarlyAdopter(userId, emailHash);
  await touchLastSeen(userId);

  const accessToken = app.jwt.sign({ sub: userId });

  return {
    token: accessToken,
    user: {
      id: userId,
      displayName,
      hasPhone,
      phoneRequired: !hasPhone,
    },
  };
}
