import { parentPort } from "node:worker_threads";
import { verifySignatureClaim } from "./verify-signatures.mjs";

parentPort?.on("message", ({ id, claims }) => {
  const results = new Array(claims.length);
  for (let i = 0; i < claims.length; i++)
    results[i] = verifySignatureClaim(claims[i]);
  parentPort.postMessage({ id, results });
});
