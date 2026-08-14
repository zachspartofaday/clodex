const CREDENTIAL_BEARING_HEADER =
  /(?:^|[-_])(?:authorization|api[-_]?key|cookie|token|secret|credential)(?:$|[-_])/i;
const CREDENTIAL_BEARING_HEADER_ALIASES: ReadonlySet<string> = new Set(['x-auth','authentication','x-auth-key','xapikey']);

export function isCredentialBearingHeader(name: string): boolean {
  const normalizedName = name.trim();
  return CREDENTIAL_BEARING_HEADER.test(normalizedName)
    || CREDENTIAL_BEARING_HEADER_ALIASES.has(normalizedName.toLowerCase());
}
