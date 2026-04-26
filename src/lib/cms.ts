import prisma from './prisma.js';

/**
 * Get a text template from the database
 * @param slug The content block slug
 * @param fallback Default text if block not found
 * @returns The template string
 */
export async function getTemplate(
  slug: string,
  fallback: string,
): Promise<string> {
  try {
    const block = await prisma.contentBlock.findUnique({
      where: { slug },
    });
    return block?.content || fallback;
  } catch (error) {
    console.error(`[CMS] Error fetching template ${slug}:`, error);
    return fallback;
  }
}
