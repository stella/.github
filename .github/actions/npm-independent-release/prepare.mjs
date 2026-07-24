import { prepare } from "./runtime.mjs";

try {
  await prepare();
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}
