/**
 * Tenant branding → design tokens.
 *
 * One React application renders every client. A brand is data: it arrives from the API and is
 * applied by setting CSS custom properties on the document root, which every component already
 * consumes. Nothing downstream knows a tenant's name, and there is no per-client component,
 * stylesheet or build.
 *
 * **Accessibility is enforced here, not trusted to the client.** A tenant can pick any colour,
 * including a pale yellow that would be invisible as link text or a navy that swallows white
 * labels on top of it. So the raw brand colour is never used directly for text. Three tokens
 * are derived from it instead:
 *
 *   --brand          the colour as chosen, used for solid fills where size carries the meaning
 *   --brand-ink      the same hue darkened until it clears 4.5:1 against the page surface,
 *                    used for link text, active nav and anything small
 *   --brand-contrast black or white, whichever is readable *on top of* --brand
 *
 * The result is that a badly chosen brand colour makes the product look worse, which is the
 * tenant's business, but never makes it unreadable, which is ours.
 */

export type Branding = {
  slug: string;
  display_name: string | null;
  logo_url: string | null;
  favicon_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  density: 'comfortable' | 'compact' | null;
  radius: 'sharp' | 'medium' | 'round' | null;
  login_tagline: string | null;
};

/** The product's own colour, used whenever a tenant has expressed no preference. */
const DEFAULT_BRAND = '#1f5eff';

type Rgb = { r: number; g: number; b: number };

function parseHex(hex: string): Rgb | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = parseInt(match[1]!, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex({ r, g, b }: Rgb): string {
  const part = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours. 4.5 is the AA threshold for normal text. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white — whichever is readable on top of this colour. */
export function readableOn(colour: Rgb): string {
  const onWhite = contrastRatio(colour, { r: 255, g: 255, b: 255 });
  const onBlack = contrastRatio(colour, { r: 17, g: 20, b: 24 });
  return onWhite >= onBlack ? '#ffffff' : '#111418';
}

/**
 * Darkens a colour step by step until it is readable as text on the given background.
 *
 * Darkening rather than substituting keeps the tenant's hue, so the product still looks like
 * their brand — it is the same colour, just usable. The loop is bounded; if a colour somehow
 * cannot reach the threshold, the darkest step is still far more readable than the original.
 */
export function inkFor(colour: Rgb, background: Rgb, target = 4.5): string {
  let current = colour;
  for (let step = 0; step < 20 && contrastRatio(current, background) < target; step += 1) {
    current = { r: current.r * 0.88, g: current.g * 0.88, b: current.b * 0.88 };
  }
  return toHex(current);
}

/** The tokens a brand produces. Exported so tests can assert them without a DOM. */
export function brandTokens(branding: Partial<Branding> | null): Record<string, string> {
  const surface: Rgb = { r: 255, g: 255, b: 255 };
  const brand = parseHex(branding?.primary_color ?? '') ?? parseHex(DEFAULT_BRAND)!;
  const accent = parseHex(branding?.secondary_color ?? '') ?? brand;

  const tokens: Record<string, string> = {
    '--brand': toHex(brand),
    '--brand-ink': inkFor(brand, surface),
    '--brand-contrast': readableOn(brand),
    '--accent': toHex(accent),
    '--accent-ink': inkFor(accent, surface),
    // A 10%-opacity wash of the brand, for selected rows and active navigation. Derived
    // rather than configured so it can never drift from the brand colour it tints.
    '--brand-soft': `rgba(${Math.round(brand.r)}, ${Math.round(brand.g)}, ${Math.round(brand.b)}, 0.10)`,
    '--brand-soft-strong': `rgba(${Math.round(brand.r)}, ${Math.round(brand.g)}, ${Math.round(brand.b)}, 0.18)`,
  };

  const radius = branding?.radius ?? 'medium';
  const radiusScale = {
    sharp: { sm: '2px', md: '4px', lg: '6px' },
    medium: { sm: '4px', md: '8px', lg: '12px' },
    round: { sm: '8px', md: '14px', lg: '20px' },
  }[radius];
  tokens['--radius-sm'] = radiusScale.sm;
  tokens['--radius-md'] = radiusScale.md;
  tokens['--radius-lg'] = radiusScale.lg;

  // Density changes the rhythm of dense surfaces (tables, operational lists) only. It does
  // not change type size, so a compact tenant does not get a less readable product.
  const compact = (branding?.density ?? 'comfortable') === 'compact';
  tokens['--row-y'] = compact ? '6px' : '10px';
  tokens['--cell-x'] = compact ? '8px' : '12px';
  tokens['--card-pad'] = compact ? '14px' : '20px';

  return tokens;
}

/** Applies a brand to the live document. Safe to call repeatedly. */
export function applyBranding(branding: Partial<Branding> | null): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(brandTokens(branding))) {
    root.style.setProperty(name, value);
  }

  if (branding?.display_name) document.title = `${branding.display_name} · People`;

  const href = branding?.favicon_url;
  if (href) {
    const link =
      document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
      document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }));
    link.href = href;
  }
}

/**
 * Branding for a sign-in screen, before any session exists.
 *
 * Deliberately tolerant: if the lookup fails, or the slug is unknown, the caller gets null and
 * paints the product's own identity. A branding lookup must never stop somebody logging in.
 */
export async function fetchPublicBranding(slug: string): Promise<Branding | null> {
  if (!slug.trim()) return null;
  try {
    const response = await fetch(`/api/branding?slug=${encodeURIComponent(slug.trim())}`);
    if (!response.ok) return null;
    const body = (await response.json()) as Branding;
    return body.display_name ? body : null;
  } catch {
    return null;
  }
}
