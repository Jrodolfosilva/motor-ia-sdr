<?php

namespace App\Services\Ai;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;

/**
 * Transcribes a WhatsApp voice note to text via Groq's Whisper API, so the
 * AI onboarding agent can read an audio message instead of always handing
 * it off to a human (see WebhookHandler::maybeRunAiOnboardingAgent()).
 * Never throws - a missing token, unreachable file, network failure, or
 * empty transcript all just return null, and the caller falls back to the
 * existing media hand-off behavior.
 */
class AudioTranscriptionService
{
    public const MODEL = 'whisper-large-v3-turbo';

    protected const TIMEOUT_SECONDS = 30;

    /**
     * @param  string  $mediaPath  Path relative to the "public" disk, as stored on WhatsappMessage::media_url.
     * @return array{text: string, duration_seconds: float}|null `duration_seconds` is Groq's own reported audio
     *                                                            length, needed by App\Services\Ai\AiCostCalculator
     *                                                            to estimate transcription cost (Whisper is billed
     *                                                            per audio-minute, not per token).
     */
    public function transcribe(string $mediaPath): ?array
    {
        $token = config('services.groq.whisper_token');
        if (! $token) {
            return null;
        }

        if (! Storage::disk('public')->exists($mediaPath)) {
            return null;
        }

        try {
            $response = Http::withToken($token)
                ->timeout(self::TIMEOUT_SECONDS)
                ->attach('file', Storage::disk('public')->get($mediaPath), basename($mediaPath))
                ->post('https://api.groq.com/openai/v1/audio/transcriptions', [
                    'model' => self::MODEL,
                    // 'verbose_json' (instead of 'json') is the only format
                    // Groq returns a `duration` field on - needed for cost
                    // estimation, see the return type above.
                    'response_format' => 'verbose_json',
                ])
                ->throw();

            $text = trim((string) $response->json('text'));
            if ($text === '') {
                return null;
            }

            return [
                'text' => $text,
                'duration_seconds' => (float) $response->json('duration', 0),
            ];
        } catch (\Throwable $e) {
            Log::warning('Audio transcription failed', [
                'media_path' => $mediaPath,
                'error' => $e->getMessage(),
            ]);

            return null;
        }
    }
}
