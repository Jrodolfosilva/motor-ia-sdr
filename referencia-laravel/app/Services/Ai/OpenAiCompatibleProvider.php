<?php

namespace App\Services\Ai;

use App\Contracts\AiProviderContract;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\RequestException;
use Illuminate\Support\Facades\Http;

/**
 * Shared client for every provider exposing the OpenAI chat-completions
 * request/response shape (OpenAI itself, DeepSeek, Together) - subclasses
 * only supply the endpoint.
 */
abstract class OpenAiCompatibleProvider implements AiProviderContract
{
    protected const TIMEOUT_SECONDS = 20;

    abstract protected function endpoint(): string;

    /**
     * @param  array<int, array{mime: string, data: string}>  $images
     * @return array{text: string, tool_calls: array<int, array{name: string, arguments: array<string, mixed>}>, raw: array<string, mixed>}
     */
    public function vision(string $apiKey, string $model, string $prompt, array $images, ?string $systemPrompt = null, ?float $temperature = null): array
    {
        $content = [['type' => 'text', 'text' => $prompt]];

        foreach ($images as $image) {
            $content[] = [
                'type' => 'image_url',
                'image_url' => ['url' => "data:{$image['mime']};base64,{$image['data']}"],
            ];
        }

        return $this->chat($apiKey, $model, [['role' => 'user', 'content' => $content]], $systemPrompt, [], $temperature);
    }

    /**
     * @param  array<int, array{role: string, content: string|array<int, array<string, mixed>>}>  $messages
     * @param  array<int, array{name: string, description: string, parameters: array<string, mixed>}>  $tools
     * @return array{text: string, tool_calls: array<int, array{name: string, arguments: array<string, mixed>}>, raw: array<string, mixed>}
     */
    public function chat(string $apiKey, string $model, array $messages, ?string $systemPrompt = null, array $tools = [], ?float $temperature = null): array
    {
        $chatMessages = $messages;

        if ($systemPrompt !== null && $systemPrompt !== '') {
            array_unshift($chatMessages, ['role' => 'system', 'content' => $systemPrompt]);
        }

        $payload = [
            'model' => $model,
            'messages' => $chatMessages,
        ];

        if ($temperature !== null) {
            $payload['temperature'] = $temperature;
        }

        if (! empty($tools)) {
            $payload['tools'] = array_map(fn (array $tool): array => [
                'type' => 'function',
                'function' => [
                    'name' => $tool['name'],
                    'description' => $tool['description'],
                    'parameters' => $tool['parameters'],
                ],
            ], $tools);
        }

        // One more try on a timeout, a 429 or a 5xx - a single slow
        // Together response (seen in ai:bench-sdr: 1 timeout in 40 calls)
        // would otherwise end the turn on the fallback message.
        $response = Http::withToken($apiKey)
            ->timeout(static::TIMEOUT_SECONDS)
            ->retry(2, 1000, fn (\Throwable $e) => $e instanceof ConnectionException
                || ($e instanceof RequestException && ($e->response->serverError() || $e->response->status() === 429)))
            ->post($this->endpoint(), $payload)
            ->throw()
            ->json();

        $message = $response['choices'][0]['message'] ?? [];
        $toolCalls = [];

        foreach ($message['tool_calls'] ?? [] as $call) {
            $toolCalls[] = [
                'name' => $call['function']['name'],
                'arguments' => json_decode($call['function']['arguments'] ?? '{}', true) ?? [],
            ];
        }

        return [
            'text' => $message['content'] ?? '',
            'tool_calls' => $toolCalls,
            'raw' => $response,
        ];
    }
}
