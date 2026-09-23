import { createMathPlugin } from '@streamdown/math';

export const math = createMathPlugin({ singleDollarTextMath: true });

export function escapeCurrency(markdown: string): string {
  return markdown.replace(/\$([^$\n]+)\$/g, (match, expression: string) =>
    /^\d[\d,.]*\s/.test(expression) && !/[+*/=^_\\]/.test(expression)
      ? `\\$${expression}\\$`
      : match,
  );
}
