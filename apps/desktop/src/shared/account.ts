// Shapes crossing the renderer ↔ main IPC boundary for accounts. Kept tiny and
// UI-facing: warm messages, never raw errors or tokens.
export interface RequestResult {
  ok: boolean;
  message: string;
}

export interface VerifyResult {
  ok: boolean;
  ogNumber?: number;
  message: string;
}

export interface CurrentAccount {
  ogNumber: number;
}
