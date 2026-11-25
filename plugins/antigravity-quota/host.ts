import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./lib/contract.ts";
import { readAgyQuota } from "./lib/agy.ts";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    readQuota: (_input, context) => readAgyQuota(AbortSignal.any([context.signal, context.lifecycle.signal])),
  },
});
