import { SITE_URL } from "./seo";
import type { BlogPostMeta } from "./blog";

// --- JsonLd component ---

export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}

// --- Organization ---

export function organizationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "webhooks.cc",
    url: SITE_URL,
    logo: `${SITE_URL}/icon.png`,
    sameAs: ["https://github.com/kroqdotdev/webhooks-cc"],
    description:
      "Webhook testing tools for developers. Capture, inspect, forward, and test webhooks with a dashboard, CLI, TypeScript SDK, and MCP server for AI agents.",
  };
}

// --- SoftwareApplication ---

export function softwareApplicationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "webhooks.cc",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    url: SITE_URL,
    downloadUrl: `${SITE_URL}/installation`,
    description:
      "Webhook testing tools for developers. Capture and inspect webhooks, forward to localhost with the CLI, test programmatically with the TypeScript SDK, and connect AI coding agents via MCP server.",
    featureList: [
      "Webhook capture and inspection",
      "Mock response configuration",
      "CLI tunneling to localhost",
      "TypeScript SDK for test assertions",
      "MCP server for AI coding agents",
      "Real-time SSE streaming",
      "Request replay",
    ],
    author: {
      "@type": "Organization",
      name: "webhooks.cc",
      url: SITE_URL,
    },
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
  };
}

// --- FAQPage ---

export interface FAQItem {
  question: string;
  answer: string;
}

export function faqSchema(items: FAQItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

// --- HowTo ---

export interface HowToStep {
  name: string;
  text: string;
  url?: string;
}

export function howToSchema(params: {
  name: string;
  description: string;
  steps: HowToStep[];
  totalTime?: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: params.name,
    description: params.description,
    ...(params.totalTime && { totalTime: params.totalTime }),
    step: params.steps.map((step, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name: step.name,
      text: step.text,
      ...(step.url && { url: step.url }),
    })),
  };
}

// --- BreadcrumbList ---

export interface BreadcrumbItem {
  name: string;
  path: string;
}

export function breadcrumbSchema(items: BreadcrumbItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: `${SITE_URL}${item.path}`,
    })),
  };
}

// --- BlogPosting ---

export function blogPostingSchema(post: BlogPostMeta) {
  const datePublished = new Date(`${post.publishedAt}T00:00:00.000Z`).toISOString();
  const dateModified = new Date(`${post.updatedAt}T00:00:00.000Z`).toISOString();
  const url = `${SITE_URL}${post.href}`;

  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    url,
    mainEntityOfPage: url,
    datePublished,
    dateModified,
    articleSection: post.category,
    keywords: [...post.tags],
    inLanguage: "en-US",
    isAccessibleForFree: true,
    image: `${SITE_URL}/og-image.png`,
    author: {
      "@type": "Organization",
      name: "webhooks.cc",
      url: SITE_URL,
    },
    publisher: {
      "@type": "Organization",
      name: "webhooks.cc",
      url: SITE_URL,
      logo: {
        "@type": "ImageObject",
        url: `${SITE_URL}/icon.png`,
      },
    },
  };
}
