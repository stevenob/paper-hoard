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

// Antiquarian / dealer-grade condition scale. Replaces the casual
// new/like-new/good/fair/poor of v0-v3.4. Used on the copy edit form
// and when scanning. The migration 20260430_collector_polish maps the
// old values onto these.
export const CONDITIONS = [
  "Fine",
  "Near Fine",
  "Very Good+",
  "Very Good",
  "Good+",
  "Good",
  "Fair",
  "Poor",
  "Reading Copy",
] as const;
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
