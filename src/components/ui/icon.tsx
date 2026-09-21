/**
 * Single icon system for the whole app — lucide-react (already a dependency).
 * Everything imports from here so there is exactly one icon library and one
 * sizing convention. Icons inherit `currentColor`, so they work in light and
 * dark themes and are RTL-neutral.
 */
import {
  BarChart3,
  Boxes,
  Check,
  Eye,
  EyeOff,
  Lock,
  LogOut,
  Minus,
  Package,
  Plus,
  Printer,
  Receipt,
  RotateCcw,
  ScrollText,
  Search,
  Settings,
  Store,
  Trash2,
  User,
  UserPlus,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react'

export {
  BarChart3,
  Boxes,
  Check,
  Eye,
  EyeOff,
  Lock,
  LogOut,
  Minus,
  Package,
  Plus,
  Printer,
  Receipt,
  RotateCcw,
  ScrollText,
  Search,
  Settings,
  Store,
  Trash2,
  User,
  UserPlus,
  Users,
  Wallet,
  X,
}

export type { LucideIcon }

/** Standard icon sizes — use these instead of ad-hoc pixel values. */
export const iconSize = { sm: 14, md: 16, lg: 20 } as const
