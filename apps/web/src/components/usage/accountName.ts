/**
 * Trimming provider-repeating instance names for the limits bars.
 *
 * @module accountName
 */

/**
 * Instance names usually repeat the provider ("Claude Proton"), and every bar
 * sits under a heading that already names it, so the prefix is dropped rather
 * than printed on each row. A name that is only the provider keeps it, since
 * the alternative is a blank label.
 */
export function shortAccountName(displayName: string, driverLabel: string | undefined): string {
  if (!driverLabel) return displayName;
  const head = driverLabel.split(" ")[0];
  if (!head) return displayName;
  const prefix = `${head.toLowerCase()} `;
  if (!displayName.toLowerCase().startsWith(prefix)) return displayName;
  const stripped = displayName.slice(head.length).trimStart();
  return stripped.length > 0 ? stripped : displayName;
}
