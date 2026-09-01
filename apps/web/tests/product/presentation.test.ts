import { describe, expect, it } from 'vitest';

import { resolveWebPresentation } from '../../src/product/presentation';

describe('resolveWebPresentation', () => {
  it('defaults to full-capability opendesign when the env is unset', () => {
    expect(resolveWebPresentation(undefined)).toMatchObject({
      product: 'opendesign',
      productName: 'OpenDesign',
      capabilities: {
        showRuntimeControls: true,
        showByokControls: true,
        showDesktopEntrypoints: true,
      },
    });
  });

  it('keeps full capabilities for an explicit opendesign value', () => {
    expect(resolveWebPresentation('opendesign').capabilities).toEqual({
      showRuntimeControls: true,
      showByokControls: true,
      showDesktopEntrypoints: true,
    });
  });

  it('disables all managed capabilities for aurora', () => {
    expect(resolveWebPresentation('aurora').capabilities).toEqual({
      showRuntimeControls: false,
      showByokControls: false,
      showDesktopEntrypoints: false,
    });
  });

  it('rejects unknown presentation values', () => {
    expect(() => resolveWebPresentation('unknown')).toThrow(
      /NEXT_PUBLIC_OD_PRESENTATION/,
    );
  });
});
