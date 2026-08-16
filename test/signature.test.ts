import { describe, expect, it } from "vitest";
import { signBody, verifySignature } from "../src/signature.js";

describe("TR-Signature", () => {
  const secret = "test-signing-secret";
  const body = Buffer.from('{"model":"demo","stream":false}');
  const timestamp = 1_700_000_000;
  const vector = "t=1700000000,v1=a7597e2bfa4bc480b058f31a24542b3ab0c99fe6231ae15aa0498fd5bd1d4304";

  it("matches the contract test vector", () => {
    expect(signBody(secret, timestamp, body)).toBe(vector);
    expect(verifySignature(vector, secret, body, timestamp)).toEqual({ ok: true, timestamp });
  });

  it("verifies exact raw bytes rather than reserialized JSON", () => {
    const differentlySpaced = Buffer.from('{ "model": "demo", "stream": false }');
    expect(verifySignature(vector, secret, differentlySpaced, timestamp)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects stale, future, malformed, and mismatched signatures", () => {
    expect(verifySignature(vector, secret, body, timestamp + 301)).toEqual({ ok: false, reason: "expired" });
    expect(verifySignature(vector, secret, body, timestamp - 301)).toEqual({ ok: false, reason: "expired" });
    expect(verifySignature("nope", secret, body, timestamp)).toEqual({ ok: false, reason: "malformed" });
    expect(verifySignature(undefined, secret, body, timestamp)).toEqual({ ok: false, reason: "missing" });
    expect(verifySignature(vector, "wrong-secret", body, timestamp)).toEqual({ ok: false, reason: "mismatch" });
  });
});
