// Transcrição de áudio do lead (Whisper via Together, endpoint compatível com OpenAI).
// O motor espera `transcript` já preenchido na mensagem antes do intake (docs/06).

const ENDPOINT = 'https://api.together.xyz/v1/audio/transcriptions';
const MODEL = process.env.TRANSCRIBE_MODEL ?? 'openai/whisper-large-v3';
const TIMEOUT_MS = 60_000;

const EXT: Record<string, string> = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
};

export const extForMime = (mime: string) => EXT[mime.split(';')[0].trim()] ?? 'webm';

export const TRANSCRIBE_MODEL = MODEL;

/** Retorna o texto falado (ou null) e a duração do áudio em segundos (para custo). */
export async function transcribe(apiKey: string, audio: Buffer, mime: string): Promise<{ text: string | null; seconds: number; error?: string }> {
  if (!apiKey) return { text: null, seconds: 0, error: 'TOGETHER_API_KEY não definida' };
  const fd = new FormData();
  const type = mime.split(';')[0].trim() || 'audio/webm';
  fd.append('file', new Blob([new Uint8Array(audio)], { type }), `audio.${extForMime(type)}`);
  fd.append('model', MODEL);
  fd.append('language', 'pt');
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await r.text();
    if (!r.ok) return { text: null, seconds: 0, error: `HTTP ${r.status}: ${body.slice(0, 200)}` };
    const j = JSON.parse(body);
    const text = String(j.text ?? '').trim();
    return { text: text || null, seconds: Number(j.duration) || 0, error: text ? undefined : 'transcrição vazia' };
  } catch (e) {
    return { text: null, seconds: 0, error: (e as Error).message };
  }
}
