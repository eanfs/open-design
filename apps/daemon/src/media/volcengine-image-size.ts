/** Resolve image size from the actual Ark model, after catalog aliasing. */
export function volcengineImageSizeFor(wireModel: string, aspect?: string): string {
  // Preserve legacy models; an old catalog id can alias to modern Seedream.
  if (/^doubao-(?:seedream-3[.-]0|seededit-3[.-]0)(?:-|$)/.test(wireModel)) {
    return '1024x1024';
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
