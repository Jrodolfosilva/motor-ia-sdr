<?php

namespace App\Contracts;

/**
 * Common surface implemented by every LLM provider (Anthropic, OpenAI, ...)
 * backing an AI attendant agent.
 */
interface AiProviderContract
{
    /**
     * Send a chat completion request and return a normalized result shape.
     * $apiKey is always the tenant's own key (entered when the agent was
     * configured) - this app has no platform-pooled fallback key.
     *
     * @param  array<int, array{role: string, content: string}>  $messages  Conversation history, oldest first. Never includes the system prompt (passed separately).
     * @param  array<int, array{name: string, description: string, parameters: array<string, mixed>}>  $tools  JSON-schema tool definitions the model may call.
     * @param  float|null  $temperature  Provider default when omitted. The onboarding sub-agents each pass their
     *                                   own value (low/near-zero for the structured extractor/qualifier calls,
     *                                   moderate for the responder's actual reply) - see the constants on
     *                                   LeadExtractorAgent/LeadQualifierAgent/LeadResponderAgent.
     * @return array{text: string, tool_calls: array<int, array{name: string, arguments: array<string, mixed>}>, raw: array<string, mixed>}
     */
    public function chat(string $apiKey, string $model, array $messages, ?string $systemPrompt = null, array $tools = [], ?float $temperature = null): array;

    /**
     * Single-turn multimodal request: one user message made of $prompt plus
     * every image in $images (oldest first). An empty $images is a plain
     * text request - used for PDFs whose text layer was extracted.
     *
     * @param  array<int, array{mime: string, data: string}>  $images  Base64-encoded image bytes.
     * @return array{text: string, tool_calls: array<int, array{name: string, arguments: array<string, mixed>}>, raw: array<string, mixed>}
     */
    public function vision(string $apiKey, string $model, string $prompt, array $images, ?string $systemPrompt = null, ?float $temperature = null): array;
}
