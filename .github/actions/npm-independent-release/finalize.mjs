import { finalize } from "./runtime.mjs";

try {
  await finalize();
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}
