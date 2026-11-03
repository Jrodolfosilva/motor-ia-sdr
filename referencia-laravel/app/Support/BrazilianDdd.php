<?php

namespace App\Support;

/**
 * Maps a Brazilian phone number's DDD (area code) to its state - used to
 * let an AI agent personalize its greeting ("atuamos em todo o Brasil, com
 * forte presença no seu estado") without guessing: the mapping is fixed by
 * ANATEL, not something an LLM should be trusted to recall correctly on its
 * own, especially on cheaper/smaller models.
 */
final class BrazilianDdd
{
    /**
     * @var array<int, array{uf: string, name: string}>
     */
    private const MAP = [
        11 => ['uf' => 'SP', 'name' => 'São Paulo'],
        12 => ['uf' => 'SP', 'name' => 'São Paulo'],
        13 => ['uf' => 'SP', 'name' => 'São Paulo'],
        14 => ['uf' => 'SP', 'name' => 'São Paulo'],
        15 => ['uf' => 'SP', 'name' => 'São Paulo'],
        16 => ['uf' => 'SP', 'name' => 'São Paulo'],
        17 => ['uf' => 'SP', 'name' => 'São Paulo'],
        18 => ['uf' => 'SP', 'name' => 'São Paulo'],
        19 => ['uf' => 'SP', 'name' => 'São Paulo'],
        21 => ['uf' => 'RJ', 'name' => 'Rio de Janeiro'],
        22 => ['uf' => 'RJ', 'name' => 'Rio de Janeiro'],
        24 => ['uf' => 'RJ', 'name' => 'Rio de Janeiro'],
        27 => ['uf' => 'ES', 'name' => 'Espírito Santo'],
        28 => ['uf' => 'ES', 'name' => 'Espírito Santo'],
        31 => ['uf' => 'MG', 'name' => 'Minas Gerais'],
        32 => ['uf' => 'MG', 'name' => 'Minas Gerais'],
        33 => ['uf' => 'MG', 'name' => 'Minas Gerais'],
        34 => ['uf' => 'MG', 'name' => 'Minas Gerais'],
        35 => ['uf' => 'MG', 'name' => 'Minas Gerais'],
        37 => ['uf' => 'MG', 'name' => 'Minas Gerais'],
        38 => ['uf' => 'MG', 'name' => 'Minas Gerais'],
        41 => ['uf' => 'PR', 'name' => 'Paraná'],
        42 => ['uf' => 'PR', 'name' => 'Paraná'],
        43 => ['uf' => 'PR', 'name' => 'Paraná'],
        44 => ['uf' => 'PR', 'name' => 'Paraná'],
        45 => ['uf' => 'PR', 'name' => 'Paraná'],
        46 => ['uf' => 'PR', 'name' => 'Paraná'],
        47 => ['uf' => 'SC', 'name' => 'Santa Catarina'],
        48 => ['uf' => 'SC', 'name' => 'Santa Catarina'],
        49 => ['uf' => 'SC', 'name' => 'Santa Catarina'],
        51 => ['uf' => 'RS', 'name' => 'Rio Grande do Sul'],
        53 => ['uf' => 'RS', 'name' => 'Rio Grande do Sul'],
        54 => ['uf' => 'RS', 'name' => 'Rio Grande do Sul'],
        55 => ['uf' => 'RS', 'name' => 'Rio Grande do Sul'],
        61 => ['uf' => 'DF', 'name' => 'Distrito Federal'],
        62 => ['uf' => 'GO', 'name' => 'Goiás'],
        64 => ['uf' => 'GO', 'name' => 'Goiás'],
        63 => ['uf' => 'TO', 'name' => 'Tocantins'],
        65 => ['uf' => 'MT', 'name' => 'Mato Grosso'],
        66 => ['uf' => 'MT', 'name' => 'Mato Grosso'],
        67 => ['uf' => 'MS', 'name' => 'Mato Grosso do Sul'],
        68 => ['uf' => 'AC', 'name' => 'Acre'],
        69 => ['uf' => 'RO', 'name' => 'Rondônia'],
        71 => ['uf' => 'BA', 'name' => 'Bahia'],
        73 => ['uf' => 'BA', 'name' => 'Bahia'],
        74 => ['uf' => 'BA', 'name' => 'Bahia'],
        75 => ['uf' => 'BA', 'name' => 'Bahia'],
        77 => ['uf' => 'BA', 'name' => 'Bahia'],
        79 => ['uf' => 'SE', 'name' => 'Sergipe'],
        81 => ['uf' => 'PE', 'name' => 'Pernambuco'],
        87 => ['uf' => 'PE', 'name' => 'Pernambuco'],
        82 => ['uf' => 'AL', 'name' => 'Alagoas'],
        83 => ['uf' => 'PB', 'name' => 'Paraíba'],
        84 => ['uf' => 'RN', 'name' => 'Rio Grande do Norte'],
        85 => ['uf' => 'CE', 'name' => 'Ceará'],
        88 => ['uf' => 'CE', 'name' => 'Ceará'],
        86 => ['uf' => 'PI', 'name' => 'Piauí'],
        89 => ['uf' => 'PI', 'name' => 'Piauí'],
        91 => ['uf' => 'PA', 'name' => 'Pará'],
        93 => ['uf' => 'PA', 'name' => 'Pará'],
        94 => ['uf' => 'PA', 'name' => 'Pará'],
        92 => ['uf' => 'AM', 'name' => 'Amazonas'],
        97 => ['uf' => 'AM', 'name' => 'Amazonas'],
        95 => ['uf' => 'RR', 'name' => 'Roraima'],
        96 => ['uf' => 'AP', 'name' => 'Amapá'],
        98 => ['uf' => 'MA', 'name' => 'Maranhão'],
        99 => ['uf' => 'MA', 'name' => 'Maranhão'],
    ];

    /**
     * @param  string  $phone  Normalized phone (App\Support\PhoneNumber::normalize()
     *                         shape: "+55DDXXXXXXXXX") - any other format returns null.
     * @return array{uf: string, name: string}|null
     */
    public static function stateFor(string $phone): ?array
    {
        $digits = preg_replace('/\D/', '', $phone);

        if (! str_starts_with($digits, '55') || strlen($digits) < 4) {
            return null;
        }

        $ddd = (int) substr($digits, 2, 2);

        return self::MAP[$ddd] ?? null;
    }

    /**
     * Portuguese "in <state>" takes a different preposition per state
     * ("na Bahia", "no Rio de Janeiro", "em São Paulo") - the greeting used
     * to say "em Bahia" for every one.
     *
     * @var array<string, string>
     */
    private const PREPOSITIONS = [
        'AC' => 'no', 'AL' => 'em', 'AP' => 'no', 'AM' => 'no', 'BA' => 'na', 'CE' => 'no', 'DF' => 'no',
        'ES' => 'no', 'GO' => 'em', 'MA' => 'no', 'MT' => 'em', 'MS' => 'em', 'MG' => 'em', 'PA' => 'no',
        'PB' => 'na', 'PR' => 'no', 'PE' => 'em', 'PI' => 'no', 'RJ' => 'no', 'RN' => 'no', 'RS' => 'no',
        'RO' => 'em', 'RR' => 'em', 'SC' => 'em', 'SP' => 'em', 'SE' => 'em', 'TO' => 'no',
    ];

    /**
     * @param  array{uf: string, name: string}  $state
     */
    public static function inState(array $state): string
    {
        return (self::PREPOSITIONS[$state['uf']] ?? 'em').' '.$state['name'];
    }
}
