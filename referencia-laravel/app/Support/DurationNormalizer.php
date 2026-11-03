<?php

namespace App\Support;

/**
 * Canonicalizes a duration mentioned inside a free-text lead answer (e.g.
 * "oito meses", "8 meses", "trabalho há uns dez anos") into a single digit
 * form ("8 meses", "10 anos") while leaving the rest of the sentence alone.
 *
 * Exists because AiOnboardingAgentRunner's extractor sub-agent saves
 * whatever wording the lead used verbatim - "8 meses" and "oito meses" are
 * the same fact but read as different strings to LeadQualifierAgent, which
 * only ever sees the stored text, not the original conversation. Written as
 * a plain post-processing pass (not a stricter extractor tool schema) so it
 * applies to every roteiro field of every agent kit, not just the ones a
 * tenant happens to define as numeric.
 */
class DurationNormalizer
{
    /**
     * @var array<string, int>
     */
    private const WORD_NUMBERS = [
        'zero' => 0, 'um' => 1, 'uma' => 1, 'dois' => 2, 'duas' => 2, 'tres' => 3,
        'quatro' => 4, 'cinco' => 5, 'seis' => 6, 'sete' => 7, 'oito' => 8, 'nove' => 9,
        'dez' => 10, 'onze' => 11, 'doze' => 12, 'treze' => 13, 'catorze' => 14, 'quatorze' => 14,
        'quinze' => 15, 'dezesseis' => 16, 'dezessete' => 17, 'dezoito' => 18, 'dezenove' => 19,
        'vinte' => 20, 'trinta' => 30, 'quarenta' => 40, 'cinquenta' => 50,
        'sessenta' => 60, 'setenta' => 70, 'oitenta' => 80, 'noventa' => 90,
    ];

    private const UNIT_SINGULAR = ['mes' => 'mês', 'semana' => 'semana', 'ano' => 'ano'];

    private const UNIT_PLURAL = ['mes' => 'meses', 'semana' => 'semanas', 'ano' => 'anos'];

    private const PATTERN = '/(?<number>\d+|[a-zà-ú]+(?:\s+e\s+[a-zà-ú]+)?)\s*(?<unit>m[eê]s(?:es)?|semanas?|anos?)/iu';

    public static function normalize(string $raw): string
    {
        return preg_replace_callback(self::PATTERN, function (array $match): string {
            $count = self::parseNumber($match['number']);

            if ($count === null) {
                return $match[0];
            }

            $unitKey = self::unitKey($match['unit']);
            $unitWord = $count === 1 ? self::UNIT_SINGULAR[$unitKey] : self::UNIT_PLURAL[$unitKey];

            return "{$count} {$unitWord}";
        }, $raw) ?? $raw;
    }

    /**
     * Extracts the first duration mentioned anywhere in the string and
     * converts it to a total number of months (weeks round down, e.g. "3
     * semanas" -> 0 meses - only meant for month-granularity comparisons
     * like a carência threshold, not for gestational age). Returns null
     * when no recognizable duration is found, same as normalize() leaving
     * unparseable text untouched - callers (ClassificationRuleEvaluator)
     * treat that as "can't evaluate this condition", never as zero.
     */
    public static function toMonths(string $raw): ?int
    {
        if (! preg_match(self::PATTERN, $raw, $match)) {
            return null;
        }

        $count = self::parseNumber($match['number']);
        if ($count === null) {
            return null;
        }

        return match (self::unitKey($match['unit'])) {
            'semana' => intdiv($count, 4),
            'ano' => $count * 12,
            default => $count,
        };
    }

    private static function parseNumber(string $token): ?int
    {
        return is_numeric($token) ? (int) $token : self::parseWordNumber($token);
    }

    private static function unitKey(string $unit): string
    {
        $stripped = self::stripAccents(mb_strtolower($unit));

        return match (true) {
            str_starts_with($stripped, 'mes') => 'mes',
            str_starts_with($stripped, 'semana') => 'semana',
            default => 'ano',
        };
    }

    /**
     * Parses a spelled-out Portuguese number up to 99 (e.g. "oito",
     * "vinte e tres"). Returns null for anything outside that - the caller
     * leaves the original text untouched rather than guessing.
     */
    private static function parseWordNumber(string $words): ?int
    {
        $parts = explode(' e ', self::stripAccents(mb_strtolower(trim($words))));

        if (count($parts) === 1) {
            return self::WORD_NUMBERS[$parts[0]] ?? null;
        }

        if (count($parts) === 2) {
            $tens = self::WORD_NUMBERS[trim($parts[0])] ?? null;
            $units = self::WORD_NUMBERS[trim($parts[1])] ?? null;

            return $tens !== null && $units !== null && $tens >= 20 && $units < 10
                ? $tens + $units
                : null;
        }

        return null;
    }

    private static function stripAccents(string $value): string
    {
        return strtr($value, [
            'á' => 'a', 'â' => 'a', 'ã' => 'a', 'à' => 'a',
            'é' => 'e', 'ê' => 'e',
            'í' => 'i',
            'ó' => 'o', 'ô' => 'o', 'õ' => 'o',
            'ú' => 'u',
            'ç' => 'c',
        ]);
    }
}
