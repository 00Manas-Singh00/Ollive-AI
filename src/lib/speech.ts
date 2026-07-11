import OpenAI, { toFile } from "openai";
import { GoogleGenAI } from "@google/genai";

type SttProvider = "openai" | "gemini";

const geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function openaiClient(): OpenAI {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });
}

// Defaults to Gemini when OPENAI_API_KEY isn't set, since GEMINI_API_KEY is
// already required for the base app and Gemini accepts raw audio input.
function sttProvider(): SttProvider {
  const configured = (process.env.SPEECH_STT_PROVIDER || "").toLowerCase();
  if (configured === "openai" || configured === "gemini") return configured;
  return process.env.OPENAI_API_KEY ? "openai" : "gemini";
}

export async function transcribeAudio(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<{ text: string; provider: string; model: string }> {
  const provider = sttProvider();

  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
    const model = process.env.SPEECH_STT_MODEL || "whisper-1";
    const file = await toFile(buffer, filename, { type: mimeType });
    const res = await openaiClient().audio.transcriptions.create({ file, model });
    return { text: res.text.trim(), provider: "openai", model };
  }

  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const model = process.env.SPEECH_STT_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const response = await geminiClient.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { text: "Transcribe this audio verbatim. Return only the transcription, no commentary." },
          { inlineData: { mimeType, data: buffer.toString("base64") } },
        ],
      },
    ],
  });
  return { text: (response.text || "").trim(), provider: "gemini", model };
}

export async function synthesizeSpeech(text: string): Promise<{ audio: Buffer; mimeType: string; provider: string; model: string }> {
  const provider = (process.env.SPEECH_TTS_PROVIDER || "openai").toLowerCase();
  if (provider !== "openai") throw new Error(`Unsupported SPEECH_TTS_PROVIDER: ${provider}`);
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured for speech synthesis");

  const model = process.env.SPEECH_TTS_MODEL || "tts-1";
  const voice = process.env.SPEECH_TTS_VOICE || "alloy";
  const res = await openaiClient().audio.speech.create({ model, voice, input: text, response_format: "mp3" });
  const arrayBuffer = await res.arrayBuffer();
  return { audio: Buffer.from(arrayBuffer), mimeType: "audio/mpeg", provider: "openai", model };
}
