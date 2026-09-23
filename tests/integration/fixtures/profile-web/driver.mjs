import { profileWeb } from "./scripts/profile-dev.mjs";

// IPC stays open until the parent has observed cleanup and any late completion.
process.on("message", (message) => {
  if (message === "finish") setImmediate(() => process.disconnect());
});
const log = console.log;
console.log = (...args) => {
  log(...args);
  if (args[0]?.startsWith("\nProfiling http"))
    process.send({ type: "capturing" });
};
try {
  await profileWeb({
    directory: `${process.cwd()}/profiles`,
    profileArgs: [],
    args: [],
    network: true,
  });
  process.send({ type: "settled" });
} catch (error) {
  process.exitCode = 1;
  process.send({
    type: "settled",
    error: error.message,
    cause: error.cause?.message,
  });
}
