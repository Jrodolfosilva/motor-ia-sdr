<?php

namespace App\Support;

use Carbon\CarbonInterface;

/**
 * The "where and when" line every onboarding sub-agent gets in its system
 * prompt. Models don't know today's date - without it "nasce esse ano",
 * "saí em julho" or "o bebê nasceu semana passada" can't be turned into a
 * real date, and the model happily asked a lead who'd just said "nasceu
 * essa semana" whether she was still pregnant.
 */
final class AiTimeContext
{
    private const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

    private const MONTHS = [1 => 'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

    public static function line(?string $customerPhone = null, ?CarbonInterface $now = null): string
    {
        $now ??= now('America/Sao_Paulo');
        $state = $customerPhone ? BrazilianDdd::stateFor($customerPhone) : null;

        return sprintf(
            'CONTEXTO ATUAL: hoje é %s, %s (%s), ano atual %d, %s no horário de Brasília. País: Brasil%s. Use isso para entender datas relativas ("esse ano", "mês passado", "semana passada", "em julho") - um mês sem ano é a ocorrência mais próxima que faz sentido (saída do emprego já aconteceu, previsão de parto ainda vai acontecer) - e calcular há quanto tempo algo aconteceu ou quanto falta - nunca pergunte o ano se o lead já deu uma referência que permite deduzir.',
            self::WEEKDAYS[$now->dayOfWeek],
            $now->format('d/m/Y'),
            $now->day.' de '.self::MONTHS[$now->month],
            $now->year,
            $now->format('H:i'),
            $state ? " (lead do DDD de {$state['name']} - {$state['uf']})" : '',
        );
    }
}
