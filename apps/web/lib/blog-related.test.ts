import { describe, expect, it } from "vitest";
import { pickRelatedPosts } from "./blog-related";

// Newest first, as listPublishedBlogPosts() returns them.
const posts = [
  { slug: "teams-launch", category: "Product", tags: ["Teams", "Billing"] },
  { slug: "teams-cli", category: "Product", tags: ["Teams", "CLI"] },
  { slug: "nextjs-handler", category: "Testing", tags: ["Next.js", "Stripe", "TypeScript"] },
  { slug: "retry-testing", category: "Testing", tags: ["Mock responses", "Retries"] },
  { slug: "mock-rules", category: "Product", tags: ["Mock Responses", "Testing"] },
  { slug: "stripe-local", category: "Local Development", tags: ["Stripe", "CLI tunnel"] },
];

describe("pickRelatedPosts", () => {
  it("prefers shared tags, then the category, ignoring tag case", () => {
    const related = pickRelatedPosts(posts[3], posts, 2);
    expect(related.map((p) => p.slug)).toEqual(["mock-rules", "nextjs-handler"]);
  });

  it("ranks a shared tag above a shared category", () => {
    const related = pickRelatedPosts(posts[5], posts);
    expect(related[0].slug).toBe("nextjs-handler");
  });

  it("never returns the post itself", () => {
    const related = pickRelatedPosts(posts[0], posts, 10);
    expect(related.map((p) => p.slug)).not.toContain("teams-launch");
    expect(related).toHaveLength(posts.length - 1);
  });

  it("breaks ties with the posts published closest to it, not the newest", () => {
    const unrelated = ["a", "b", "c", "d", "e"].map((slug) => ({
      slug,
      category: slug,
      tags: [slug],
    }));
    const related = pickRelatedPosts(unrelated[2], unrelated, 2);
    expect(related.map((p) => p.slug)).toEqual(["b", "d"]);
  });

  it("falls back to the newest posts for a post outside the list", () => {
    const lone = { slug: "lone", category: "Security", tags: ["SSRF"] };
    const related = pickRelatedPosts(lone, posts);
    expect(related.map((p) => p.slug)).toEqual(["teams-launch", "teams-cli", "nextjs-handler"]);
  });
});
