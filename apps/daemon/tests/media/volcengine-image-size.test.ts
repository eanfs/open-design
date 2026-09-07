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
});
