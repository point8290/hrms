import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { brandTokens, contrastRatio, inkFor, readableOn } from '../src/lib/branding.ts';

/**
 * White-label theming.
 *
 * The product promises two things that pull against each other: a tenant may choose their
 * own colour, and the product must stay readable. These tests exist because the second
 * promise is the one that breaks silently — a pale brand colour produces a screen that looks
 * fine to whoever picked it and is unusable for everyone else.
 *
 * No DOM here: the derivation is deliberately a pure function so it can be checked without a
 * browser, and `applyBranding` is the only part that touches the document.
 */

const WHITE = { r: 255, g: 255, b: 255 };

describe('brand tokens', () => {
  it('uses the tenant colour as given for solid fills', () => {
    const tokens = brandTokens({ primary_color: '#0b6b4f' });
    assert.equal(tokens['--brand'], '#0b6b4f');
  });

  it('falls back to the product colour when a tenant has chosen none', () => {
    const tokens = brandTokens(null);
    assert.equal(tokens['--brand'], '#1f5eff');
    assert.ok(tokens['--brand-ink']);
  });

  it('ignores a malformed colour rather than emitting broken CSS', () => {
    // A value the database CHECK would reject should never reach here, but a token that is
    // not a colour would break every surface that consumes it — so it fails safe.
    for (const bad of ['red', '#xyzxyz', '#12345', '', 'javascript:alert(1)']) {
      const tokens = brandTokens({ primary_color: bad });
      assert.match(tokens['--brand']!, /^#[0-9a-f]{6}$/, `rejected: ${bad}`);
    }
  });

  it('keeps text readable however bad the tenant colour is', () => {
    // #ffd400 is the case that matters: bright yellow is 1.4:1 on white, so using it as link
    // text would be close to invisible. The ink token must clear AA.
    for (const colour of ['#ffd400', '#ffffff', '#f0f0f0', '#00e5ff', '#0b6b4f']) {
      const tokens = brandTokens({ primary_color: colour });
      const ink = tokens['--brand-ink']!;
      const n = parseInt(ink.slice(1), 16);
      const ratio = contrastRatio({ r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }, WHITE);
      assert.ok(ratio >= 4.5, `${colour} produced ink ${ink} at only ${ratio.toFixed(2)}:1`);
    }
  });

  it('picks a label colour that is readable on top of the brand', () => {
    assert.equal(readableOn({ r: 255, g: 212, b: 0 }), '#111418', 'dark text on yellow');
    assert.equal(readableOn({ r: 11, g: 107, b: 79 }), '#ffffff', 'white text on dark green');
  });

  it('keeps the tenant hue while darkening, rather than substituting a colour', () => {
    // Yellow darkens toward olive, not toward the product blue: it is still their brand.
    const ink = inkFor({ r: 255, g: 212, b: 0 }, WHITE);
    const n = parseInt(ink.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    assert.ok(r > b && g > b, `expected a warm hue, got ${ink}`);
  });

  it('derives the soft wash from the brand so the two cannot drift', () => {
    const tokens = brandTokens({ primary_color: '#0b6b4f' });
    assert.equal(tokens['--brand-soft'], 'rgba(11, 107, 79, 0.10)');
  });

  it('maps density to table rhythm without touching type size', () => {
    const comfortable = brandTokens({ density: 'comfortable' });
    const compact = brandTokens({ density: 'compact' });
    assert.ok(parseInt(compact['--row-y']!, 10) < parseInt(comfortable['--row-y']!, 10));
    // Nothing in the token set changes a font size.
    assert.equal(Object.keys(compact).some((key) => key.includes('font')), false);
  });

  it('maps each radius option to a distinct scale', () => {
    const scales = (['sharp', 'medium', 'round'] as const).map(
      (radius) => brandTokens({ radius })['--radius-lg'],
    );
    assert.equal(new Set(scales).size, 3);
  });

  it('emits only semantic token names, never client-specific ones', () => {
    // The rule that keeps one codebase serving every customer: components consume --brand,
    // never --northwind-green. A token named after a tenant would be a fork in disguise.
    const tokens = brandTokens({ primary_color: '#0b6b4f' });
    for (const name of Object.keys(tokens)) {
      assert.match(name, /^--(brand|accent|radius|row|cell|card)/, `unexpected token ${name}`);
    }
  });
});

describe('contrast arithmetic', () => {
  it('is symmetric and bounded', () => {
    const a = { r: 0, g: 0, b: 0 };
    const b = { r: 255, g: 255, b: 255 };
    assert.equal(contrastRatio(a, b).toFixed(2), contrastRatio(b, a).toFixed(2));
    assert.equal(contrastRatio(a, b).toFixed(0), '21');
    assert.equal(contrastRatio(a, a), 1);
  });
});
