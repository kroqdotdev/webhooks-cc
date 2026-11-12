import { describe, expect, it } from "vitest";
import { VERIFY_PROVIDERS, verifySignature } from "@webhooks-cc/sdk";
import {
  SIGNATURE_PRESETS,
  checkProviderSignature,
  computeHmac,
  getSignaturePreset,
  headerLines,
  parseHeaderText,
  signProviderPayload,
  signaturesMatch,
  type HmacInput,
} from "./signature";

// RFC-style test vector: key "key", message below.
const FOX = "The quick brown fox jumps over the lazy dog";
const BASE: HmacInput = {
  secret: "key",
  secretEncoding: "utf8",
  payload: FOX,
  algorithm: "SHA-256",
  encoding: "hex",
};

async function signatureOf(input: Partial<HmacInput>): Promise<string> {
  const result = await computeHmac({ ...BASE, ...input });
  if (!result.ok) throw new Error(result.problem);
  return result.signature;
}

describe("computeHmac", () => {
  it("matches the published vectors for each algorithm", async () => {
    expect(await signatureOf({})).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
    );
    expect(await signatureOf({ algorithm: "SHA-1" })).toBe(
      "de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9"
    );
    expect(await signatureOf({ algorithm: "SHA-512" })).toBe(
      "b42af09057bac1e2d41708e48a902e09b5ff7f12ab428a4fe86653c73dd248fb82f948a549f7b791a5b41915ee4d1ec3935357e4e2317250d0372afa2ebeeb3a"
    );
    expect(await signatureOf({ algorithm: "SHA-384" })).toHaveLength(96);
  });

  it("encodes the same bytes as hex, Base64 and Base64url", async () => {
    const hex = await signatureOf({});
    const base64 = await signatureOf({ encoding: "base64" });
    expect(Buffer.from(base64, "base64").toString("hex")).toBe(hex);
    expect(base64).toBe("97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=");
    expect(await signatureOf({ encoding: "base64url" })).toBe(
      "97yD9DBThCSxMpjmqm-xQ-9NWaFJRhdZl0edvC0aPNg"
    );
  });

  it("reads the secret as text, hex or Base64", async () => {
    const expected = await signatureOf({});
    expect(await signatureOf({ secret: "6b6579", secretEncoding: "hex" })).toBe(expected);
    expect(await signatureOf({ secret: "6B 65 79", secretEncoding: "hex" })).toBe(expected);
    expect(await signatureOf({ secret: "a2V5", secretEncoding: "base64" })).toBe(expected);
  });

  it("signs an empty payload and counts every byte of a full one", async () => {
    expect(await signatureOf({ payload: "" })).toHaveLength(64);
    expect(await signatureOf({ payload: `${FOX}\n` })).not.toBe(await signatureOf({}));
    expect(await signatureOf({ payload: "café" })).toHaveLength(64);
  });

  it("says what is wrong with the secret", async () => {
    const problem = async (input: Partial<HmacInput>) => {
      const result = await computeHmac({ ...BASE, ...input });
      return result.ok ? "" : result.problem;
    };
    expect(await problem({ secret: "" })).toMatch(/Enter the secret/);
    expect(await problem({ secret: "xyz", secretEncoding: "hex" })).toMatch(/not hex/);
    expect(await problem({ secret: "abc", secretEncoding: "hex" })).toMatch(/not hex/);
    expect(await problem({ secret: "not base64!", secretEncoding: "base64" })).toMatch(
      /not valid Base64/
    );
  });
});

