<?php

namespace App\Http\Controllers\Admin;

use App\Enums\AiAgentRole;
use App\Http\Controllers\Controller;
use App\Models\AiAgent;
use App\Models\AiAgentKit;
use App\Models\AiPlaygroundSession;
use App\Services\Ai\AiPlaygroundRunner;
use App\Support\PhoneNumber;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Inertia\Inertia;
use Inertia\Response as InertiaResponse;

/**
 * "Testar IA": a persistent sandbox chat with a hub's SDR agent (see
 * AiPlaygroundRunner). One session per (hub, user), kept until the user
 * resets it, so a test can span many turns - text, voice notes and files -
 * exactly like a real lead's conversation, with nothing sent on WhatsApp.
 */
class AiAgentKitPlaygroundController extends Controller
{
    private const MEDIA_DIRECTORY = 'ai-playground';

    public function show(Request $request, AiAgentKit $aiAgentKit): InertiaResponse
    {
        $agent = $this->sdrAgent($request, $aiAgentKit);
        $session = $this->session($request, $aiAgentKit);

        return Inertia::render('client/ai-agent-kits/playground', [
            'kit' => [
                'id' => $aiAgentKit->id,
                'name' => $aiAgentKit->name,
                'engine_version' => $aiAgentKit->engine_version,
                'is_active' => (bool) $aiAgentKit->is_active,
            ],
            'agent' => [
                'name' => $agent->name,
                'has_api_key' => (bool) $agent->api_key,
                'reads_files' => $agent->usesEngineV2() && $agent->visionModel() !== null,
                'transcribes_audio' => (bool) config('services.groq.whisper_token'),
                'required_fields' => collect($agent->required_fields ?? [])->map(fn (array $field) => Arr::only($field, ['key', 'label']))->values(),
            ],
            'session' => $this->serializeSession($session),
        ]);
    }

    public function send(Request $request, AiAgentKit $aiAgentKit, AiPlaygroundRunner $runner): JsonResponse
    {
        $agent = $this->sdrAgent($request, $aiAgentKit);

        $validated = $request->validate([
            'message' => ['nullable', 'required_without:file', 'string', 'max:2000'],
            // 16 MB: WhatsApp's own limit for media a lead can send.
            'file' => ['nullable', 'file', 'max:16384', 'mimes:jpg,jpeg,png,webp,gif,pdf,doc,docx,mp3,ogg,oga,opus,m4a,wav,webm,aac,mp4'],
            'voice' => ['nullable', 'boolean'],
        ]);

        if (! $agent->api_key) {
            return response()->json(['error' => __('Configure a chave de API do provedor antes de testar o agente.')], 422);
        }

        $session = $this->session($request, $aiAgentKit);
        $text = trim((string) ($validated['message'] ?? ''));

        $inbound = ['type' => 'text', 'body' => $text];
        if ($request->hasFile('file')) {
            $file = $request->file('file');
            $inbound = [
                'type' => $this->mediaType($file, (bool) ($validated['voice'] ?? false)),
                'body' => $text,
                'media_path' => $file->storeAs(
                    self::MEDIA_DIRECTORY."/{$aiAgentKit->tenant_id}",
                    Str::uuid().'.'.($file->extension() ?: $file->getClientOriginalExtension()),
                    'public'
                ),
                'file_name' => $file->getClientOriginalName(),
            ];
        }

        $runner->handle($session, $agent, $inbound);

        return response()->json(['session' => $this->serializeSession($session->fresh())]);
    }

    public function reset(Request $request, AiAgentKit $aiAgentKit): JsonResponse
    {
        $this->sdrAgent($request, $aiAgentKit);

        $validated = $request->validate([
            'phone' => ['nullable', 'string', 'max:32'],
            'custom_fields' => ['nullable', 'array'],
        ]);

        $session = $this->session($request, $aiAgentKit);
        $this->deleteMedia($session);

        $session->update([
            'phone' => filled($validated['phone'] ?? null) ? PhoneNumber::normalize($validated['phone']) : $session->phone,
            'custom_fields' => array_filter($validated['custom_fields'] ?? [], fn ($value) => filled($value)) ?: null,
            'messages' => [],
            'status' => 'active',
            'turns_count' => 0,
            'opening_completed' => false,
            'sent_media_ids' => null,
            'classification' => null,
        ]);

        return response()->json(['session' => $this->serializeSession($session)]);
    }

    private function sdrAgent(Request $request, AiAgentKit $aiAgentKit): AiAgent
    {
        if ($aiAgentKit->tenant_id !== $request->user()->tenant->id) {
            abort(403);
        }

        return $aiAgentKit->agents()->where('role', AiAgentRole::Sdr)->firstOrFail();
    }

    private function session(Request $request, AiAgentKit $aiAgentKit): AiPlaygroundSession
    {
        return AiPlaygroundSession::firstOrCreate(
            ['ai_agent_kit_id' => $aiAgentKit->id, 'user_id' => $request->user()->id],
            ['tenant_id' => $aiAgentKit->tenant_id, 'phone' => AiPlaygroundSession::DEFAULT_PHONE, 'messages' => []],
        );
    }

    /**
     * A recorded voice note is always audio (browsers record webm/ogg,
     * which may sniff as video); otherwise by mime, the same buckets a
     * WhatsApp webhook produces.
     */
    private function mediaType(UploadedFile $file, bool $isVoiceNote): string
    {
        $mime = (string) $file->getMimeType();

        return match (true) {
            $isVoiceNote, str_starts_with($mime, 'audio/') => 'audio',
            str_starts_with($mime, 'image/') => 'image',
            str_starts_with($mime, 'video/') => 'video',
            default => 'document',
        };
    }

    /**
     * Files the tester uploaded - never the kit's media library, which the
     * AI's own replies only reference.
     */
    private function deleteMedia(AiPlaygroundSession $session): void
    {
        $paths = collect($session->messages ?? [])
            ->where('role', 'user')
            ->pluck('media_path')
            ->filter(fn ($path) => is_string($path) && str_starts_with($path, self::MEDIA_DIRECTORY.'/'))
            ->all();

        if ($paths !== []) {
            Storage::disk('public')->delete($paths);
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function serializeSession(AiPlaygroundSession $session): array
    {
        $disk = Storage::disk('public');

        return [
            'phone' => $session->phone,
            'status' => $session->status,
            'turns_count' => $session->turns_count,
            'classification' => $session->classification,
            'custom_fields' => (object) ($session->custom_fields ?? []),
            'messages' => collect($session->messages ?? [])->map(fn (array $message) => Arr::except($message, ['media_path']) + [
                'media_url' => isset($message['media_path']) ? $disk->url($message['media_path']) : null,
            ])->values(),
        ];
    }
}
