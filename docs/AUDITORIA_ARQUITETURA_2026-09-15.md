# Auditoria de arquitetura — NoPulso

Data: 15/09/2026
Escopo: arquitetura atual, operação, desempenho, segurança de integração e
capacidade de evolução. Esta auditoria não altera dados de produção nem apaga
funcionalidades.

## Resultado executivo

O NoPulso é uma plataforma operacional funcional e ampla. A base de domínio,
as permissões por seção/unidade e o NOCZenith são ativos fortes. O principal
risco de evolução não é tamanho de arquivos: é a concentração de regras e
rotas em poucos arquivos, somada a entregas locais sem validação e sem uma
linha de publicação isolada.

O caminho recomendado é consolidar pontos compartilhados e criar filas de
ações auditáveis antes de acrescentar automações sensíveis, como Cowork,
operações em agregadores e quiosque de saída.

## Retrato atual

| Área | Situação observada | Consequência |
|---|---|---|
| Backend | Node/Express, CommonJS, Firestore e Storage | Adequado ao produto; simples de operar. |
| Rotas | 641 declarações `app.*` centralizadas, em grande parte, no `server/index.js` (~804 KB) | Mudança pequena pode tocar um arquivo de alto risco e gerar conflito. |
| Domínios | ~95 módulos de domínio (`tarefas`, `rh`, `lojaStatus`, `suporteChat` etc.) | Boa separação de dados; deve ser preservada. |
| Frontend | 62 páginas HTML, sem framework/build | Rápido para publicar, mas favorece duplicação de HTML/CSS/JS. |
| Design | `tema.js` está nas 62 páginas | É o ponto correto para tokens, acessibilidade e elementos globais. |
| Navegação | `nav-menu.js` em 49 páginas; chat explícito em 43; notificações em 38 | Há telas fora do padrão e scripts repetidos. |
| Dados | Firestore com cache próprio (`liveCache`) | Correto e necessário; leitura sem cache já causou exaustão de cota. |
| Deploy | Render, deploy manual | Protege a operação, mas exige lote pequeno, teste e checklist. |
| Testes | `testeRotas.js` sobe o servidor com Firestore falso | É uma boa rede de segurança, mas é grande (~1,5 MB) e precisa sempre rodar antes do deploy. |

## Pontos fortes a manter

1. **Permissão no servidor.** `requireAuth`, `requireSection` e
   `requireMaster` são a regra. Ocultar menu não é autorização.
2. **Cache e invalidação.** Toda leitura cara deve continuar passando por
   `createCache()`, e toda escrita precisa invalidar a leitura correspondente.
3. **Separação de domínios.** A lógica de RH, NOC, tarefas, solicitações,
   fornecedores e chat não deve voltar para páginas HTML ou crescer ainda mais
   dentro de `index.js`.
4. **Identificadores históricos.** NOCZenith, chaves de `localStorage` e
   códigos de unidade não podem ser renomeados como parte de limpeza visual.
5. **Deploy manual.** Push não é deploy; só publicar depois de teste e
   conferência da operação.

## Achados e prioridades

### P0 — estabilizar a linha de publicação

O checkout de trabalho está 8 commits atrás da `origin/master` e possui muitas
alterações locais simultâneas. Entre elas estão folha de QR, URLs curtas,
alterações da Estação e mudanças em telas compartilhadas.

**Risco:** um commit genérico ou merge apressado pode misturar mudanças não
relacionadas, sobrescrever trabalho em andamento ou publicar funcionalidade
sem teste.

**Ação:** separar cada entrega em commit pequeno, atualizar contra a master e
rodar `testeRotas.js` antes de qualquer push. Nenhuma limpeza ampla deve ser
publicada junto com mudança operacional.

### P0 — folha de QR ainda não está validada ponta a ponta

`qrcode` foi declarado no `package.json`, mas não aparece no lockfile nem está
instalado no ambiente auditado. O carregamento local falha antes de gerar o
PDF. A rota e o gerador não devem seguir para deploy sem instalação, lockfile
atualizado e teste real do PDF.

