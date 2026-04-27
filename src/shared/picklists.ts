// Shared between web and bot so /scan UIs offer the same picklists.
export const EDITIONS = [
  "hardcover",
  "paperback",
  "mass-market",
  "special",
  "signed",
  "boxset",
  "other",
] as const;
export type Edition = (typeof EDITIONS)[number];

export const CONDITIONS = ["new", "like-new", "good", "fair", "poor"] as const;
export type Condition = (typeof CONDITIONS)[number];

export function labelEdition(value: string | null | undefined): string {
  if (!value) return "—";
  if (value === "mass-market") return "Mass-market PB";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function labelCondition(value: string | null | undefined): string {
  if (!value) return "—";
  if (value === "like-new") return "Like new";
  return value.charAt(0).toUpperCase() + value.slice(1);
}
