import { timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { parse } from "cookie";

export const ADMIN_ACCESS_COOKIE = "scribe_admin_access";
const ADMIN_ACCESS_SCOPE = "scribe-admin-gate";
const encoder = new TextEncoder();

function signingKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Admin access is unavailable because the session secret is missing.");
  return encoder.encode(`${secret}:${ADMIN_ACCESS_SCOPE}`);
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** Server-only verification of the separately configured admin credentials. */
export function verifyAdminCredentials(username: string, password: string) {
  const configuredUsername = process.env.SCRIBE_ADMIN_USERNAME;
  const configuredPassword = process.env.SCRIBE_ADMIN_PASSWORD;
  if (!configuredUsername || !configuredPassword) {
    throw new Error("Admin credentials have not been configured.");
  }
  return safeEqual(username, configuredUsername) && safeEqual(password, configuredPassword);
}

export async function issueAdminAccessToken(openId: string) {
  return new SignJWT({ scope: ADMIN_ACCESS_SCOPE })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(openId)
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(signingKey());
}

export async function verifyAdminAccessToken(token: string, openId: string) {
  try {
    const { payload } = await jwtVerify(token, signingKey());
    return payload.scope === ADMIN_ACCESS_SCOPE && payload.sub === openId;
  } catch {
    return false;
  }
}

export function getAdminAccessToken(cookieHeader: string | undefined) {
  return parse(cookieHeader ?? "")[ADMIN_ACCESS_COOKIE];
}
