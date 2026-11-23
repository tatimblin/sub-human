// Hex SHA-256 through `crypto.subtle`, which the module and node both have, so a hash is the same on either side.

export async function sha256(text: string): Promise<string> {
  const data = new Uint8Array(new TextEncoder().encode(text)); // a plain ArrayBuffer, as digest's types ask
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
