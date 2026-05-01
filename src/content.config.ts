import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const linkSchema = z.object({
  text: z.string(),
  href: z.string(),
  external: z.boolean().optional(),
});

const blockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("heading"),
    text: z.string(),
    level: z.number().int().min(1).max(6).optional(),
    links: z.array(linkSchema).default([]),
  }),
  z.object({
    type: z.literal("paragraph"),
    text: z.string(),
    links: z.array(linkSchema).default([]),
  }),
  z.object({
    type: z.literal("preformatted"),
    text: z.string(),
    links: z.array(linkSchema).default([]),
  }),
  z.object({
    type: z.literal("figure"),
    src: z.string(),
    alt: z.string().default(""),
    caption: z.string().default(""),
    width: z.string().nullable().optional(),
    height: z.string().nullable().optional(),
    links: z.array(linkSchema).default([]),
  }),
  z.object({
    type: z.literal("list"),
    ordered: z.boolean().default(false),
    items: z.array(
      z.object({
        text: z.string(),
        links: z.array(linkSchema).default([]),
      }),
    ),
  }),
]);

const pageSchema = z.object({
  slug: z.string(),
  legacy_path: z.string(),
  section: z.string(),
  archetype: z.string(),
  title: z.string(),
  heading: z.string().default(""),
  description: z.string().default(""),
  source_encoding: z.string(),
  blocks: z.array(blockSchema),
  images: z.array(
    z.object({
      src: z.string(),
      alt: z.string().default(""),
      caption: z.string().default(""),
      legacy_src: z.string(),
    }),
  ),
  out_links: z.array(z.string()).default([]),
});

const pages = defineCollection({
  loader: glob({
    pattern: "**/*.json",
    base: "./content",
  }),
  schema: pageSchema,
});

export const collections = { pages };
