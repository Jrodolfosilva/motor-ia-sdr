// Script de embed do simulador. Uso em qualquer página:
//
//   <div id="hub-ia-simulador"></div>
//   <script src="https://SEU-SERVIDOR/embed/hub-ia-simulador.js"></script>
//
// Atributos opcionais no <script>:
//   data-api="https://..."            servidor (padrão: a mesma origem do script)
//   data-target="#outro-id"           onde desenhar (padrão: #hub-ia-simulador; se não existir, logo após o script)
//   data-lead="form" | "frio"         tipo de lead inicial
//   data-lead-switch="false"          esconde a escolha formulário/frio
//   data-title="Teste a nossa IA"     texto acima do celular
//   data-phone="5511999999999"        telefone simulado (DDD define o estado na recepção)
//   data-form='{"Pergunta":"Resposta"}'  respostas do formulário simulado
//
// Renderiza dentro de Shadow DOM: o CSS da página não quebra o simulador e vice-versa.
import { createRoot } from 'react-dom/client';
import css from './styles.css?inline';
import { setApiBase } from './api';
import EmbedSimulator, { type EmbedOptions } from './EmbedSimulator';

const script = document.currentScript as HTMLScriptElement | null;

function readOptions(): { api: string; target: string | null; options: EmbedOptions } {
  const d = script?.dataset ?? {};
  let form: Record<string, string> | undefined;
  try { form = d.form ? JSON.parse(d.form) : undefined; } catch { /* JSON inválido: ignora */ }
  return {
    api: d.api || (script?.src ? new URL(script.src).origin : location.origin),
    target: d.target ?? null,
    options: {
      lead: d.lead === 'frio' ? 'frio' : 'form',
      showLeadSwitch: d.leadSwitch !== 'false',
      title: d.title,
      phone: d.phone,
      form,
    },
  };
}

function mount() {
  const { api, target, options } = readOptions();
  setApiBase(api);

  let el = document.querySelector<HTMLElement>(target ?? '#hub-ia-simulador');
  if (!el) {
    el = document.createElement('div');
    el.id = 'hub-ia-simulador';
    script?.parentNode?.insertBefore(el, script.nextSibling);
    if (!el.isConnected) document.body.appendChild(el);
  }

  // fontes (Inter/Poppins) valem dentro do Shadow DOM quando carregadas no documento
  if (!document.querySelector('link[data-hub-ia-fonts]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@500;600;700&display=swap';
    link.dataset.hubIaFonts = '';
    document.head.appendChild(link);
  }

  const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  // variáveis de :root valem no host do Shadow DOM
  style.textContent = css.replace(/:root/g, ':host');
  shadow.appendChild(style);
  const app = document.createElement('div');
  shadow.appendChild(app);
  createRoot(app).render(<EmbedSimulator options={options} />);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
