import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

interface BrandHeaderProps {
  className?: string;
  /** "sm" = ikon 28px (default), "md" = 36px, "lg" = 48px (för Home/landningssidor). */
  size?: "sm" | "md" | "lg";
  /** Sätt till false för att bara visa loggan utan textetikett. */
  showText?: boolean;
}

const SIZES = {
  sm: { icon: 28, textCls: "text-sm" },
  md: { icon: 36, textCls: "text-base" },
  lg: { icon: 56, textCls: "text-2xl" },
} as const;

/**
 * Klickbar Oddexus-logga + namn. Routerar till "/" (startmenyn).
 * Används på samtliga sidor som "hem"-länk i headern. På Home blir klicket
 * en no-op (vi är redan på rooten).
 */
export function BrandHeader({ className, size = "sm", showText = true }: BrandHeaderProps) {
  const { icon, textCls } = SIZES[size];
  return (
    <Link
      to="/"
      aria-label="Oddexus — till startmenyn"
      className={cn(
        "inline-flex items-center gap-2 rounded-md transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background",
        className,
      )}
    >
      <img
        src="/favicon.png?v=3"
        alt=""
        width={icon}
        height={icon}
        className="rounded-md"
        draggable={false}
      />
      {showText && (
        <span className={cn("font-bold tracking-tight", textCls)}>Oddexus</span>
      )}
    </Link>
  );
}
