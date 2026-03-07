export const encode = (text: string): number[] => {
  const estimatedLength = Math.max(1, Math.ceil((text?.length ?? 0) / 4));
  return Array.from({ length: estimatedLength }, (_, index) => index);
};
