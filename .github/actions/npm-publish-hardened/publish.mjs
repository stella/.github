import { publishReleaseEntries } from "./runtime.mjs";

try {
  await publishReleaseEntries();
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}
