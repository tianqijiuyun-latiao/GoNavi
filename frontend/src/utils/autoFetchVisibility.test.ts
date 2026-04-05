import { describe, expect, it } from 'vitest';

import { isAutoFetchVisible } from './autoFetchVisibility';

describe('isAutoFetchVisible', () => {
  it('allows auto fetch only when the document is visible and not hidden', () => {
    expect(isAutoFetchVisible({ hidden: false, visibilityState: 'visible' })).toBe(true);
  });

  it('blocks auto fetch when the page is hidden even if visibilityState looks visible', () => {
    expect(isAutoFetchVisible({ hidden: true, visibilityState: 'visible' })).toBe(false);
  });

  it('blocks auto fetch when visibilityState is not visible', () => {
    expect(isAutoFetchVisible({ hidden: false, visibilityState: 'hidden' })).toBe(false);
  });

  it('defaults to allowing auto fetch when document visibility APIs are unavailable', () => {
    expect(isAutoFetchVisible(undefined)).toBe(true);
    expect(isAutoFetchVisible({})).toBe(true);
  });
});
