import { describe, expect, it } from 'vitest';

import {
  IMAGE_MODELS,
  MEDIA_PROVIDERS,
  canonicalMediaModelId,
} from '../../src/media/models.js';

describe('image model defaults', () => {
  it('marks the Volcengine Seedream catalog id as the only default image model', () => {
    expect(IMAGE_MODELS.filter((model) => model.default).map((model) => model.id)).toEqual([
      'doubao-seedream-3-0-t2i-250415',
    ]);
    expect(MEDIA_PROVIDERS.some((provider) => provider.id === 'codex')).toBe(false);
    expect(IMAGE_MODELS.some((model) => model.provider === 'codex')).toBe(false);
  });

  it('migrates the removed Codex image model id to Vela', () => {
    expect(canonicalMediaModelId('codex-gpt-image-2')).toBe('vela/gpt-image-2');
  });
});
