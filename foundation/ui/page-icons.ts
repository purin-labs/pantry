import {
  Activity,
  BookOpen,
  Bot,
  Brain,
  CakeSlice,
  Calculator,
  ConciergeBell,
  Cpu,
  CreditCard,
  Factory,
  FlaskConical,
  KeyRound,
  KeySquare,
  Landmark,
  LayoutDashboard,
  Mail,
  Package,
  Plug,
  Settings,
  ShoppingCart,
  Sparkles,
  Truck,
  Vault,
  Warehouse,
  type LucideIcon,
} from "lucide-react";

import type { WorkspaceDetailPage } from "./route";
import { assertNever } from "@purin-labs/std";

/**
 * The icon of each page of `route.ts`, wherever the Portal names a page: the
 * sidebar and the page search.
 */
export function workspaceNavigationIcon(page: WorkspaceDetailPage): LucideIcon {
  switch (page) {
    case "overview":
      return LayoutDashboard;
    case "inbox":
      return Mail;
    case "checkout":
    case "terminals":
      return CreditCard;
    case "products":
      return Package;
    case "menus":
    case "recipes":
      return BookOpen;
    case "costs":
      return Calculator;
    case "order-queue":
      return ConciergeBell;
    case "register":
      return CreditCard;
    case "inventory":
      return Warehouse;
    case "orders":
      return ShoppingCart;
    case "payments":
      return CreditCard;
    case "payouts":
      return Landmark;
    case "suppliers":
      return Truck;
    case "workflow-simulator":
    case "production-requests":
      return Factory;
    case "devices":
      return Cpu;
    case "bakes":
      return CakeSlice;
    case "chat":
    case "agents":
      return Bot;
    case "brain":
    case "knowledge":
      return Brain;
    case "activity":
      return Activity;
    case "tests":
      return FlaskConical;
    case "integrations":
      return Plug;
    case "vault":
      return Vault;
    case "api-keys":
      return KeySquare;
    case "jev":
      return Sparkles;
    case "billing":
      return CreditCard;
    case "access":
      return KeyRound;
    case "settings":
      return Settings;
    default:
      return assertNever(page, "Unexpected value");
  }
}
