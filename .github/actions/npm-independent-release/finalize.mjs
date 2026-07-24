import { finalize } from "./runtime.mjs";

try {
  finalize();
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}
