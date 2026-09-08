import { describe, expect, it } from 'vitest';
import { volcengineImageSizeFor } from '../../src/media/volcengine-image-size.js';

describe('Ark image dimensions', () => {
  it.each(['1:1', '16:9', '9:16', '4:3', '3:4'])('meets Seedream minimum and preserves %s', (aspect) => {
    const [width, height] = volcengineImageSizeFor('doubao-seedream-5.0-lite', aspect).split('x').map(Number);
    const [a, b] = aspect.split(':').map(Number);
    expect(width! * height!).toBeGreaterThanOrEqual(3_686_400);
    expect(width! / height!).toBeCloseTo(a! / b!, 8);
  });

  it('uses modern dimensions for versioned and endpoint wire models', () => {
    expect(volcengineImageSizeFor('doubao-seedream-5-0-260128')).toBe('2048x2048');
    expect(volcengineImageSizeFor('ep-custom-image')).toBe('2048x2048');
  });

  it('preserves legacy model dimensions', () => {
    expect(volcengineImageSizeFor('doubao-seedream-3-0-t2i-250415')).toBe('1024x1024');
    expect(volcengineImageSizeFor('doubao-seededit-3-0-i2i-250628')).toBe('1024x1024');
  });

  it('maps official resolution tiers to aspect-preserving pixel sizes', () => {
    // Bare tier strings would render square (2K -> 2048x2048) and drop the
    // requested ratio; Ark accepts explicit pixels up to a 4096 long edge.
    expect(volcengineImageSizeFor('doubao-seedream-5.0-lite', '16:9', '2K')).toBe('2560x1440');
    expect(volcengineImageSizeFor('doubao-seedream-5.0-lite', '9:16', '3K')).toBe('1728x3072');
    expect(volcengineImageSizeFor('doubao-seedream-5.0-lite', '16:9', '4K')).toBe('4096x2304');
    expect(volcengineImageSizeFor('doubao-seedream-5.0-lite', '4:3', '4K')).toBe('4096x3072');
    expect(volcengineImageSizeFor('ep-custom-image', undefined, '4K')).toBe('4096x4096');
    expect(volcengineImageSizeFor('doubao-seedream-5.0-lite', undefined, '3K')).toBe('3072x3072');
  });

  it.each(['2K', '3K', '4K'] as const)('keeps every ratio at or above the pixel minimum for %s', (tier) => {
    for (const aspect of ['1:1', '16:9', '9:16', '4:3', '3:4'] as const) {
      const [width, height] = volcengineImageSizeFor('doubao-seedream-5.0-lite', aspect, tier).split('x').map(Number);
      expect(width! * height!, `${tier} ${aspect}`).toBeGreaterThanOrEqual(3_686_400);
      if (aspect !== '1:1') {
        const [a, b] = aspect.split(':').map(Number);
        expect(width! / height!, `${tier} ${aspect}`).toBeCloseTo(a! / b!, 8);
      }
    }
  });

  it('keeps legacy 3.0 models at their fixed size even when a tier is requested', () => {
    expect(volcengineImageSizeFor('doubao-seedream-3-0-t2i-250415', '16:9', '4K')).toBe('1024x1024');
    expect(volcengineImageSizeFor('doubao-seededit-3-0-i2i-250628', undefined, '2K')).toBe('1024x1024');
  });

  it('ignores non-tier resolution values and keeps the aspect matrix', () => {
    expect(volcengineImageSizeFor('doubao-seedream-5.0-lite', '16:9', '720p')).toBe('2560x1440');
    expect(volcengineImageSizeFor('doubao-seedream-5.0-lite', '16:9', undefined)).toBe('2560x1440');
  });
});
