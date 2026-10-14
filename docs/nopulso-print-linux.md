# NoPulsoPrint no Linux X11

O agente Linux v2 recebe habilitado/atalho no heartbeat autenticado já
existente. O serviço continua só enviando presença/telemetria (`semInterface`)
e não consome mensagens nem pedidos de captura remota. O NoPulsoPrint responde
ao atalho local do usuário e salva a área selecionada em `Imagens/NoPulsoPrint`.
Não envia imagens ao servidor.

## Instalação no Zorin/Ubuntu

Depois de publicar esta versão no servidor, copie novamente o comando
**Instalar no Linux** na ficha desta máquina no NOC e execute no terminal
do Zorin. O instalador instala `gnome-screenshot` pelo apt, se necessário,
e reinicia `nopulso-agente.service`. Habilite NoPulsoPrint e escolha o atalho
na mesma ficha. A configuração é aplicada na próxima batida (~25 segundos).

A sessão deve ser local, ativa e X11. O auxiliar é lançado como seu usuário
(por exemplo, `zorin`) com DISPLAY/XAUTHORITY da sessão; jamais captura como
root. O arquivo `/opt/nopulso-agente/agente.py` permanece 0700 e guarda o token.
O auxiliar `/opt/nopulso-agente/print-x11.py` é público e não contém token.
O diretório é 0755, gravável somente pelo root. As configurações chegam ao
auxiliar por pipe, sem credencial nem comando remoto.

O atalho padrão é Ctrl+Q; os outros são Ctrl+Alt+P, Ctrl+Alt+Q e Ctrl+Shift+P.
Use um dos alternativos se o atalho já pertencer a outro aplicativo. Se um
atalho global estiver ocupado, a captura falha explicitamente e registra
o motivo, em vez de interferir com o atalho existente. Esc cancela a seleção.

## Atualização e diagnóstico

Agentes v1 procuram atualizações a cada seis horas. Ao atualizar, podem
precisar de `gnome-screenshot`; reinstalar pelo comando do NOC instala essa
dependência imediatamente. O NoPulsoPrint depende da sessão gráfica aberta.
Wayland não é suportado nesta versão. Desligar a opção no cadastro, encerrar
a sessão ou parar o agente encerra o auxiliar e libera o atalho. Uma falha
de heartbeat também interrompe o auxiliar até recuperar a configuração.

No terminal da máquina:

```bash
echo "$XDG_SESSION_TYPE"
command -v gnome-screenshot
systemctl is-active nopulso-agente.service
sudo journalctl -u nopulso-agente.service -n 80 --no-pager
```

Não compartilhe o arquivo `agente.py`: ele contém o token da máquina.

## Testes

Sem produção/systemd, validando o script gerado e o controle do auxiliar:

```bash
python3 server/testeNoPulsoPrintLinux.py
```

Para validar captura, troca de atalho e desligamento, em um X11 **isolado**,
com Xvfb, xdotool e gnome-screenshot instalados:

```bash
Xvfb :97 -screen 0 1024x768x24 -nolisten tcp -ac
# Em outro terminal:
NOPULSO_PRINT_TEST_DISPLAY=:97 dbus-run-session -- python3 server/testeNoPulsoPrintLinuxX11.py
```

A suíte principal (`cd server && npm run teste`) também executa o agente
gerado contra o servidor e verifica que ele preserva a identificação da aba
e não consome mensagens. Há falhas preexistentes na suíte; compare o resultado
com a referência anterior antes de atribuí-las a esta alteração.
