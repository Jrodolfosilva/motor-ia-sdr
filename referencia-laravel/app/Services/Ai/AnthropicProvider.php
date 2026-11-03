<?php

namespace App\Services\Ai;

use App\Contracts\AiProviderContract;
use Illuminate\Support\Facades\Http;

class AnthropicProvider implements AiProviderContract
{
    protected const API_VERSION = '2023-06-01';

    protected const TIMEOUT_SECONDS = 20;

    /**
     * @param  array<int, array{mime: string, data: string}>  $images
     * @return array{text: string, tool_calls: array<int, array{name: string, arguments: array<string, mixed>}>, raw: array<string, mixed>}
     */
    public function vision(string $apiKey, string $model, string $prompt, array $images, ?string $systemPrompt = null, ?float $temperature = null): array
    {
        $content = [];

        foreach ($images as $image) {
            $content[] = [
                'type' => 'image',
                'source' => ['type' => 'base64', 'media_type' => $image['mime'], 'data' => $image['data']],
            ];
        }

        $content[] = ['type' => 'text', 'text' => $prompt];

        return $this->chat($apiKey, $model, [['role' => 'user', 'content' => $content]], $systemPrompt, [], $temperature);
    }

    /**
     * @param  array<int, array{role: string, content: string|array<int, array<string, mixed>>}>  $messages
     * @param  array<int, array{name: string, description: string, parameters: array<string, mixed>}>  $tools
     * @return array{text: string, tool_calls: array<int, array{name: string, arguments: array<string, mixed>}>, raw: array<string, mixed>}
     */
    public function chat(string $apiKey, string $model, array $messages, ?string $systemPrompt = null, array $tools = [], ?float $temperature = null): array
    {
        $payload = [
            'model' => $model,
            'max_tokens' => 1024,
            'messages' => $messages,
        ];

        if ($temperature !== null) {
            $payload['temperature'] = $temperature;
        }

        if ($systemPrompt !== null && $systemPrompt !== '') {
            // cache_control lets the (usually large, stable) system prompt
            // be cached across turns of the same conversation instead of
            // re-billed on every message.
            $payload['system'] = [
                ['type' => 'text', 'text' => $systemPrompt, 'cache_control' => ['type' => 'ephemeral']],
            ];
        }

        if (! empty($tools)) {
            $payload['tools'] = array_map(fn (array $tool): array => [
                'name' => $tool['name'],
                'description' => $tool['description'],
                'input_schema' => $tool['parameters'],
            ], $tools);
        }

        $response = Http::withHeaders([
            'x-api-key' => $apiKey,
            'anthropic-version' => self::API_VERSION,
        ])
            ->timeout(self::TIMEOUT_SECONDS)
            ->post('https://api.anthropic.com/v1/messages', $payload)
            ->throw()
            ->json();

        $text = '';
        $toolCalls = [];

        foreach ($response['content'] ?? [] as $block) {
            if (($block['type'] ?? null) === 'text') {
                $text .= $block['text'];
            } elseif (($block['type'] ?? null) === 'tool_use') {
                $toolCalls[] = [
                    'name' => $block['name'],
                    'arguments' => $block['input'] ?? [],
                ];
            }
        }

        return [
            'text' => $text,
            'tool_calls' => $toolCalls,
            'raw' => $response,
        ];
    }
}
