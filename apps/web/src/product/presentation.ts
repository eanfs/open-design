import { auroraWebPresentation } from './aurora/config';

export interface WebPresentationCapabilities {
  showRuntimeControls: boolean;
  showByokControls: boolean;
  showDesktopEntrypoints: boolean;
}

export interface WebPresentation {
  product: 'opendesign' | 'aurora';
  productName: string;
  capabilities: WebPresentationCapabilities;
}

const opendesignWebPresentation: WebPresentation = {
  product: 'opendesign',
  productName: 'OpenDesign',
  capabilities: {
    showRuntimeControls: true,
    showByokControls: true,
    showDesktopEntrypoints: true,
  },
};

export function resolveWebPresentation(raw: string | undefined): WebPresentation {
  if (raw === undefined || raw === 'opendesign') {
    return opendesignWebPresentation;
  }
  if (raw === 'aurora') {
    return auroraWebPresentation;
  }
  throw new Error(
    `Unsupported NEXT_PUBLIC_OD_PRESENTATION value "${raw}". Expected unset, "opendesign", or "aurora".`,
  );
}

// Resolved once at module load: `NEXT_PUBLIC_OD_PRESENTATION` is inlined by
// the bundler at build time, so an unsupported value fails the build itself.
export const webPresentation: WebPresentation = resolveWebPresentation(
  process.env.NEXT_PUBLIC_OD_PRESENTATION,
);
