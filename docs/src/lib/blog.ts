/** Helpers shared by the blog index and post pages. */

export type Category = 'Release' | 'Community' | 'Roadmap' | 'Engineering';
export const CATEGORIES: Category[] = ['Release', 'Community', 'Roadmap', 'Engineering'];

export function categoryOf(tags: string[] = []): Category {
  const t = new Set(tags.map((x) => x.toLowerCase()));
  if (['release', 'launch', 'insider', 'preview'].some((k) => t.has(k))) return 'Release';
  if (['community', 'contribution', 'milestone', 'trending'].some((k) => t.has(k))) return 'Community';
  if (tags.some((x) => /^wave-/.test(x)) || ['replatform', 'roadmap'].some((k) => t.has(k))) return 'Roadmap';
  return 'Engineering';
}

export function titleFromId(id: string): string {
  return id
    .replace(/^\d+[a-z]?-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function postNumber(id: string): string {
  const m = id.match(/^(\d+[a-z]?)-/);
  return m ? `#${m[1].toUpperCase()}` : 'NEW';
}

export function toDate(value?: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(d: Date | null): string {
  return d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
}

export function cleanAuthor(author?: string): string {
  return (author ?? 'Squad Team').replace(/\s*\(.*?\)\s*/g, '').trim() || 'Squad Team';
}
