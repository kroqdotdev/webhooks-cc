import { describe, expect, it } from "vitest";
import { GET } from "./route";
import { GET as getSkillFile } from "../../[name]/[...path]/route";

const PREFIX = "/.well-known/agent-skills/";

function oldUrl(path: string[]) {
  return GET(new Request(`https://webhooks.cc${PREFIX}webhook-testing/x`), {
    params: Promise.resolve({ path }),
  });
}

describe("GET /.well-known/agent-skills/webhook-testing/{path}", () => {
  it.each([[["SKILL.md"]], [["references", "sdk-tests.md"]]])(
    "sends %j to the same file under the skill's new name",
    async (path) => {
      const response = await oldUrl(path);
      expect(response.status).toBe(308);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      const location = response.headers.get("location")!;
      expect(location).toBe(`${PREFIX}webhooks-cc/${path.join("/")}`);

      const [name, ...rest] = location.slice(PREFIX.length).split("/");
      const target = await getSkillFile(new Request(`https://webhooks.cc${location}`), {
        params: Promise.resolve({ name, path: rest }),
      });
      expect(target.status).toBe(200);
    }
  );

  it("never leaves this host or the skill's path", async () => {
    const response = await oldUrl(["//evil.example", "x.md"]);
    expect(response.headers.get("location")).toBe(`${PREFIX}webhooks-cc/%2F%2Fevil.example/x.md`);
  });
});
