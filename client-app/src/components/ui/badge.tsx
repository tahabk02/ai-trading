"use client";

import * as React from "react";
import { cn } from "@/utils/cn";

export type BadgeTone = "success" | "danger" | "warning" | "info" | "neutral";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const toneClass: Record<BadgeTone, string> = {
  success: "tp-badge-success",
  danger: "tp-badge-danger",
  warning: "tp-badge-warning",
  info: "tp-badge-info",
  neutral: "tp-badge-neutral",
};

export const Badge: React.FC<BadgeProps> = ({
  className,
  tone = "neutral",
  ...props
}) => <span className={cn("tp-badge", toneClass[tone], className)} {...props} />;

export default Badge;
