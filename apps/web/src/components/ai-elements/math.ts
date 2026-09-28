import { createMathPlugin } from '@streamdown/math';

type Node = { type: string; value?: string; data?: unknown; children?: Node[] };
type Attacher = (this: unknown, ...options: unknown[]) => unknown;

/**
 * `$…$` is inline math, but `$` is also currency: "$10K ACV … at $200/month"
 * would typeset everything between the two amounts. A span that opens on a digit
 * is money, not a formula, so it goes back to plain text. Positions are kept, so
 * highlights still line up with the source.
 */
function currencyAsText(tree: Node) {
  for (const child of tree.children ?? []) {
    if (child.type === 'inlineMath' && /^\d/.test(child.value ?? '')) {
      child.type = 'text';
      child.value = `$${child.value}$`;
      // remark-math's rendering hints (a math `code` element) would still apply.
      delete child.data;
    } else currencyAsText(child);
  }
}

const base = createMathPlugin({ singleDollarTextMath: true });
const [remarkMath, mathOptions] = (
  Array.isArray(base.remarkPlugin) ? base.remarkPlugin : [base.remarkPlugin]
) as [Attacher, unknown?];

/** Math for replies: remark-math, then currency spans restored as text. */
export const math = {
  ...base,
  remarkPlugin: function remarkMathWithCurrency(this: unknown) {
    remarkMath.call(this, mathOptions);
    return currencyAsText;
  },
} as typeof base;
