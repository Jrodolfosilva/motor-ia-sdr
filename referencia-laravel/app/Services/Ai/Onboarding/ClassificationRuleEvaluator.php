<?php

namespace App\Services\Ai\Onboarding;

use App\Support\DurationNormalizer;
use Carbon\CarbonImmutable;

/**
 * Evaluates an optional, per-classification-label "rules" condition list
 * against a contact's known custom_fields - a deterministic, opt-in
 * alternative/safety-net to letting LeadQualifierAgent's LLM call decide
 * everything. A label with no rules configured is untouched by this class;
 * every existing kit keeps behaving exactly as before.
 *
 * Deliberately generic (field/operator/value, no maternity-specific
 * knowledge) so any tenant's kit can use it, not just the built-in
 * salário-maternidade template - see AiOnboardingAgentRunner::run() and
 * LeadQualifierAgent::decide() for the two places this gates a decision.
 */
class ClassificationRuleEvaluator
{
    /**
     * @param  array<int, array{field: string, operator: string, value: mixed}>  $rules
     * @param  array<string, mixed>  $known
     */
    public static function matches(array $rules, array $known): bool
    {
        if (empty($rules)) {
            return false;
        }

        foreach ($rules as $rule) {
            if (! self::conditionMatches($rule, $known)) {
                return false;
            }
        }

        return true;
    }

    /**
     * @param  array{field: string, operator: string, value: mixed}  $rule
     * @param  array<string, mixed>  $known
     */
    private static function conditionMatches(array $rule, array $known): bool
    {
        $value = $known[$rule['field'] ?? ''] ?? null;

        return match ($rule['operator'] ?? null) {
            'present' => $value !== null && $value !== '',
            'contains_any' => self::containsAny($value, $rule['value'] ?? []),
            'not_contains_any' => $value !== null && $value !== '' && ! self::containsAny($value, $rule['value'] ?? []),
            'gte_months' => self::compareMonths($value, $rule['value'] ?? null, fn (int $a, int $b) => $a >= $b),
            'lt_months' => self::compareMonths($value, $rule['value'] ?? null, fn (int $a, int $b) => $a < $b),
            'months_since_gte' => self::compareMonthsSince($value, $rule['value'] ?? null, fn (int $a, int $b) => $a >= $b),
            'months_since_lt' => self::compareMonthsSince($value, $rule['value'] ?? null, fn (int $a, int $b) => $a < $b),
            default => false,
        };
    }

    /**
     * Whole months elapsed between a date mentioned in $value and today -
     * the "data de saída da CTPS was N months ago" check. Accepts
     * DD/MM/AAAA (or DD/MM/AA, with - or . separators), AAAA-MM-DD,
     * MM/AAAA, "outubro de 2025"/"out/2025", and falls back to a plain
     * duration ("há 8 meses") via DurationNormalizer. A future date, or
     * text with no date at all, never matches.
     */
    public static function monthsSince(string $value, ?\DateTimeInterface $today = null): ?int
    {
        return self::parseDate($value) === null
            ? DurationNormalizer::toMonths($value)
            : self::monthsSinceDate($value, $today);
    }

    /**
     * Same as monthsSince(), but only for an actual date in $value - no
     * duration fallback. Null for text without a (past) date.
     */
    public static function monthsSinceDate(string $value, ?\DateTimeInterface $today = null): ?int
    {
        $date = self::parseDate($value);
        if ($date === null) {
            return null;
        }

        // CarbonImmutable::now(), not the now() helper - this class is also
        // used from plain unit tests with no app container booted.
        $today = $today !== null
            ? CarbonImmutable::instance($today)->startOfDay()
            : CarbonImmutable::now()->startOfDay();
        if ($date->greaterThan($today)) {
            return null;
        }

        return (int) $date->diffInMonths($today);
    }

    private static function compareMonthsSince(mixed $value, mixed $threshold, callable $compare): bool
    {
        if (! is_string($value) || ! is_numeric($threshold)) {
            return false;
        }

        $months = self::monthsSince($value);

        return $months !== null && $compare($months, (int) $threshold);
    }

    private const MONTH_NAMES = [
        'jan' => 1, 'fev' => 2, 'mar' => 3, 'abr' => 4, 'mai' => 5, 'jun' => 6,
        'jul' => 7, 'ago' => 8, 'set' => 9, 'out' => 10, 'nov' => 11, 'dez' => 12,
    ];

    private static function parseDate(string $value): ?CarbonImmutable
    {
        $text = self::normalizeForCompare($value);

        [$day, $month, $year] = match (true) {
            (bool) preg_match('/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/', $text, $m) => [(int) $m[3], (int) $m[2], (int) $m[1]],
            (bool) preg_match('/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})\b/', $text, $m) => [(int) $m[1], (int) $m[2], (int) $m[3]],
            (bool) preg_match('/\b(\d{1,2})[\/.\-](\d{4})\b/', $text, $m) => [1, (int) $m[1], (int) $m[2]],
            (bool) preg_match('/\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*\.?\s*(?:de\s+|\/\s*)?(\d{4})\b/', $text, $m) => [1, self::MONTH_NAMES[$m[1]], (int) $m[2]],
            default => [null, null, null],
        };

        if ($year === null) {
            return null;
        }

        if ($year < 100) {
            $year += 2000;
        }

        if (! checkdate($month, $day, $year)) {
            return null;
        }

        return CarbonImmutable::create($year, $month, $day)->startOfDay();
    }

    /**
     * @param  mixed  $needles  A string or list of candidate words - any one matching (substring, case/accent-insensitive) is enough.
     */
    private static function containsAny(mixed $value, mixed $needles): bool
    {
        if (! is_string($value) || $value === '') {
            return false;
        }

        $haystack = self::normalizeForCompare($value);

        foreach ((array) $needles as $needle) {
            if (is_string($needle) && $needle !== '' && str_contains($haystack, self::normalizeForCompare($needle))) {
                return true;
            }
        }

        return false;
    }

    private static function compareMonths(mixed $value, mixed $threshold, callable $compare): bool
    {
        if (! is_string($value) || ! is_numeric($threshold)) {
            return false;
        }

        $months = DurationNormalizer::toMonths($value);

        return $months !== null && $compare($months, (int) $threshold);
    }

    private static function normalizeForCompare(string $value): string
    {
        return strtr(mb_strtolower($value), [
            'á' => 'a', 'â' => 'a', 'ã' => 'a', 'à' => 'a',
            'é' => 'e', 'ê' => 'e',
            'í' => 'i',
            'ó' => 'o', 'ô' => 'o', 'õ' => 'o',
            'ú' => 'u',
            'ç' => 'c',
        ]);
    }
}
