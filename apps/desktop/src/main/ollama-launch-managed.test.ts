import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Loop 047, M9: once Skovern has set its helper up, that exact file is what runs — a planted
// `ollama.exe` earlier on PATH never takes its place — and it listens on loopback only.
const state = { dir: "" };
vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => state.dir } }));

import { ollamaInstalled, resolveOllamaBin, serveEnv } from "./ollama-launch.js";

const EXE = process.platform === "win32" ? "ollama.exe" : "ollama";
const savedEnv = { ...process.env };

beforeEach(() => {
  state.dir = mkdtempSync(path.join(tmpdir(), "skovern-launch-"));
  process.env["SKOVERN_OLLAMA_DIST_URL"] = "http://127.0.0.1:1/unused";
  process.env["SKOVERN_OLLAMA_DIST_SHA256"] = "a".repeat(64);
});
afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(state.dir, { recursive: true, force: true });
});

function plantOnPath(): string {
  const planted = path.join(state.dir, "planted");
  mkdirSync(planted);
  writeFileSync(path.join(planted, EXE), "evil");
  process.env["PATH"] = `${planted}${path.delimiter}${process.env["PATH"] ?? ""}`;
  return path.join(planted, EXE);
}

describe("M9: the helper Skovern set up wins over PATH", () => {
  it("before set-up, a PATH hit is used (a user's own Ollama — unchanged behavior)", () => {
    const planted = plantOnPath();
    expect(resolveOllamaBin()).toBe(planted);
  });

  it("after set-up, the absolute helper path is chosen, never the planted PATH one", () => {
    plantOnPath();
    const managed = path.join(state.dir, "ollama", "0.0.0-test", EXE);
    mkdirSync(path.dirname(managed), { recursive: true });
    writeFileSync(managed, "ours");
    expect(resolveOllamaBin()).toBe(managed);
    expect(path.isAbsolute(resolveOllamaBin()!)).toBe(true);
  });

  it("a set-up helper counts as installed even when the 'no user Ollama' seam says 0", () => {
    process.env["SKOVERN_OLLAMA_INSTALLED"] = "0";
    expect(ollamaInstalled()).toBe(false);
    const managed = path.join(state.dir, "ollama", "0.0.0-test", EXE);
    mkdirSync(path.dirname(managed), { recursive: true });
    writeFileSync(managed, "ours");
    expect(ollamaInstalled()).toBe(true);
  });

  it("a half-unpacked helper (.partial) is never run", () => {
    const partial = path.join(state.dir, "ollama", "0.0.0-test.partial", EXE);
    mkdirSync(path.dirname(partial), { recursive: true });
    writeFileSync(partial, "half");
    process.env["PATH"] = "";
    expect(resolveOllamaBin()).not.toBe(partial);
  });
});

describe("M9: the helper listens on this computer only", () => {
  it("forces loopback and drops extra web origins for the helper we set up", () => {
    const env = serveEnv(true, { OLLAMA_HOST: "0.0.0.0:11434", OLLAMA_ORIGINS: "*", KEEP: "1" });
    expect(env["OLLAMA_HOST"]).toBe("127.0.0.1:11434");
    expect(env["OLLAMA_ORIGINS"]).toBeUndefined();
    expect(env["OLLAMA_MAX_LOADED_MODELS"]).toBe("1");
    expect(env["KEEP"]).toBe("1");
  });

  it("leaves a user's own Ollama config alone", () => {
    const env = serveEnv(false, { OLLAMA_HOST: "0.0.0.0:11434" });
    expect(env["OLLAMA_HOST"]).toBe("0.0.0.0:11434");
  });
});
