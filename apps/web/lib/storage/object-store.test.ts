import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted((): Record<string, string | undefined> => ({
  OBJECT_STORAGE_ENDPOINT: "https://storage.example.com/",
  OBJECT_STORAGE_REGION: "eu-central",
  OBJECT_STORAGE_BUCKET: "mail",
  OBJECT_STORAGE_ACCESS_KEY_ID: "AKIDEXAMPLE",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
}));
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));

const { contentDisposition, deletePrefix, deleteKeys, listKeys, objectStorageConfig, presignGet } =
  await import("./object-store");

afterEach(() => vi.unstubAllGlobals());

describe("object storage", () => {
  it("reads its settings and drops a trailing slash", () => {
    expect(objectStorageConfig()).toMatchObject({
      endpoint: "https://storage.example.com",
      region: "eu-central",
      bucket: "mail",
    });
  });

  it("refuses half a configuration rather than reading it as none", () => {
    const bucket = env.OBJECT_STORAGE_BUCKET;
    env.OBJECT_STORAGE_BUCKET = undefined;
    try {
      expect(() => objectStorageConfig()).toThrow(/set all of OBJECT_STORAGE_ENDPOINT/);
    } finally {
      env.OBJECT_STORAGE_BUCKET = bucket;
    }
  });

  it("presigns path-style GET links with a capped lifetime and a download name", async () => {
    const url = new URL(
      await presignGet("m/abc/a/0", 30 * 24 * 3600, "Rapport été.csv", "text/csv")
    );
    expect(url.origin + url.pathname).toBe("https://storage.example.com/mail/m/abc/a/0");
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(7 * 24 * 3600));
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("X-Amz-Credential")).toContain("/eu-central/s3/aws4_request");
    expect(url.searchParams.get("response-content-disposition")).toContain(
      "filename*=UTF-8''Rapport%20%C3%A9t%C3%A9.csv"
    );
    expect(url.searchParams.get("response-content-type")).toBe("text/csv");
  });

  it("writes an ASCII fallback name without quotes or control characters", () => {
    expect(contentDisposition('a"b\\c\u0001.txt')).toBe(
      "attachment; filename=\"a_b_c_.txt\"; filename*=UTF-8''a%22b%5Cc%01.txt"
    );
  });

  it("lists across pages and unescapes keys", async () => {
    const pages = [
      `<ListBucketResult><Contents><Key>m/x/raw.eml</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;1</NextContinuationToken></ListBucketResult>`,
      `<ListBucketResult><Contents><Key>m/x/a/0</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`,
    ];
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string) => {
        seen.push(typeof input === "string" ? input : input.url);
        return new Response(pages.shift()!, { status: 200 });
      })
    );
    expect(await listKeys("m/x/")).toEqual(["m/x/raw.eml", "m/x/a/0"]);
    expect(seen[1]).toContain("continuation-token=t%261");
  });

  it("lists keys whose elements carry a namespace prefix", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            `<s3:ListBucketResult xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/"><s3:Contents><s3:Key>m/x/raw.eml</s3:Key></s3:Contents><s3:IsTruncated>false</s3:IsTruncated></s3:ListBucketResult>`,
            { status: 200 }
          )
      )
    );
    expect(await listKeys("m/x/")).toEqual(["m/x/raw.eml"]);
  });

  it("deletes with a Content-MD5 and fails on per-key errors", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request) => {
        expect(input.headers.get("content-md5")).toMatch(/^[A-Za-z0-9+/]+=*$/);
        bodies.push(await input.text());
        return new Response("<DeleteResult></DeleteResult>", { status: 200 });
      })
    );
    await deleteKeys(["m/x/a&b"]);
    expect(bodies[0]).toContain("<Key>m/x/a&amp;b</Key>");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<DeleteResult><Error><Code>AccessDenied</Code></Error></DeleteResult>")
      )
    );
    await expect(deleteKeys(["m/x/a"])).rejects.toThrow(/refused a delete/);
  });

  it("refuses to delete anything but a request prefix", async () => {
    await expect(deletePrefix("m/")).rejects.toThrow(/request prefix/);
    await expect(deletePrefix("")).rejects.toThrow(/request prefix/);
  });
});
