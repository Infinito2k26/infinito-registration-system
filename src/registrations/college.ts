/**
 * College grouping key. Must stay identical to the SQL used by the
 * 20261003090000_college_inout_email_ops migration backfill:
 *   lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))
 */
export function collegeNameKey(name: string): string {
  return collegeDisplayName(name).toLowerCase();
}

export function collegeDisplayName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}