**Ação:** instalar a dependência no ambiente de build, atualizar o lockfile,
rodar a suíte e abrir um PDF de teste antes de publicar.

### P1 — modularizar a camada HTTP, sem reescrever o produto

`server/index.js` centraliza centenas de rotas e já é o maior arquivo de
produção. Não é necessário trocar para framework novo. A evolução segura é
mover rotas por domínio, mantendo os módulos e middlewares atuais:

```text
routes/
  noc.js
  estacao.js
  usuarios.js
  central.js
  coworK.js
index.js  → montagem de middleware, autenticação e registro dos routers
```

Começar apenas por novos domínios. Não migrar as 641 rotas de uma vez.

### P1 — tornar a interface consistente e mais leve para operar

O peso total dos arquivos públicos é baixo; o ganho principal é de clareza,
não de apagar telas. Consolidar no `tema.js` e no `nav-menu.js`:

- navegação por perfil e seção, não por lista total de páginas;
- cabeçalho, ações primárias, modais, alertas e filtros com o mesmo padrão;
- carregamento único de chat, notificações e controles globais;
- scripts especializados apenas nas telas que usam gráfico, OCR ou PDF;
- URLs curtas como canônicas, com redirect dos links `.html` legados.

Antes de mudar arquivos compartilhados, executar `varreduraVisual.js` e
entregar a prancha visual.

### P1 — central de ações e Cowork

O Cowork não pode ser um usuário Master genérico. A arquitetura deve usar uma
conta técnica com escopos, fila e auditoria:

```text
Beniboy / Master → pedido de ação → aprovação quando exigida
→ fila por domínio → Cowork autorizado → resultado/evidência → histórico
```

Política inicial:

- consulta e análise de tarefas: leitura, sem aprovação;
- criar usuário, bloquear/desbloquear e alterar permissões: aprovação Master;
- agregadores, compras e qualquer impacto externo: aprovação Master sempre;
- navegador automatizado fica em worker separado das APIs internas;
- tokens exclusivos por worker, rotacionáveis e nunca enviados ao chat.

### P2 — conhecimento do Beniboy

Histórico não deve virar aprendizado automático. Usar casos resolvidos como
base de recuperação, somente após classificação e aprovação:

```text
conversa resolvida → remoção de dados sensíveis → candidato
→ aprovação do responsável → conhecimento versionado → resposta com referência
```

Cada resposta que usar conhecimento deve guardar qual regra/caso foi usado.
Isso permite corrigir uma orientação sem perpetuar erro antigo.

### P2 — Estação: QR de mesa, QR no PDV e saída

São três superfícies distintas e não devem compartilhar credencial do garçom:

1. QR fixo da mesa: identifica a mesa.
2. QR dinâmico do tablet/celular do garçom: identifica o atendimento atual.
3. Quiosque de saída: consulta pública limitada pelo número/token da comanda.

O quiosque só pode informar **pagamento confirmado** ou **procure o caixa**.
Não pode mostrar valor, itens, nome ou permitir marcar pagamento. Para liberar
fisicamente uma catraca/porta, a integração deve ser separada e ter log de
cada liberação.

## Ordem de execução aprovada pela auditoria

1. Estabilizar commits, dependências e testes da folha QR.
2. Publicar URLs curtas isoladamente, após teste de redirect e links públicos.
3. Consolidar navegação e scripts globais, com varredura visual.
4. Criar a Central de Ações com aprovação e trilha de auditoria.
5. Integrar Cowork por fila e escopos; browser worker só para agregadores.
6. Criar base validada de conhecimento do Beniboy.
7. Implementar QR dinâmico e, depois, o quiosque de saída público.

## Critério de conclusão de cada entrega

- Mudança pequena e isolada em commit próprio.
- Teste de rota e teste de interface proporcional ao risco.
- Sem novas leituras Firestore em loop sem cache.
- Permissão checada no servidor.
- Histórico/auditoria para qualquer ação que altere usuário, pagamento ou
  operação externa.
- Push para master somente após validação; deploy continua manual no Render.
