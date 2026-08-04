import type { BiasDimension, BiasItem } from "@/types/signal";

export const BIAS_DIMENSIONS: BiasDimension[] = [
  "技術面",
  "基本面",
  "籌碼面",
  "新聞面",
  "資金流",
  "AI綜合",
];

/** Net weighted score per dimension, signed relative to the signal's own direction. */
export function computeDimensionScores(
  direction: "long" | "short",
  biasItems: BiasItem[],
): Record<BiasDimension, number> {
  const opposite = direction === "long" ? "short" : "long";
  const result = Object.fromEntries(BIAS_DIMENSIONS.map((d) => [d, 0])) as Record<
    BiasDimension,
    number
  >;
  for (const item of biasItems) {
    const sign = item.direction === direction ? 1 : item.direction === opposite ? -1 : 0;
    result[item.dimension] += sign * item.weight;
  }
  return result;
}
