# Beniboy — especificação do novo visual

Direção aprovada: **avatar circular com o sinal vital da marca** (turno 6a do
mockup `NoPulso Mockups.dc.html`). As opções B (balão) e C (pastilha), nos
turnos 7a/7b, ficaram como estudo — **não implementar**.

Personalidade: **colega técnico e direto**. Não é mascote fofo, não tem rosto.
O que "vive" é a linha de pulso — a mesma do logotipo NoPulso.

---

## 1. O SVG

Sem rosto, sem olhos: círculo de fundo, núcleo que respira, anel e a polyline
de pulso (mesmos pontos do logotipo, em viewBox 64×64).

```html
<svg width="48" height="48" viewBox="0 0 64 64" fill="none" class="beniboy" aria-hidden="true">
  <circle cx="32" cy="32" r="30" fill="var(--panel)"></circle>
  <circle class="bb-nucleo" cx="32" cy="32" r="22" fill="var(--accent)"></circle>
  <circle class="bb-anel"   cx="32" cy="32" r="30" stroke="var(--accent)" stroke-width="2.5" fill="none"></circle>
  <polyline class="bb-traco"  points="14,34 22,34 27,21 33,45 38,32 50,32" stroke="var(--accent)" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none"></polyline>
  <polyline class="bb-brilho" points="14,34 22,34 27,21 33,45 38,32 50,32" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none"></polyline>
</svg>
```

Trocar `width`/`height` conforme o uso; a geometria não muda.

## 2. O batimento (CSS)

Regra: **a linha nunca desaparece.** A base fica sólida na cor do estado e um
brilho curto corre por cima — igual ao logotipo. O "traçar e apagar" só vale
quando o desenho ao vivo É a informação (a conversa em andamento na demo 8a do
mockup); em cartão de estado, PDF ou PPTX ele deixaria o avatar vazio no frame
congelado.


```css
/* Beniboy — avatar do assistente. A cor vem de currentColor/var(--*) no
   próprio SVG; o CSS aqui só cuida do batimento. */
.beniboy .bb-traco { filter: drop-shadow(0 0 5px currentColor); }   /* base sólida */
.beniboy .bb-brilho{ stroke: #fff; stroke-dasharray: 9 64; opacity: .9;
                     animation: bb-brilho var(--bb-ritmo, 2.6s) linear infinite; }
.beniboy .bb-nucleo{ transform-box: fill-box; transform-origin: center;
                     animation: bb-nucleo var(--bb-ritmo, 2.6s) ease-in-out infinite; }
.beniboy .bb-anel  { animation: bb-anel  var(--bb-ritmo, 2.6s) ease-in-out infinite; }

/* estados: só a cor e o ritmo mudam */
.beniboy.pensando  { --bb-ritmo: 1.7s; }   /* traço/anel/núcleo em var(--accent2) */
.beniboy.alarme    { --bb-ritmo: 1.1s; }   /* var(--bad) */
.beniboy.resolvido { --bb-ritmo: 3.6s; }   /* var(--ok)  */

@keyframes bb-brilho { 0%{stroke-dashoffset:73;} 100%{stroke-dashoffset:-73;} }   /* o caminho tem ~72,6px */
@keyframes bb-nucleo { 0%,100%{transform:scale(.82);opacity:.16;} 42%{transform:scale(1);opacity:.34;} }
@keyframes bb-anel   { 0%,100%{opacity:.62;} 42%{opacity:1;} }

@media (prefers-reduced-motion: reduce) {
  .beniboy .bb-brilho { animation: none; opacity: 0; }
  .beniboy .bb-nucleo, .beniboy .bb-anel { animation: none; }
}
```

Cada elemento animado tem classe própria de propósito: nada de `animation` em
atributo `style` inline, para o tema Claro e o `prefers-reduced-motion`
continuarem funcionando sem exceção.

## 3. Estados — a cor é a mensagem

| Estado | Classe | Cor | Ritmo | Quando |
|---|---|---|---|---|
| Disponível | *(nenhuma)* | `var(--accent)` | 2,6s | esperando a pessoa |
| Verificando | `.pensando` | `var(--accent2)` | 1,7s | consultando vigia, chamado, histórico |
| Chamei um humano | `.alarme` | `var(--bad)` | 1,1s | escalou — inclui a tela de alarme |
| Resolvido | `.resolvido` | `var(--ok)` | 3,6s | conversa encerrada |

A cor entra por `stroke`/`fill` no SVG (ou uma regra por classe); **nunca** hex
cravado — o tema Claro depende de `var(--accent)` / `var(--accent2)`.

Junto do avatar, sempre o rótulo em texto (`disponível`, `verificando…`,
`chamei um humano`, `resolvido`): quem não vê cor ou desligou animação
continua sabendo o estado.

