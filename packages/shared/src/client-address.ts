/**
 * The key under which a client address is limited. An IPv4 address is its own key.
 * An IPv6 address is reduced to its /64 prefix: one subscriber controls all 2^64
 * addresses of it, so counting them one by one would be no limit at all. An
 * IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) is unwrapped.
 */
export function addressKey(address: string): string {
  const bare = address.trim().replace(/^::ffff:/i, "");
  if (!bare.includes(":") || bare.includes(".")) return bare;
  const [head = "", tail = ""] = bare.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const fill = bare.includes("::")
    ? Array.from({ length: Math.max(0, 8 - front.length - back.length) }, () => "0")
    : [];
  return [...front, ...fill, ...back]
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":");
}
