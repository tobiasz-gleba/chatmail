import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function createDatabase(binding: Env["DB"]) {
  return drizzle(binding, { schema });
}
