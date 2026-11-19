import { NAV_SECTIONS } from '../navigation';

export interface Crumb {
  label: string;
  href?: string;
}

// Directories that hold pages outside the sidebar, mapped to a readable section label
const DIR_LABELS: Record<string, string> = {
  'get-started': 'Get Started',
  concepts: 'Concepts',
  features: 'Features',
  guide: 'Guides',
  reference: 'Reference',
  scenarios: 'Scenarios',
};

/**
 * Builds the breadcrumb trail for a docs page: Docs > Section > Page.
 * Pages with no section return an empty trail. Pages listed in the sidebar use the sidebar's section and item titles so the trail matches
 * the navigation; pages outside the sidebar fall back to their directory and frontmatter title.
 */
export function docsCrumbs(slug: string, title: string, base: string): Crumb[] {
  const docsHome: Crumb = { label: 'Docs', href: `${base}docs/get-started/installation/` };
  const section = NAV_SECTIONS.find((s) => s.items.some((i) => i.slug === slug));
  if (section) {
    const item = section.items.find((i) => i.slug === slug)!;
    return [docsHome, { label: section.title, href: `${base}docs/${section.items[0].slug}/` }, { label: item.title }];
  }

  const dir = slug.includes('/') ? slug.split('/')[0] : '';
  const label = DIR_LABELS[dir];
  const first = NAV_SECTIONS.find((s) => s.dir === dir)?.items[0];
  if (label && first) {
    return [docsHome, { label, href: `${base}docs/${first.slug}/` }, { label: title }];
  }
  // Root-level pages (guide, tours, prompts...) have no parent section, so no trail is shown
  return [];
}
