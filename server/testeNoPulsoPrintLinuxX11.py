#!/usr/bin/env python3
"""NoPulsoPrint Linux num X11 DE VERDADE: Xvfb + xdotool + xclip.

Sobe um Xvfb próprio (ou usa NOPULSO_PRINT_TEST_DISPLAY), roda o auxiliar
como o agente roda (stdin com a configuração) e faz o que o usuário faria:
atalho → arrasta a seleção → Seta → Enter → "Salvar onde?" → PNG na pasta
AAAA-MM com o nome curto, ampliado a 1400 px, e a MESMA imagem na área de
transferência (image/png, lida pelo xclip, que é o que o Ctrl+V do navegador
pega). Depois Ctrl+C (só copia), Esc (nada), o 📸 do NOC pelo stdin, e o
desligar pelo cadastro.

Executar: /usr/bin/python3 server/testeNoPulsoPrintLinuxX11.py
(o python precisa ter tkinter e Pillow, como na máquina da loja).
"""
import glob
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

RESOLUCAO = '1280x800x24'


def display_livre():
    for n in range(90, 120):
        if not os.path.exists('/tmp/.X%d-lock' % n):
            return ':%d' % n
    raise RuntimeError('Sem display livre pro Xvfb.')


def testar():
    for ferramenta in ('xdotool', 'xclip'):
        if not shutil.which(ferramenta):
            raise RuntimeError('Dependência do teste ausente: ' + ferramenta)
    subprocess.run([sys.executable, '-c', 'import tkinter, PIL.ImageTk, PIL.ImageDraw'], check=True)
    display = os.environ.get('NOPULSO_PRINT_TEST_DISPLAY')
    xvfb = None
    if not display:
        if not shutil.which('Xvfb'):
            raise RuntimeError('Informe NOPULSO_PRINT_TEST_DISPLAY ou instale o Xvfb.')
        display = display_livre()
        xvfb = subprocess.Popen(['Xvfb', display, '-screen', '0', RESOLUCAO, '-nolisten', 'tcp'],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            if os.path.exists('/tmp/.X%s-lock' % display[1:]):
                break
            time.sleep(.1)
        time.sleep(.5)
    worker = Path(__file__).resolve().with_name('noPulsoPrintLinux.py')
    pasta = Path(tempfile.mkdtemp(prefix='nopulso-print-x11-'))
    prints = pasta / 'prints'
    (pasta / 'run').mkdir()
    # ambiente limpo, como o agente sobe o auxiliar (env -i)
    env = {'DISPLAY': display, 'XDG_SESSION_TYPE': 'x11', 'HOME': str(pasta), 'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
           'XDG_RUNTIME_DIR': str(pasta / 'run'), 'LANG': 'pt_BR.UTF-8', 'NOPULSO_PRINT_PASTA': str(prints)}
    log = open(pasta / 'worker.log', 'w+')
    # o auxiliar recusa rodar como root (de propósito). Rodando o teste como
    # root (contêiner), ele é lançado como um usuário comum pelo MESMO caminho
    # que o agente usa na loja: runuser + env -i
    comando = [sys.executable, str(worker)]
    if os.geteuid() == 0:
        import pwd
        try:
            uid = pwd.getpwnam('nopulso-teste').pw_uid
        except KeyError:
            subprocess.run(['useradd', '-M', '-r', '-s', '/usr/sbin/nologin', 'nopulso-teste'], check=True)
            uid = pwd.getpwnam('nopulso-teste').pw_uid
        for raiz, pastas, arquivos_ in os.walk(pasta):
            os.chown(raiz, uid, -1)
        comando = ['runuser', '-u', 'nopulso-teste', '--', '/usr/bin/env', '-i'] + ['%s=%s' % kv for kv in env.items()] + comando
    p = subprocess.Popen(comando, env=env, stdin=subprocess.PIPE, stdout=log, stderr=log)

    def xdo(*args, **kw):
        return subprocess.run(['xdotool', *args], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              check=kw.get('check', True))

    def configurar(cfg):
        p.stdin.write((cfg + '\n').encode())
        p.stdin.flush()
        time.sleep(.5)
        assert p.poll() is None, 'Auxiliar não iniciou: ' + ler_log()

    def ler_log():
        log.flush(); log.seek(0)
        return log.read()

    def janelas(nome):
        r = xdo('search', '--name', nome, check=False)
        return [w for w in r.stdout.decode().split() if w]

    def esperar_janela(nome, existir=True, tempo=8):
        for _ in range(int(tempo * 10)):
            if bool(janelas(nome)) == existir:
                return True
            time.sleep(.1)
        return False

    def selecionar(x1=100, y1=100, x2=400, y2=300):
        xdo('mousemove', str(x1), str(y1)); time.sleep(.15)
        xdo('mousedown', '1'); time.sleep(.15)
        xdo('mousemove', str((x1 + x2) // 2), str((y1 + y2) // 2)); time.sleep(.15)
        xdo('mousemove', str(x2), str(y2)); time.sleep(.15)
        xdo('mouseup', '1'); time.sleep(.3)

    def arquivos():
        return sorted(glob.glob(str(prints / '*' / '*.png')))

    def clipboard_png():
        r = subprocess.run(['xclip', '-selection', 'clipboard', '-t', 'image/png', '-o'], env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
        return r.stdout if r.returncode == 0 else b''

    def tamanho_png(dados):
        assert dados.startswith(b'\x89PNG\r\n\x1a\n'), 'não é PNG'
        return int.from_bytes(dados[16:20], 'big'), int.from_bytes(dados[20:24], 'big')

    def tem_vermelho(caminho):
        from PIL import Image
        with Image.open(caminho) as im:
            im = im.convert('RGB')
            px = im.load()
            for y in range(0, im.height, 3):
                for x in range(0, im.width, 3):
                    r, g, b = px[x, y]
                    if r > 200 and g < 60 and b < 60:
                        return True
        return False

    OVERLAY = '^NoPulsoPrint - sele'   # sem o "ção": o regex do xdotool não casa acento
    DIALOGO = '^NoPulsoPrint$'
    try:
        configurar('{"habilitado":true,"atalho":"ctrl_alt_p","unidade":"Tirol"}')
        assert 'pronto: ctrl_alt_p' in ler_log(), ler_log()

        # 1) atalho → seleção → Seta → Enter → Sim (pasta padrão)
        xdo('key', 'ctrl+alt+p')
        assert esperar_janela(OVERLAY), 'o atalho não abriu a seleção: ' + ler_log()
        selecionar()
        xdo('key', 's'); time.sleep(.2)
        selecionar(150, 150, 300, 250)      # a seta, dentro da área
        xdo('key', 'Return')
        assert esperar_janela(DIALOGO), 'o Enter não perguntou onde salvar: ' + ler_log()
        dialogo = janelas(DIALOGO)[0]
        xdo('windowfocus', '--sync', dialogo); time.sleep(.2)
        xdo('key', '--window', dialogo, 'Return')
        for _ in range(80):
            if arquivos():
                break
            time.sleep(.1)
        salvos = arquivos()
        assert salvos, 'o Enter não salvou o PNG: ' + ler_log()
        nome = os.path.basename(salvos[0]); mes = os.path.basename(os.path.dirname(salvos[0]))
        assert re.match(r'^\d{4}-\d{2}$', mes), 'pasta do mês errada: ' + mes
        assert re.match(r'^\d{2}-\d{2} \d{2}h\d{2} Tirol\.png$', nome), 'nome fora do padrão do Windows: ' + nome
        dados = b''
        for _ in range(50):   # o arquivo aparece antes de o Pillow terminar de gravar
            dados = Path(salvos[0]).read_bytes()
            if dados.endswith(b'IEND\xaeB`\x82'):
                break
            time.sleep(.1)
        w, h = tamanho_png(dados)
        assert max(w, h) == 1400, 'recorte pequeno não foi ampliado a 1400: %dx%d' % (w, h)
        assert tem_vermelho(salvos[0]), 'a seta não foi desenhada no PNG salvo'
        clip = clipboard_png()
        assert clip and tamanho_png(clip) == (w, h), 'a área de transferência não tem a imagem salva (image/png)'
        assert esperar_janela(OVERLAY, existir=False, tempo=3), 'a seleção continuou aberta depois de salvar'
        print('OK: atalho, seleção, seta, Enter → PNG em AAAA-MM com nome curto, 1400 px, e copiado (image/png).')

        # 2) Ctrl+C: só copia (sem arquivo novo), com desfoque marcado
        xdo('key', 'ctrl+alt+p')
        assert esperar_janela(OVERLAY), 'o 2º atalho não abriu a seleção: ' + ler_log()
        selecionar(200, 200, 500, 420)
        xdo('key', 'd'); time.sleep(.2)
        selecionar(220, 220, 320, 300)
        xdo('key', 'ctrl+c')
        assert esperar_janela(OVERLAY, existir=False), 'o Ctrl+C não fechou a seleção'
        time.sleep(.8)
        assert arquivos() == salvos, 'Ctrl+C gravou arquivo (não deveria)'
        clip2 = clipboard_png()
        assert clip2 and clip2 != clip and tamanho_png(clip2)[0] == 1400, 'Ctrl+C não trocou a área de transferência'
        print('OK: Ctrl+C só copia (sem gravar arquivo), ampliado.')

        # 3) Esc: nada muda
        xdo('key', 'ctrl+alt+p')
        assert esperar_janela(OVERLAY)
        selecionar()
        xdo('key', 'Escape')
        assert esperar_janela(OVERLAY, existir=False), 'o Esc não fechou a seleção'
        time.sleep(.5)
        assert arquivos() == salvos and clipboard_png() == clip2, 'Esc salvou ou copiou alguma coisa'
        print('OK: Esc cancela sem salvar nem copiar.')

        # 4) "📸 Capturar agora" do NOC chega pelo stdin, sem teclado
        configurar('{"capturar":true}')
        assert esperar_janela(OVERLAY), 'o gatilho do NOC não abriu a seleção: ' + ler_log()
        xdo('key', 'Escape')
        assert esperar_janela(OVERLAY, existir=False)
        print('OK: o 📸 do NOC abre a seleção sem atalho.')

        # 5) desligado no cadastro: o atalho não faz nada
        configurar('{"habilitado":false}')
        xdo('key', 'ctrl+alt+p')
        time.sleep(1)
        assert not janelas(OVERLAY), 'função desligada ainda abriu a seleção'
        print('OK: desligar impede novas capturas.')
    finally:
        p.stdin.close()
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill(); p.wait()
        saida = ler_log()
        log.close()
        if xvfb:
            xvfb.terminate(); xvfb.wait()
        shutil.rmtree(pasta, ignore_errors=True)
    print(saida)
    assert p.returncode == 0, p.returncode
    print('OK: fim do canal encerra o auxiliar.')


if __name__ == '__main__':
    testar()
