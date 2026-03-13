import { z } from "zod";

const blogPostStatusSchema = z.enum(["draft", "published"]);
const schemaTypeSchema = z.enum(["howto", "tech-article", "faq", "blog-posting"]);
const changeFrequencySchema = z.enum(["weekly", "monthly", "yearly"]);

export const createBlogPostSchema = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  content: z.string(),
  category: z.string(),
  readMinutes: z.number(),
  tags: z.array(z.string()),
  status: blogPostStatusSchema,
  authorName: z.string(),
  seoTitle: z.string(),
  seoDescription: z.string(),
  canonicalUrl: z.string().optional(),
  featured: z.boolean(),
  keywords: z.array(z.string()),
  schemaType: schemaTypeSchema,
  changeFrequency: changeFrequencySchema,
  priority: z.number(),
});

export const updateBlogPostSchema = createBlogPostSchema
  .omit({
    slug: true,
  })
  .partial();

export type CreateBlogPostInput = z.infer<typeof createBlogPostSchema>;
export type UpdateBlogPostInput = z.infer<typeof updateBlogPostSchema>;
