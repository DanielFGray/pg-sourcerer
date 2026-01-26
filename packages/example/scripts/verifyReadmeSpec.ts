/// <reference types="bun" />
/// <reference types="node" />

import { verifyReadmeSpec } from "../../pg-sourcerer/src/testing/readme-spec.js";

const main = () =>
  verifyReadmeSpec().catch(error => {
    if (error instanceof Error && Array.isArray((error as Error & { details?: string[] }).details)) {
      const details = (error as Error & { details?: string[] }).details ?? [];
      if (details.length > 0) {
        console.error("README spec verification failed:\n" + details.join("\n"));
      }
    }
    console.error(error);
    process.exit(1);
  });

if (import.meta.main) {
  main();
}
