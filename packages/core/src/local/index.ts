// The Local Brain spine, re-exported for the app (which never reaches into
// subpaths). Backends live behind `LocalEngine`; the honesty engine is `verdict`.

export { ollamaEngine } from "./ollama.js";
export type { OllamaOptions } from "./ollama.js";
export { localProvider } from "./provider.js";
export { verdict } from "./verdict.js";
export type {
  LocalEngine,
  LocalModelInfo,
  PullProgress,
  GpuInfo,
  HardwareProfile,
  CatalogModel,
  FitTier,
  ModelFit,
  Verdict,
  VerdictModel,
} from "./types.js";
