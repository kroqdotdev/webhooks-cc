export interface RelatedCandidate {
  slug: string;
  category: string;
  tags: readonly string[];
}

/**
 * Posts that share tags with this one, then its category; among equals, the
 * posts published closest to it. Taking the newest posts instead gave every
 * post the same links, which left older posts linked from /blog alone and out
 * of Google's index. `posts` must be in publishing order, as
 * listPublishedBlogPosts() returns them.
 */
export function pickRelatedPosts<T extends RelatedCandidate>(
  post: RelatedCandidate,
  posts: readonly T[],
  limit = 3
): T[] {
  const tags = new Set(post.tags.map((tag) => tag.toLowerCase()));
  const category = post.category.toLowerCase();
  const position = posts.findIndex((other) => other.slug === post.slug);

  return posts
    .map((other, index) => {
      const shared = other.tags.filter((tag) => tags.has(tag.toLowerCase())).length;
      const sameCategory = other.category.toLowerCase() === category ? 1 : 0;
      const distance = position === -1 ? index : Math.abs(index - position);
      return { other, distance, score: shared * 2 + sameCategory };
    })
    .filter(({ other }) => other.slug !== post.slug)
    .sort((a, b) => b.score - a.score || a.distance - b.distance)
    .slice(0, limit)
    .map(({ other }) => other);
}
