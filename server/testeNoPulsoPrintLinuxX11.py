#!/usr/bin/env python3
"""Integração com X11 real e gnome-screenshot.
Use somente um display de teste: NOPULSO_PRINT_TEST_DISPLAY=:97 python3 ...
Requer Xvfb, xdotool, gnome-screenshot e sessão D-Bus (dbus-run-session).
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


def testar():
    display = os.environ.get('NOPULSO_PRINT_TEST_DISPLAY')
    if not display:
        raise RuntimeError('Informe NOPULSO_PRINT_TEST_DISPLAY de um X11 isolado para o teste.')
    for ferramenta in ('xdotool', 'gnome-screenshot'):
        if not shutil.which(ferramenta):
            raise RuntimeError('Dependência do teste ausente: ' + ferramenta)
    with tempfile.TemporaryDirectory(prefix='nopulso-print-x11-') as pasta:
        destino = Path(pasta) / 'captura.png'
        worker = Path(__file__).resolve().with_name('noPulsoPrintLinux.py')
        env = dict(os.environ, DISPLAY=display, XDG_SESSION_TYPE='x11')
        codigo = ('import runpy; m=runpy.run_path(%r); '
                  "m['main'].__globals__['destino_captura']=lambda: %r; m['main']()") % (str(worker), str(destino))
        with open(Path(pasta) / 'worker.log', 'w+') as log:
            p = subprocess.Popen(['python3', '-c', codigo], env=env, stdin=subprocess.PIPE, stdout=log, stderr=log)

            def comando(*args):
                subprocess.run(['xdotool', *args], env=env, check=True)

            def configurar(cfg):
                p.stdin.write((cfg + '\n').encode())
                p.stdin.flush()
                time.sleep(.4)
                assert p.poll() is None, 'Auxiliar não iniciou'

            def selecionar():
                comando('mousemove', '100', '100', 'mousedown', '1', 'mousemove', '300', '250', 'mouseup', '1')

            def conferir_png():
                for _ in range(50):
                    if destino.exists():
                        break
                    time.sleep(.1)
                assert destino.exists(), 'Captura não foi salva'
                assert destino.read_bytes().startswith(b'\x89PNG\r\n\x1a\n'), 'Imagem inválida'

            try:
                configurar('{"habilitado":true,"atalho":"ctrl_alt_p"}')
                comando('key', 'ctrl+alt+p')
                time.sleep(1)
                selecionar()
                conferir_png()
                print('OK: atalho X11, seleção real e PNG salvo.')
                destino.rename(Path(pasta) / 'anterior.png')
                configurar('{"habilitado":true,"atalho":"ctrl_shift_p"}')
                comando('key', 'ctrl+alt+p')
                time.sleep(.4)
                selecionar()
                time.sleep(.4)
                assert not destino.exists(), 'Atalho antigo não foi liberado'
                comando('key', 'ctrl+shift+p')
                time.sleep(1)
                selecionar()
                conferir_png()
                print('OK: alteração de atalho libera o anterior e ativa o novo.')
                destino.rename(Path(pasta) / 'novo.png')
                configurar('{"habilitado":false}')
                comando('key', 'ctrl+shift+p')
                time.sleep(.4)
                selecionar()
                time.sleep(.4)
                assert not destino.exists(), 'Função desligada ainda capturou'
                print('OK: desligar impede novas capturas.')
            finally:
                p.stdin.close()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait()
                log.seek(0)
                print(log.read())
            assert p.returncode == 0, p.returncode
            print('OK: fim do canal encerra o auxiliar.')


if __name__ == '__main__':
    testar()
