import { resolve4, resolve6 } from "node:dns/promises";
import ipaddr from "ipaddr.js";

export async function assertPublicMailHost(host: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answers = await Promise.race([
    Promise.allSettled([resolve4(host), resolve6(host)]),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Mail server DNS timed out.")), 6_000);
    }),
  ]).finally(() => clearTimeout(timer));
  const addresses = answers.flatMap(answer => answer.status === "fulfilled" ? answer.value : []);
  if (!addresses.length || addresses.some(address => ipaddr.process(address).range() !== "unicast")) {
    throw new Error("A public mail server is required.");
  }
}
