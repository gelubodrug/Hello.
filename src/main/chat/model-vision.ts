/** Published capabilities only; model names are not evidence of image support. */
export function modelVision(model: Record<string, unknown> | null | undefined): boolean | undefined {
  if (!model) return undefined;
  const architecture = model.architecture as { input_modalities?: unknown } | undefined;
  const modalities = architecture?.input_modalities;
  if (Array.isArray(modalities) && modalities.length && modalities.every(item => typeof item === 'string'))
    return modalities.includes('image');
  // LM Studio's native model listings, when the configured endpoint exposes them.
  const capabilities = model.capabilities;
  if (capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities) &&
      typeof (capabilities as { vision?: unknown }).vision === 'boolean')
    return (capabilities as { vision: boolean }).vision;
  if (Array.isArray(capabilities) && capabilities.every(item => typeof item === 'string'))
    return capabilities.includes('vision');
  if (model.type === 'vlm') return true;
  if (model.type === 'llm') return false;
  return undefined;
}