## 4. Tamanhos

| px | Uso |
|---|---|
| 20 | item "Central do Beniboy" no menu ☰ (`nav-menu.js`) |
| 32 | avatar ao lado de cada mensagem do bot |
| 48 | cabeçalho do chat, balãozinho fechado, cabeçalho da Central |
| 64 | widget aberto |
| 112 | tela de alarme (`alerta-beniboy.html`) — traço e anel em `#fff`, fundo `rgba(255,255,255,.10)` |
| 64 em quadrado limão r=14 | ícone de push (`push.js`) — avatar em `#0b0d10` sobre `var(--accent)` |

## 5. Onde aplicar

| Arquivo | O que muda |
|---|---|
| `server/public/suporte-chat.js` | avatar do balãozinho (fechado e aberto) e das mensagens do bot; classe de estado conforme `statusAtendimento` |
| `server/public/atendimento.html` | o 🤖 do topo passa a ser o avatar 64px |
| `server/public/beniboy.html` | cabeçalho da Central e cards das conversas |
| `server/public/nav-menu.js` | ícone do item `nav-beniboy` (hoje 🐝) → avatar 20px |
| `server/public/alerta-beniboy.html` | substitui o 🚨 pelo avatar 112px em branco; mantém sirene, vibração e os botões 🎧 Atender agora / 🔕 Silenciar |
| `server/push.js` | ícone da notificação |
| `server/public/index.html` | **remover** o robô SVG do login (`.login-bot` + keyframes `login-float`, `login-blink`, `login-arml`, `login-armr`). O balão de mensagem fica — é o que o Master personaliza em Tela de Login. O Beniboy não aparece no login. |

## 6. Comportamento — logado ou não

O mesmo assistente, dois contextos (ver `atendimento.html` + `suporte-chat.js`):

- **Sem login:** a página "Fale com o Beniboy" abre a conversa sozinha, sem
  WhatsApp e sem cadastro. Quando o acesso vem do link/QR de uma loja
  (`?unidade=`), o nome dela é resolvido por `/api/meta/unidades-publico` e
  entregue em `window.__zenithLojaContexto` — o bot já começa sabendo a loja.
  Link solto: ele pergunta. Abre ticket e devolve o link de acompanhamento.
- **Logado:** já sabe quem é e de qual unidade, consulta o NOC daquela loja e
  pode desbloquear o próprio acesso.

Demonstração funcional do fluxo e dos ritmos: turno **8a** do mockup.

## 7. Tom de voz

| Sim | Não |
|---|---|
| "Abri o chamado #4821 como crítico e avisei o time de TI. Enquanto isso: tire o cabo de rede e recoloque." | "Oi! 😊 Que pena que isso aconteceu! Vou fazer o meu melhorzinho para te ajudar, tá bom?" |
| "O NOC mostra essa loja indisponível há 41min. Chamei o suporte e registrei o horário da queda." | "Estamos verificando com carinho o seu problema." |
| "Não resolvo isso sozinho. Abri um ticket e chamei alguém do suporte agora." | "Infelizmente não consegui te ajudar 😔" |

Fato, número e próximo passo. Sem emoji na fala do bot (os emojis dos botões
existentes — 🎧 🔕 — permanecem).


---

## 8. Marca viva — brilho correndo no logotipo

O logotipo **nunca** desaparece: a linha fica sólida e um brilho curto corre por
cima dela, a cada 3,2s. (Traçar-e-apagar é só do avatar do Beniboy, onde o
desenho da linha É o estado; no logotipo isso deixaria a marca incompleta na
maior parte do tempo — e num PDF ou PPTX, que congela um frame, ela sairia pela
metade.)

Vale onde a marca aparece parada e grande: **tela de login**, **topo do drawer**
(`nav-menu.js`, `.nmz-marca`) e material de apresentação. Não animar em favicon,
ícone de app, PDF nem e-mail.

```html
<!-- base sólida + brilho por cima, mesma geometria -->
<polyline class="marca-base"   points="2,26 14,26 21,10 29,32 36,20 62,20"
  stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"></polyline>
<polyline class="marca-brilho" points="2,26 14,26 21,10 29,32 36,20 62,20"
  stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"></polyline>
```

```css
.marca-brilho { stroke-dasharray: 12 82; opacity: .85; animation: marca-brilho 3.2s linear infinite; }
@keyframes marca-brilho { 0% { stroke-dashoffset: 94; } 100% { stroke-dashoffset: -94; } }
@media (prefers-reduced-motion: reduce) { .marca-brilho { animation: none; opacity: 0; } }
```

O caminho tem ~93px (viewBox 64×40) — daí o `94` e o traço de `12`.
