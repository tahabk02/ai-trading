"use client";

import * as React from "react";
import { cn } from "@/utils/cn";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "success"
  | "danger"
  | "warning";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClass: Record<ButtonVariant, string> = {
  primary: "tp-btn-primary",
  secondary: "tp-btn-secondary",
  ghost: "tp-btn-ghost",
  success: "tp-btn-success",
  danger: "tp-btn-danger",
  warning: "tp-btn-warning",
};

const sizeClass: Record<ButtonSize, string> = {
  sm: "min-h-[36px] px-3 text-[11px]",
  md: "",
  lg: "min-h-[48px] px-6 text-sm",
  icon: "h-10 w-10 min-h-0 p-0",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn("tp-btn", variantClass[variant], sizeClass[size], className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export default Button;
