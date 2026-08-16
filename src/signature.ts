import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureVerification =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" };

export function signBody(secret: string, timestamp: number, rawBody: Buffer): string {
  const digest = createHmac("sha256", secret)
    .update(String(timestamp), "utf8")
    .update(".", "utf8")
    .update(rawBody)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function verifySignature(
  header: string | string[] | undefined,
  secret: string,
  rawBody: Buffer,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): SignatureVerification {
  if (!header || Array.isArray(header)) return { ok: false, reason: "missing" };

  const parts = new Map<string, string>();
  for (const item of header.split(",")) {
    const separator = item.indexOf("=");
    if (separator <= 0) return { ok: false, reason: "malformed" };
    parts.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
  }

  const timestampText = parts.get("t");
  const suppliedHex = parts.get("v1");
  if (!timestampText || !/^\d+$/.test(timestampText) || !suppliedHex || !/^[a-fA-F0-9]{64}$/.test(suppliedHex)) {
    return { ok: false, reason: "malformed" };
  }

  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp)) return { ok: false, reason: "malformed" };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { ok: false, reason: "expired" };

  const expected = createHmac("sha256", secret)
    .update(timestampText, "utf8")
    .update(".", "utf8")
    .update(rawBody)
    .digest();
  const supplied = Buffer.from(suppliedHex, "hex");

  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, timestamp };
}

export function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