describe("signaturesMatch", () => {
  const hex = "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8";

  it("reads hex in either case, with a header's label or quotes around it", () => {
    expect(signaturesMatch(hex, hex.toUpperCase(), "hex")).toBe(true);
    expect(signaturesMatch(hex, `  sha256=${hex} `, "hex")).toBe(true);
    expect(signaturesMatch(hex, `"${hex}"`, "hex")).toBe(true);
    expect(signaturesMatch(hex, `v1=${hex}`, "hex")).toBe(true);
    expect(signaturesMatch(hex, hex.replace("f7", "f8"), "hex")).toBe(false);
    expect(signaturesMatch(hex, hex.slice(0, -2), "hex")).toBe(false);
    expect(signaturesMatch(hex, "", "hex")).toBe(false);
  });

  it("reads Base64 in either alphabet, padded or not, and keeps its case", () => {
    const base64 = "97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=";
    expect(signaturesMatch(base64, "97yD9DBThCSxMpjmqm-xQ-9NWaFJRhdZl0edvC0aPNg", "base64")).toBe(
      true
    );
    expect(signaturesMatch(base64, base64, "base64url")).toBe(true);
    expect(signaturesMatch(base64, base64.toLowerCase(), "base64")).toBe(false);
  });
});

describe("parseHeaderText", () => {
  it("reads header lines as curl, a log or the dashboard show them", () => {
    expect(
      parseHeaderText(
        [
          "POST /hooks/stripe HTTP/1.1",
          "> Content-Type: application/json",
          "Stripe-Signature: t=1,v1=abc",
          "",
          "X-Empty:",
        ].join("\r\n")
      )
    ).toEqual({
      ok: true,
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1,v1=abc",
        "x-empty": "",
      },
    });
  });

  it("reads a JSON object of headers", () => {
    expect(parseHeaderText('{"X-Hub-Signature-256": "sha256=ab", "x-list": ["a", "b"]}')).toEqual({
      ok: true,
      headers: { "x-hub-signature-256": "sha256=ab", "x-list": "a, b" },
    });
  });

  it("says what it could not read", () => {
    expect(parseHeaderText("  ")).toEqual({ ok: false, problem: "Paste the request's headers." });
    expect(parseHeaderText("just some words")).toEqual({
      ok: false,
      problem: '"just some words" is not a header. Write Name: value.',
    });
    expect(parseHeaderText("bad name: x")).toEqual({
      ok: false,
      problem: '"bad name" is not a header name.',
    });
  });
});

