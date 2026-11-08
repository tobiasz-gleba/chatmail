import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const file = new URL("../.dev.vars", import.meta.url);
const settings = [
  `AUTH_SECRET=${randomBytes(32).toString("base64")}`,
  `MAIL_KEY=${randomBytes(32).toString("base64")}`,
  "OTP_FROM=login@chatmail.test",
];
try {
  await writeFile(file, settings.join("\n") + "\n", { flag: "wx", mode: 0o600 });
  console.log("Created local Worker secrets in backend/.dev.vars");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("Using existing backend/.dev.vars");
}
