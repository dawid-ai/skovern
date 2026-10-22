// The Local Brain spine, re-exported for the app (which never reaches into
// subpaths). Backends live behind `LocalEngine`; the honesty engine is `verdict`.

export { ollamaEngine, ollamaResidentModels, ollamaUnload } from "./ollama.js";
export type { OllamaOptions } from "./ollama.js";
export { localProvider } from "./provider.js";
export { verdict, UNIFIED_USABLE } from "./verdict.js";
export type {
  LocalEngine,
  LocalGenerateResult,
  LocalModelInfo,
  PullProgress,
  GpuInfo,
  HardwareProfile,
  CatalogModel,
  GgufSource,
  FitTier,
  ModelFit,
  Verdict,
  VerdictModel,
} from "./types.js";
