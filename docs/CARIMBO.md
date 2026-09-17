# Carimbo do papel de parede

O que a **máquina** escreve por cima da arte genérica: o nome da loja e o
código do computador. Quem desenha é o NOCZenith (PowerShell + System.Drawing),
não o servidor — a arte sai do NoPulso sem nome nenhum e cada máquina se
identifica sozinha.

## Onde mexer

**Todas as medidas ficam em `server/carimboLayout.js`.** É um objeto só, com
os números por orientação. O `vigiaScript.js` lê de lá e injeta no PowerShell
que a máquina roda — não há medida solta dentro do script.

Mexeu no layout? **Suba o `VERSAO_VIGIA`** (`server/vigiaScript.js`). Sem isso
as 52 máquinas continuam com o script antigo e o carimbo novo nunca aparece
(ver CLAUDE.md §4).

## Os dois blocos

São independentes, cada um no seu slot reservado da arte. Até setembro/2026 a
etiqueta vinha empilhada embaixo do nome da loja; hoje não.

### 1. Nome da unidade — régua âmbar + nome da loja

| | Horizontal 1920×1080 | Vertical 1080×1920 |
|---|---|---|
| posição | alinhado à direita, margem 84px | centralizado (x 540) |
| topo | y = 70 | y = 1669 |
| fonte | 50px | 46px |
| gap | 10px | 18px |

Régua 88×3 px, `#e0a33e`, acima do nome. Nome em MAIÚSCULAS, `#ffffff`.

### 2. Etiqueta da máquina — placa branca (`DOM-MC-ATM01`)

Centralizada na largura, dentro do card.

| | Horizontal 1920×1080 | Vertical 1080×1920 |
|---|---|---|
| topo do slot | y = 575 (53,2% da altura) | y = 651 (33,9% da altura) |
| fonte | 46px | 58px |
| raio | 12px | 14px |
| padding | 8 × 26 px | 10 × 34 px |

Fundo `#ffffff`, texto `#0a4f79` em MAIÚSCULAS, letter-spacing 0,14em.

## Escala

Todo número é pixel na resolução de referência. A máquina multiplica por
`$esc = largura_da_arte / largura_de_referência`. Com a proporção preservada
isso equivale a usar porcentagem da altura, então 2560×1440 e 1366×768 saem
certos sem nenhum número novo.

## Três coisas que o desenho pede e o Windows não entrega

Ficam registradas para ninguém "consertar" achando que é bug:

1. **Barlow / Barlow Condensed.** Isto não é navegador — é System.Drawing
   lendo fontes instaladas no Windows, e Barlow não está nas máquinas de loja.
   O `carimboLayout.js` traz uma lista de tentativa (`familias.condensada`) e
   a primeira instalada vence; na prática cai em Segoe UI Semibold ou Arial
   Narrow. Por isso a caixa renderizada não bate exatamente com os ~375×71 px
   do desenho. Para ser fiel de verdade, a fonte teria que ser instalada nas
   52 máquinas (o agente já sabe baixar arquivo do servidor — dá, mas é
   trabalho à parte).
2. **Letter-spacing.** `DrawString` não tem. O script desenha caractere a
   caractere somando o extra, o que custa o kerning — invisível em caixa alta
   com tracking largo.
3. **Sombra `0 10px 26px`.** System.Drawing não borra. Fica o deslocamento
   translúcido, sem desfoque: mais perto do desenho do que não ter sombra.

## Dados

Vila Carrão = CR · Tatuapé = TP · Mooca = MC · São Miguel = SM
Postos: ATM01, ATM02, DISPATCH, MAKELINE, GERENCIA
Código: `DOM-<SIGLA>-<POSTO>`. MAKELINE usa a arte vertical; os demais, a horizontal.

O que entra no carimbo é o **nome cadastrado no NOC**, não o hostname nem o
posto (id interno) — ver `maquinaNomePS` em `vigiaScript.js`.
