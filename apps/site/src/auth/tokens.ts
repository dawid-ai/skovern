import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// A token is `id.secret`. The id is a public lookup key we can index and query
// on; the secret is the part that proves possession. We store only a hash of
// the secret, so a database leak never yields a usable token.
const ID_BYTES = 16;
const SECRET_BYTES = 32;

export interface OpaqueToken {
  /** Public lookup key — safe to store and query in plaintext. */
  id: string;
  /** The full `id.secret` string that goes to the user. Never persisted. */
  full: string;
  /** SHA-256 of the secret half (hex). This is all the DB ever sees. */
  secretHash: string;
}

export function createOpaqueToken(): OpaqueToken {
  const id = randomBytes(ID_BYTES).toString("base64url");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return { id, full: `${id}.${secret}`, secretHash: sha256(secret) };
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface ParsedToken {
  id: string;
  secret: string;
}

export function parseToken(full: string): ParsedToken | null {
  const dot = full.indexOf(".");
  if (dot <= 0 || dot >= full.length - 1) return null;
  return { id: full.slice(0, dot), secret: full.slice(dot + 1) };
}

/** Constant-time check that `secret` hashes to `expectedHash`. */
export function secretMatches(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(sha256(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