describe("provider presets", () => {
  const PAYLOAD = '{"id":"evt_1","type":"ping","amount": 12}';
  const URL = "https://example.com/hooks?source=test";

  it("offers every scheme the SDK verifies, bar the ones that are no header HMAC", () => {
    const offered = SIGNATURE_PRESETS.map((preset) => preset.id).sort();
    const leftOut = VERIFY_PROVIDERS.filter((provider) => !getSignaturePreset(provider)).sort();
    expect(leftOut).toEqual([
      "adyen",
      "discord",
      "gitlab",
      "hubspot",
      "mailgun",
      "paypal",
      "telegram",
    ]);
    expect(offered).toHaveLength(VERIFY_PROVIDERS.length - leftOut.length);
    for (const preset of SIGNATURE_PRESETS) {
      expect(preset.header, preset.id).not.toBe("");
      expect(preset.label, preset.id).not.toBe(preset.id);
      expect(preset.algorithm, preset.id).toMatch(/^HMAC-SHA(1|256)/);
    }
    expect(getSignaturePreset("docusign")).toMatchObject({
      label: "DocuSign",
      header: "x-docusign-signature-1",
    });
  });

  it("signs a payload with each preset and checks it again, to the byte", async () => {
    for (const preset of SIGNATURE_PRESETS) {
      const input = { preset, secret: "a secret with spaces", payload: PAYLOAD, url: URL };
      const signed = await signProviderPayload(input);
      if (!signed.ok) throw new Error(`${preset.id}: ${signed.problem}`);
      const names = signed.headers.map(([name]) => name);
      expect(names, preset.id).toContain(preset.header);
      // Only the headers the check needs: nothing every request carries.
      expect(names, preset.id).not.toContain("content-type");
      expect(names.length, preset.id).toBeLessThanOrEqual(3);

      const headersText = headerLines(signed.headers);
      expect(await checkProviderSignature({ ...input, headersText }), preset.id).toEqual({
        ok: true,
        valid: true,
        missing: null,
      });
      expect(
        await checkProviderSignature({ ...input, headersText, payload: `${PAYLOAD} ` }),
        preset.id
      ).toEqual({ ok: true, valid: false, missing: null });
      expect(
        await checkProviderSignature({ ...input, headersText, secret: "another secret" }),
        preset.id
      ).toEqual({ ok: true, valid: false, missing: null });
    }
  });

  it("names the signature header when the pasted headers lack it", async () => {
    const preset = getSignaturePreset("github")!;
    expect(
      await checkProviderSignature({
        preset,
        secret: "s",
        payload: PAYLOAD,
        headersText: "content-type: application/json",
        url: "",
      })
    ).toEqual({ ok: true, valid: false, missing: "x-hub-signature-256" });
  });

  it("asks for the URL exactly where the SDK's check needs one", async () => {
    for (const preset of SIGNATURE_PRESETS) {
      const check = verifySignature(
        { body: PAYLOAD, headers: { [preset.header]: "x" } },
        { provider: preset.id, secret: "s" }
      );
      if (preset.needsUrl) await expect(check, preset.id).rejects.toThrow(/requires options\.url/);
      else await expect(check, preset.id).resolves.toEqual({ valid: false });
    }
    const twilio = getSignaturePreset("twilio")!;
    const input = { preset: twilio, secret: "s", payload: "a=1", headersText: "x: y" };
    expect(await checkProviderSignature({ ...input, url: "" })).toEqual({
      ok: false,
      problem: "This provider signs the URL too. Enter the full URL the webhook was sent to.",
    });
    expect(await signProviderPayload({ ...input, url: "example.com/hook" })).toEqual({
      ok: false,
      problem: "The webhook URL should be a full URL starting with https://.",
    });
  });

  it("checks a GitHub signature computed by hand", async () => {
    const secret = "It's a Secret to Everybody";
    const payload = "Hello, World!";
    // The example in GitHub's "Validating webhook deliveries" documentation.
    const header =
      "X-Hub-Signature-256: sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(
      await checkProviderSignature({
        preset: getSignaturePreset("github")!,
        secret,
        payload,
        headersText: header,
        url: "",
      })
    ).toEqual({ ok: true, valid: true, missing: null });
    const hmac = await computeHmac({
      secret,
      secretEncoding: "utf8",
      payload,
      algorithm: "SHA-256",
      encoding: "hex",
    });
    expect(hmac).toEqual({
      ok: true,
      signature: "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    });
  });

  it("asks for a secret and headers before checking", async () => {
    const preset = getSignaturePreset("stripe")!;
    const input = { preset, secret: "", payload: PAYLOAD, headersText: "", url: "" };
    expect(await checkProviderSignature(input)).toEqual({
      ok: false,
      problem: "Enter the webhook's signing secret.",
    });
    expect(await checkProviderSignature({ ...input, secret: "s" })).toEqual({
      ok: false,
      problem: "Paste the request's headers.",
    });
    expect(await signProviderPayload(input)).toEqual({
      ok: false,
      problem: "Enter the webhook's signing secret.",
    });
  });
});

describe("verdicts", () => {
  it("says what a check found", async () => {
    const { explainComparison, explainProviderCheck } = await import("./signature");
    const github = getSignaturePreset("github")!;
    expect(explainProviderCheck(github, { valid: true, missing: null })).toMatchObject({
      outcome: "ok",
      title: "Signature valid",
    });
    expect(
      explainProviderCheck(github, { valid: false, missing: "x-hub-signature-256" }).detail
    ).toBe(
      "GitHub sends its signature in the x-hub-signature-256 header, and the headers pasted here do not have it."
    );
    expect(explainProviderCheck(github, { valid: false, missing: null }).title).toBe(
      "Signature does not match"
    );
    const twilio = getSignaturePreset("twilio")!;
    expect(explainProviderCheck(twilio, { valid: false, missing: null }).detail).toContain(
      "with this secret and URL."
    );
    expect(explainComparison(true).outcome).toBe("ok");
    expect(explainComparison(false).title).toBe("Signatures differ");
  });
});
