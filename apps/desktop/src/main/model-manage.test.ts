import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Point modelsDir() at a temp folder (mirrors download.test.ts) so list/delete run against real
// files without an Electron userData dir.
const state = { dir: "" };
vi.mock("electron", () => ({ app: { getPath: () => state.dir } }));

import { listDownloadedModels, deleteDownloadedModel, modelsDir } from "./download.js";
import { modelDeletionPlan } from "./model-manage.js";

const EMBEDDED = [
  { id: "qwen2.5:3b", filename: "qwen2.5-3b-instruct-q4_k_m.gguf" },
  { id: "qwen2.5:0.5b", filename: "qwen2.5-0.5b-instruct-q4_k_m.gguf" },
];

describe("model deletion plan — never leave a dangling active brain (loop 041, U3)", () => {
  it("deleting the ACTIVE model that's WARM → unload its VRAM AND clear the brain pointer", () => {
    expect(modelDeletionPlan("qwen2.5-3b-instruct-q4_k_m.gguf", { id: "qwen2.5:3b", filename: null }, true, EMBEDDED)).toEqual({
      isActive: true,
      unload: true,
      clearBrain: true,
    });
  });

  it("deleting the ACTIVE model that's COLD → clear the brain, but no unload (nothing resident)", () => {
    expect(modelDeletionPlan("qwen2.5-3b-instruct-q4_k_m.gguf", { id: "qwen2.5:3b", filename: null }, false, EMBEDDED)).toEqual({
      isActive: true,
      unload: false,
      clearBrain: true,
    });
  });

  it("deleting a NON-active model → touch neither the brain nor the engine, even if warm", () => {
    expect(modelDeletionPlan("qwen2.5-0.5b-instruct-q4_k_m.gguf", { id: "qwen2.5:3b", filename: null }, true, EMBEDDED)).toEqual({
      isActive: false,
      unload: false,
      clearBrain: false,
    });
  });

  it("no brain configured → nothing is active, nothing cleared", () => {
    expect(modelDeletionPlan("qwen2.5-3b-instruct-q4_k_m.gguf", { id: null, filename: null }, true, EMBEDDED)).toEqual({
      isActive: false,
      unload: false,
      clearBrain: false,
    });
  });

  it("045: the active model's catalog entry VANISHED but its stored filename matches → still clear the brain", () => {
    const active = { id: "qwen2.5:7b", filename: "qwen2.5-7b-instruct-q4_k_m.gguf" }; // not in EMBEDDED any more
    expect(modelDeletionPlan("qwen2.5-7b-instruct-q4_k_m.gguf", active, true, EMBEDDED)).toEqual({
      isActive: true,
      unload: true,
      clearBrain: true,
    });
    // and a stored filename never makes a DIFFERENT file read as active
    expect(modelDeletionPlan("qwen2.5-0.5b-instruct-q4_k_m.gguf", active, true, EMBEDDED).isActive).toBe(false);
  });

  it("045: the catalog kept the id but changed the file → the file the runtime would load still reads active", () => {
    const active = { id: "qwen2.5:3b", filename: "qwen2.5-3b-OLD-q4_k_m.gguf" }; // stored before the catalog changed
    expect(modelDeletionPlan("qwen2.5-3b-instruct-q4_k_m.gguf", active, true, EMBEDDED)).toEqual({ isActive: true, unload: true, clearBrain: true });
  });
});

describe("model management — list + delete (loop 041)", () => {
  beforeEach(() => {
    state.dir = mkdtempSync(path.join(tmpdir(), "skovern-mm-"));
    mkdirSync(modelsDir(), { recursive: true });
  });
  afterEach(() => rmSync(state.dir, { recursive: true, force: true }));

  const seed = (name: string, bytes: number): void => writeFileSync(path.join(modelsDir(), name), Buffer.alloc(bytes, 1));

  it("U1: lists finished .gguf files with sizes, ignoring .part temps and non-gguf files", async () => {
    seed("qwen2.5-3b-instruct-q4_k_m.gguf", 2048);
    seed("qwen2.5-0.5b-instruct-q4_k_m.gguf", 512);
    seed("qwen2.5-14b-instruct-q4_k_m.gguf.part", 999); // a resumable temp → ignored
    seed("notes.txt", 10); // non-gguf → ignored
    const list = await listDownloadedModels();
    expect(list.map((m) => m.filename).sort()).toEqual(["qwen2.5-0.5b-instruct-q4_k_m.gguf", "qwen2.5-3b-instruct-q4_k_m.gguf"]);
    expect(list.find((m) => m.filename.includes("3b"))!.sizeBytes).toBe(2048);
  });

  it("U2 (security): delete unlinks a valid file but REJECTS a traversal/bad name BEFORE any unlink", async () => {
    seed("qwen2.5-3b-instruct-q4_k_m.gguf", 100);
    const outside = path.join(state.dir, "secret.gguf"); // a file OUTSIDE the models dir
    writeFileSync(outside, "keep me");

    // traversal / separators / non-gguf / absolute path → THROW before any unlink (modelPath guard)
    await expect(deleteDownloadedModel("../secret.gguf")).rejects.toThrow(/isn't allowed/i);
    await expect(deleteDownloadedModel("sub/x.gguf")).rejects.toThrow(/isn't allowed/i);
    await expect(deleteDownloadedModel("evil.txt")).rejects.toThrow(/isn't allowed/i);
    await expect(deleteDownloadedModel(path.join(modelsDir(), "qwen2.5-3b-instruct-q4_k_m.gguf"))).rejects.toThrow(/isn't allowed/i);
    // nothing outside the models dir was touched, and the valid model is still there
    expect(existsSync(outside)).toBe(true);
    expect((await listDownloadedModels()).length).toBe(1);

    // a valid catalog filename deletes exactly that file, nothing else
    expect(await deleteDownloadedModel("qwen2.5-3b-instruct-q4_k_m.gguf")).toBe(true);
    expect((await listDownloadedModels()).length).toBe(0);
    expect(existsSync(outside)).toBe(true);
    // deleting an already-gone file is a no-op, not a throw
    expect(await deleteDownloadedModel("qwen2.5-3b-instruct-q4_k_m.gguf")).toBe(false);
  });
});
