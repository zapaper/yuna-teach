// Resolve the user-facing display string. `name` is the immutable
// login username; `displayName` is the mutable label edited from the
// rename modal. NULL `displayName` means "fall back to the username".
export function displayNameOf(u: { name: string; displayName?: string | null }): string {
  const dn = u.displayName?.trim();
  return dn && dn.length > 0 ? dn : u.name;
}
