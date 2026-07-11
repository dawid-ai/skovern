// Shapes crossing the renderer ↔ main IPC boundary for the "What leaves your
// machine" panel. Read-only metadata — host (never a full URL), a plain-English
// label, and byte counts. Never a key, header, or body.

import type { FetchReceipt, Receipt } from "@deskhand/core";

export type { FetchReceipt, Receipt };

// One line the panel shows: a model (brain) call has no `kind`; a fetch call —
// plugin OR first-party Deskhand cloud — is tagged kind:"fetch". The renderer
// tells them apart with `"kind" in r`.
export type ReceiptView = Receipt | FetchReceipt;
