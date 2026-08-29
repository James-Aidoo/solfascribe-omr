/**
 * The CORS allow-list parser: one env string, one or many origins. The incident pin
 * (2026-08-29): with only production allowed, a staging scan uploaded, ran, and had its
 * response discarded by the browser - the fix is that a comma-separated CORS_ORIGIN
 * yields every origin, exactly as written.
 */
import { describe, expect, it } from 'vitest';
import { corsOriginsOf } from '../src/server.js';

describe('corsOriginsOf', () => {
  it('unset stays the wide-open local-dev default', () => {
    expect(corsOriginsOf(undefined)).toBe('*');
    expect(corsOriginsOf('')).toBe('*');
  });

  it('a single origin passes through as the exact string', () => {
    expect(corsOriginsOf('https://solfascribe.app')).toBe('https://solfascribe.app');
  });

  it('a comma-separated list yields every origin, whitespace trimmed', () => {
    expect(
      corsOriginsOf(
        'https://solfascribe.app, https://next-solfascribe.jamesaidooessah.workers.dev',
      ),
    ).toEqual([
      'https://solfascribe.app',
      'https://next-solfascribe.jamesaidooessah.workers.dev',
    ]);
  });

  it('stray commas contribute nothing', () => {
    expect(corsOriginsOf('https://solfascribe.app,')).toBe('https://solfascribe.app');
  });
});
