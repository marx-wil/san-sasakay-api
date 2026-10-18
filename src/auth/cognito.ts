import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  type InitiateAuthCommandOutput,
  MessageActionType,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { decodeJwt } from "jose";
import { env, isCognitoEnabled } from "../config.js";
import { BadRequest, Unauthorized } from "../lib/errors.js";

let client: CognitoIdentityProviderClient | null = null;

function getClient(): CognitoIdentityProviderClient {
  if (!isCognitoEnabled) {
    throw BadRequest(
      "COGNITO_NOT_CONFIGURED",
      "Password sign-in is not available in this environment",
    );
  }
  if (!client) {
    client = new CognitoIdentityProviderClient({ region: env.AWS_REGION });
  }
  return client;
}

function getClientId(): string {
  const clientId = env.COGNITO_CLIENT_ID;
  if (!clientId) {
    throw BadRequest(
      "COGNITO_NOT_CONFIGURED",
      "Password sign-in is not available in this environment",
    );
  }
  return clientId;
}

function getUserPoolId(): string {
  const poolId = env.COGNITO_USER_POOL_ID;
  if (!poolId) {
    throw BadRequest(
      "COGNITO_NOT_CONFIGURED",
      "Password sign-in is not available in this environment",
    );
  }
  return poolId;
}

export type CognitoIdentity = {
  sub: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
};

function parseIdToken(idToken: string): CognitoIdentity {
  const claims = decodeJwt(idToken);
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const email =
    typeof claims.email === "string"
      ? claims.email
      : typeof claims.username === "string"
        ? claims.username
        : "";
  if (!sub || !email) {
    throw Unauthorized("INVALID_TOKEN", "Cognito token is missing required claims");
  }
  const firstName =
    typeof claims.given_name === "string" && claims.given_name.length > 0
      ? claims.given_name
      : null;
  const lastName =
    typeof claims.family_name === "string" && claims.family_name.length > 0
      ? claims.family_name
      : null;
  return { sub, email, firstName, lastName };
}

function mapCognitoError(err: unknown): never {
  const name = (err as { name?: string })?.name ?? "";
  const message = (err as { message?: string })?.message ?? "Authentication failed";
  switch (name) {
    case "UsernameExistsException":
      throw BadRequest("USER_EXISTS", "An account with this email already exists");
    case "NotAuthorizedException":
    case "UserNotFoundException":
      throw Unauthorized("INVALID_CREDENTIALS", "Mali ang email o password");
    case "UserNotConfirmedException":
      throw BadRequest(
        "CONFIRMATION_REQUIRED",
        "I-verify muna ang email mo gamit ang code na ipinadala namin",
      );
    case "InvalidPasswordException":
      throw BadRequest("VALIDATION_ERROR", message);
    case "CodeMismatchException":
      throw BadRequest("INVALID_CODE", "Mali ang verification code");
    case "ExpiredCodeException":
      throw BadRequest("INVALID_CODE", "Expired na ang code. Humiling ng bago.");
    case "InvalidParameterException":
      throw BadRequest("VALIDATION_ERROR", message);
    default:
      throw BadRequest("AUTH_FAILED", message);
  }
}

export async function cognitoSignUp(opts: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phoneE164?: string;
}): Promise<{ userConfirmed: boolean }> {
  try {
    const userAttributes = [
      { Name: "email", Value: opts.email },
      { Name: "given_name", Value: opts.firstName },
      { Name: "family_name", Value: opts.lastName },
    ];
    if (opts.phoneE164) {
      userAttributes.push({ Name: "phone_number", Value: opts.phoneE164 });
    }

    const out = await getClient().send(
      new SignUpCommand({
        ClientId: getClientId(),
        Username: opts.email,
        Password: opts.password,
        UserAttributes: userAttributes,
      }),
    );
    return { userConfirmed: out.UserConfirmed === true };
  } catch (err) {
    mapCognitoError(err);
  }
}

export async function cognitoConfirmSignUp(email: string, code: string): Promise<void> {
  try {
    await getClient().send(
      new ConfirmSignUpCommand({
        ClientId: getClientId(),
        Username: email,
        ConfirmationCode: code,
      }),
    );
  } catch (err) {
    mapCognitoError(err);
  }
}

export type CognitoUserStatus = "CONFIRMED" | "UNCONFIRMED" | "NOT_FOUND";

export async function cognitoGetUserStatus(email: string): Promise<CognitoUserStatus> {
  try {
    const out = await getClient().send(
      new AdminGetUserCommand({
        UserPoolId: getUserPoolId(),
        Username: email,
      }),
    );
    if (out.UserStatus === "CONFIRMED") return "CONFIRMED";
    return "UNCONFIRMED";
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    if (name === "UserNotFoundException") return "NOT_FOUND";
    mapCognitoError(err);
  }
}

export async function cognitoDeleteUser(email: string): Promise<void> {
  try {
    await getClient().send(
      new AdminDeleteUserCommand({
        UserPoolId: getUserPoolId(),
        Username: email,
      }),
    );
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    if (name === "UserNotFoundException") return;
    mapCognitoError(err);
  }
}

/**
 * Create a confirmed Cognito user after our email OTP passed. Suppresses Cognito's
 * own verification email — the app already verified the address.
 */
export async function cognitoCreateConfirmedUser(opts: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phoneE164?: string;
}): Promise<void> {
  const userAttributes = [
    { Name: "email", Value: opts.email },
    { Name: "email_verified", Value: "true" },
    { Name: "given_name", Value: opts.firstName },
    { Name: "family_name", Value: opts.lastName },
  ];
  if (opts.phoneE164) {
    userAttributes.push({ Name: "phone_number", Value: opts.phoneE164 });
  }

  try {
    await getClient().send(
      new AdminCreateUserCommand({
        UserPoolId: getUserPoolId(),
        Username: opts.email,
        MessageAction: MessageActionType.SUPPRESS,
        TemporaryPassword: opts.password,
        UserAttributes: userAttributes,
      }),
    );
    await getClient().send(
      new AdminSetUserPasswordCommand({
        UserPoolId: getUserPoolId(),
        Username: opts.email,
        Password: opts.password,
        Permanent: true,
      }),
    );
  } catch (err) {
    mapCognitoError(err);
  }
}

export async function cognitoPasswordLogin(
  email: string,
  password: string,
): Promise<CognitoIdentity> {
  let out: InitiateAuthCommandOutput;
  try {
    out = await getClient().send(
      new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: getClientId(),
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      }),
    );
  } catch (err) {
    mapCognitoError(err);
  }

  const idToken = out.AuthenticationResult?.IdToken;
  if (!idToken) {
    throw Unauthorized("INVALID_CREDENTIALS", "Mali ang email o password");
  }
  return parseIdToken(idToken);
}
