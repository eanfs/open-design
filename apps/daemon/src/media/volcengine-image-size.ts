/**
 * Resolve image size from the actual Ark model, after catalog aliasing.
 *
 * Resolution tiers map to explicit aspect-preserving pixel sizes rather than
 * the literal `2K`/`3K`/`4K` tier strings: this endpoint treats a bare tier as
 * square output (2K -> 2048x2048) regardless of the requested aspect ratio.
 * Every cell below was empirically accepted by `doubao-seedream-5.0-lite`
 * (HTTP 200, >= the model's 3,686,400-pixel minimum).
 */
const SEEDREAM_TIER_SIZES: Record<string, Record<string, string>> = {
  // Matches the legacy default matrix: long edge 2048-2560 depending on ratio.
  '2K': {
    '16:9': '2560x1440',
    '9:16': '1440x2560',
    '4:3': '2304x1728',
    '3:4': '1728x2304',
  },
  '3K': {
    '16:9': '3072x1728',
    '9:16': '1728x3072',
    '4:3': '3072x2304',
    '3:4': '2304x3072',
  },
  '4K': {
    '16:9': '4096x2304',
    '9:16': '2304x4096',
    '4:3': '4096x3072',
    '3:4': '3072x4096',
  },
};

export function volcengineImageSizeFor(wireModel: string, aspect?: string, resolution?: string): string {
  // Preserve legacy models; an old catalog id can alias to modern Seedream.
  if (/^doubao-(?:seedream-3[.-]0|seededit-3[.-]0)(?:-|$)/.test(wireModel)) {
    return '1024x1024';
  }
  if (resolution === '2K' || resolution === '3K' || resolution === '4K') {
    const byAspect = SEEDREAM_TIER_SIZES[resolution]!;
    const square = `${Number(resolution.slice(0, -1)) * 1024}x${Number(resolution.slice(0, -1)) * 1024}`;
    return byAspect[aspect ?? ''] ?? square;
  }
  // Seedream 5.0 Lite requires at least 3,686,400 pixels. These sizes
  // preserve the supported aspect ratios and meet that minimum.
  switch (aspect) {
    case '16:9': return '2560x1440';
    case '9:16': return '1440x2560';
    case '4:3': return '2304x1728';
    case '3:4': return '1728x2304';
    default: return '2048x2048';
  }
}
