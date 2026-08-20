/** Append text while retaining only the newest characters within the limit. */
export const appendBoundedText = (current: string, chunk: string, maxChars: number): string => {
  const next = current + chunk;
  return next.length <= maxChars ? next : next.slice(-maxChars);
};
