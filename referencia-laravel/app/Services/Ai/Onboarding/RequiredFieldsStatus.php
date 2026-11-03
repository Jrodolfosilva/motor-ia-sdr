<?php

namespace App\Services\Ai\Onboarding;

use Illuminate\Support\Collection;

/**
 * Compares an agent's roteiro (required_fields) against a contact's known
 * custom_fields. Shared by all three onboarding agents so "is this field
 * filled" is computed exactly one way - the qualifier's classify gate would
 * be meaningless if it used a different notion of "filled" than what the
 * extractor/responder show the model.
 */
class RequiredFieldsStatus
{
    /** @var Collection<int, array{key: string, label: string, question: string}> */
    public readonly Collection $fields;

    /**
     * @param  array<int, array{key: string, label: string, question: string}>  $requiredFields
     * @param  array<string, mixed>  $known
     */
    public function __construct(array $requiredFields, public readonly array $known)
    {
        $this->fields = collect($requiredFields);
    }

    /**
     * True once every roteiro field has a non-empty value on the contact's
     * profile - or trivially true when the agent has no roteiro at all.
     */
    public function isComplete(): bool
    {
        return $this->missing()->isEmpty();
    }

    /** @return Collection<int, array{key: string, label: string, question: string}> */
    public function missing(): Collection
    {
        return $this->fields->filter(fn (array $field) => ! $this->hasValue($field['key'] ?? ''));
    }

    public function value(string $key): mixed
    {
        return $this->known[$key] ?? null;
    }

    /**
     * Whether the contact already came in with some pre-fill data - a
     * roteiro field already answered, or an unmatched external-form value.
     * Drives the Fluxo A ("já tem cadastro" - confirm, don't re-ask) vs.
     * Fluxo B ("lead frio" - ask everything, one at a time) directive
     * injected into LeadResponderAgent's prompt.
     */
    public function hasAnyKnownData(): bool
    {
        $hasFilledRoteiroField = $this->fields->contains(fn (array $field) => $this->hasValue($field['key'] ?? ''));

        return $hasFilledRoteiroField || $this->unmatched()->isNotEmpty();
    }

    private function hasValue(string $key): bool
    {
        $value = $this->known[$key] ?? null;

        return $value !== null && $value !== '';
    }

    /**
     * custom_fields entries that don't match a roteiro key verbatim - e.g. a
     * lead-form integration (Meta Lead Ads, a site form) writing its own
     * field names via the public API instead of this agent's roteiro keys.
     *
     * @return Collection<string, mixed>
     */
    public function unmatched(): Collection
    {
        $matchedKeys = $this->fields->pluck('key')->filter()->all();

        return collect($this->known)->except($matchedKeys)->filter(fn ($value) => $value !== null && $value !== '');
    }
}
