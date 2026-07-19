# Multi-modal model catalog — the base layer

**Status:** seed agreed 2026-07-19 (Dawid's 5 decisions folded in). Working file is the JSON; this
doc is the human-readable companion.
**Canonical file:** `catalog/models.multimodal.json` (self-documenting `meta` + `models`).
**Starts:** the parked "multi-runtime plugin-model registry" (043 handoff).

---

## What this is

A structured **reference map** of local, freely-downloadable models across every modality a Skovern
tool/plugin might need: text, agentic, code, vision, OCR, image-gen, image-edit, STT, TTS,
embedding, rerank, translation, moderation.

A tool picks a model by **(a) the job** it's doing and **(b) the user's hardware**. No one model or
size fits everyone: a weak laptop runs Whisper + OCR + embeddings fine while being hopeless at
image-gen. The question is never "good enough computer?" — it's "good enough for THIS job?"

**Seed, not final.** ~44 real entries to lock the shape; curate + expand over time.

## The 5 decisions (Dawid, 2026-07-19)

1. **JSON is the working source of truth**; its `meta` block doubles as the template. This doc is
   kept for reference. (No code reads it yet — that's a later loop.)
2. **13 task categories**, broad on purpose (added code, image-edit, rerank, translation,
   moderation). `video`, `audio/music-gen`, `diarization` reserved in `meta`, no seed yet.
3. **Sizing is by real GPU VRAM**, not fuzzy brackets. Each entry carries `minVramGB` (minimum at
   the recommended quant — a smaller quant lowers it) and `cpuOk` (runs on CPU, slower, still does
   the job). Tier ladder in `meta`: `0,1,2,4,6,8,12,16,24,32,48,80` — open-ended (bigger cards keep
   coming). Notes cover Apple unified memory (shares RAM) and multi-GPU (sums).
4. **Free + downloadable only.** Non-commercial models excluded (NLLB, BRIA RMBG, XTTS →
   dropped/replaced with Apache/MIT equivalents). HF-gated-but-free models (Gemma, Llama) kept — a
   florist doesn't care about a corporation's licensing. Each entry carries `licenseClass`:
   `standard` (OSI: Apache/MIT/BSD/CC-BY) vs `custom` (open weights, bespoke terms — Gemma, Llama,
   Stability, OpenRAIL). The UI shows a `*` for `custom` and links the actual terms, so it's the
   model maker's legal surface, not ours. `gated:true` flags repos that need license-acceptance. Anything paid or needing custom setup is out — that
   user runs their own settings anyway.
5. **We host nothing and store no hashes here.** This is a pure reference map; every entry points
   upstream via `source`, and the runtime/plugin that uses a model acquires it. The separate
   `catalog/models.json` (the chat brains the app itself downloads + sha256-gates directly from
   Hugging Face) is unrelated and unchanged.

## Entry schema

See `meta.fields` in the JSON. Core fields: `id`, `name`, `family`, `task`, `useCases`, `params`,
`minVramGB`, `cpuOk`, `quants`, `runtime`, `source`, `license`, `free`, `gated`, `notes`.
Deliberately **no** `url` / `sha256` / hosted `sizeBytes` — this map never downloads or gates.

## Runtimes (which plugin can host a model)

`gguf` (llama.cpp) · `whisper.cpp` · `ctranslate2` · `sd.cpp` · `diffusers` · `onnx` · `native`.
Full descriptions in `meta.runtimes`. The runtime decides which future plugin can actually run an
entry — a text plugin (gguf) can't host a Whisper model (whisper.cpp), etc.

## Seed coverage (2026-07-19)

| task | count | examples |
|------|------:|----------|
| text | 9 | Gemma 3 (1/4/12/27B), Qwen3, Llama 3.1 8B, Phi-4, Mistral Nemo |
| agentic | 4 | Qwen3-30B-A3B, DeepSeek-R1-Distill 8B, QwQ 32B |
| code | 3 | Qwen2.5-Coder 1.5/7/32B |
| vision | 4 | Moondream 2, Qwen2.5-VL 7B, MiniCPM-V, SmolVLM |
| ocr | 4 | Tesseract, PaddleOCR, GOT-OCR 2.0, olmOCR 7B |
| image-gen | 4 | SD 1.5, SDXL-Turbo, SD 3.5 Medium, FLUX.1-schnell |
| image-edit | 2 | Real-ESRGAN (upscale), BiRefNet (bg-removal) |
| stt | 5 | Whisper tiny/small/large-v3, Parakeet 0.6B, Moonshine |
| tts | 2 | Piper, Kokoro 82M |
| embedding | 3 | all-MiniLM, BGE-small, Nomic Embed |
| rerank | 1 | BGE-reranker v2-m3 |
| translation | 2 | MADLAD-400 3B, Opus-MT |
| moderation | 1 | ShieldGemma 2B |

## Still to do (curation, later loops)

- Pin approximate `~` sizes and verify `minVramGB` per quant.
- Decide the gated-model policy (Gemma/Llama: keep for the florist, or power-user-only?).
- Add reserved categories when a tool needs them (video, audio-gen, diarization).
- Wire a consumer: when the first plugin/tool needs to *select* a model, add the code that reads
  this file + the hardware verdict and suggests one that fits. That loop gets the full BUILD →
  VERIFY → SECURE treatment; this artifact is design only.
