/**
 * Stands in for the speech engine's Python where there is no MLX: `-m mlx_audio.server` and `-m mlx_lm.server` serve
 * OpenAI-style answers on the port they are given, after FAKE_VOICE_ENGINE_LOAD_MS, and note what they were asked in
 * FAKE_VOICE_ENGINE_LOG.
 */
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1] ?? "";
const serverModule = option("-m");
const log = (entry: Record<string, unknown>) => appendFileSync(process.env.FAKE_VOICE_ENGINE_LOG!, `${JSON.stringify({ module: serverModule, pid: process.pid, ...entry })}\n`);

log({ event: "start", model: option("--model"), host: option("--host"), port: option("--port") });
await Bun.sleep(Number(process.env.FAKE_VOICE_ENGINE_LOAD_MS ?? 0));

Bun.serve({
  hostname: option("--host"),
  port: Number(option("--port")),
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/v1/models") return Response.json({ object: "list", data: [] });
    if (pathname === "/v1/audio/transcriptions") {
      const form = await request.formData();
      log({ event: "transcription", model: form.get("model"), responseFormat: form.get("response_format") });
      const text = "Futtasd le az e2e teszteket.";
      return Response.json(form.get("response_format") === "verbose_json" ? { text, language: "hu", segments: [] } : { text });
    }
    if (pathname === "/v1/chat/completions") {
      const body = (await request.json()) as { model: string; chat_template_kwargs?: unknown };
      log({ event: "chat", model: body.model, chatTemplateKwargs: body.chat_template_kwargs ?? null });
      return Response.json({ choices: [{ message: { role: "assistant", content: "Run the e2e tests." }, finish_reason: "stop" }] });
    }
    return new Response("not found", { status: 404 });
  },
});
