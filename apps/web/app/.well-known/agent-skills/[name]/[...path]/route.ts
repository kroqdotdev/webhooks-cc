import {
  AGENT_SKILLS_HEADERS,
  listSkillFiles,
  listSkillNames,
  readSkillFile,
} from "@/lib/agent-skills";

// Every file is prerendered at build time next to the index, and any other
// path is a 404 without running this handler.
export const dynamic = "force-static";
export const dynamicParams = false;

export async function generateStaticParams() {
  const params: { name: string; path: string[] }[] = [];
  for (const name of await listSkillNames()) {
    for (const file of await listSkillFiles(name)) {
      params.push({ name, path: file });
    }
  }
  return params;
}

/**
 * A skill's SKILL.md, byte for byte (the index's digest covers these bytes),
 * and the markdown files it links to by relative path.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string; path: string[] }> }
) {
  const { name, path } = await params;
  const bytes = await readSkillFile(name, path);
  if (!bytes) {
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(new Uint8Array(bytes), {
    headers: { ...AGENT_SKILLS_HEADERS, "Content-Type": "text/markdown; charset=utf-8" },
  });
}
