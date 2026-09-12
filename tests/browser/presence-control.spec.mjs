import { test } from "./fixture.mjs";
import { contentionTests } from "./presence-contention.mjs";
test.use({
  productionBroker: true,
  composerPublication: true,
  enforceQuotas: true,
  withoutPresence: true,
});
contentionTests(true);
