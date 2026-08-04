import type { Grade } from "@/types/signal";
import { Badge } from "@/components/ui/badge";

const GRADE_VARIANT: Record<Grade, "success" | "info" | "warning" | "neutral" | "danger"> = {
  "A+": "success",
  A: "info",
  B: "warning",
  C: "neutral",
  "no-trade": "danger",
};

export function GradeBadge({ grade }: { grade: Grade }) {
  return (
    <Badge variant={GRADE_VARIANT[grade]} className="px-3 py-1 text-sm">
      {grade}
    </Badge>
  );
}
