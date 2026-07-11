export const CORE_VERSION = "0.0.1";

export interface AppInfo {
  name: string;
  version: string;
}

// ponytail: first sliver of the core API — grows into the typed local API
// that is the UI's ONLY door into models, connectors, and data.
export function getAppInfo(): AppInfo {
  return { name: "Deskhand", version: CORE_VERSION };
}

export { createAccountClient } from "./account/client.js";
export type { AccountClient, Session } from "./account/client.js";
export { createNewsClient } from "./news/client.js";
export type { NewsClient, NewsPost } from "./news/client.js";
export { createDmClient } from "./dm/client.js";
export type { DmClient, DmResult, Thread, ThreadMessage, Sender } from "./dm/client.js";
export { createPublishClient } from "./publish/client.js";
export type { PublishClient, PublishResult, VisibilityToPublish } from "./publish/client.js";

export { createRouter } from "./router/router.js";
export type { RouterConfig } from "./router/router.js";
export { openRouterProvider, anthropicProvider } from "./router/providers.js";
export type { ProviderOptions } from "./router/providers.js";
export type {
  Router,
  Provider,
  ProviderId,
  Receipt,
  ReceiptSink,
  GenerateInput,
  GenerateResult,
} from "./router/types.js";

export { createBroker } from "./plugin/broker.js";
export type { Broker, BrokerDeps } from "./plugin/broker.js";
export type { FetchReceipt, FetchSink } from "./plugin/receipt.js";
