import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-neutral-800 text-neutral-100",
        outline: "border-neutral-700 text-neutral-300",
        success: "border-transparent bg-emerald-600/20 text-emerald-400 ring-1 ring-emerald-500/40",
        info: "border-transparent bg-blue-600/20 text-blue-400 ring-1 ring-blue-500/40",
        warning: "border-transparent bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/40",
        neutral: "border-transparent bg-neutral-600/20 text-neutral-400 ring-1 ring-neutral-500/40",
        danger: "border-transparent bg-red-600/20 text-red-400 ring-1 ring-red-500/40",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
