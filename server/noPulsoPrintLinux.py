#!/usr/bin/env python3
"""NoPulsoPrint X11: processo da sessão, sem token, rede ou privilégios.

O agente envia somente habilitado/atalho pelo stdin. Capturas são selecionadas
pelo usuário e salvas localmente; nenhum comando do servidor é executado.
"""
import ctypes
import ctypes.util
import datetime
import json
import os
import select
import shutil
import subprocess
import sys

ATALHOS = {'ctrl_q': ('q', 4), 'ctrl_alt_p': ('p', 12),
           'ctrl_alt_q': ('q', 12), 'ctrl_shift_p': ('p', 5)}
# Caps Lock e Num Lock não podem impedir o atalho.
LOCKS = (0, 2, 16, 18)


def destino_captura():
    pasta = ''
    if shutil.which('xdg-user-dir'):
        r = subprocess.run(['xdg-user-dir', 'PICTURES'], stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=5)
        pasta = r.stdout.decode('utf-8').strip() if r.returncode == 0 else ''
    if not os.path.isabs(pasta):
        pasta = os.path.join(os.path.expanduser('~'), 'Pictures')
    pasta = os.path.join(pasta, 'NoPulsoPrint')
    os.makedirs(pasta, mode=0o700, exist_ok=True)
    nome = datetime.datetime.now().strftime('NoPulsoPrint-%Y%m%d-%H%M%S-%f.png')
    return os.path.join(pasta, nome)


def main():
    if os.geteuid() == 0:
        raise RuntimeError('A captura deve rodar na sessão do usuário, nunca como root.')
    if os.environ.get('XDG_SESSION_TYPE') != 'x11':
        raise RuntimeError('NoPulsoPrint Linux requer sessão X11.')
    if not shutil.which('gnome-screenshot'):
        raise RuntimeError('Instale gnome-screenshot para habilitar o NoPulsoPrint.')
    os.umask(0o077)
    x = ctypes.CDLL(ctypes.util.find_library('X11') or 'libX11.so.6')
    x.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x.XOpenDisplay.restype = ctypes.c_void_p
    x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x.XDefaultRootWindow.restype = ctypes.c_ulong
    x.XStringToKeysym.argtypes = [ctypes.c_char_p]
    x.XStringToKeysym.restype = ctypes.c_ulong
    x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x.XKeysymToKeycode.restype = ctypes.c_uint
    x.XGrabKey.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_uint,
                          ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_int]
    x.XUngrabKey.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_uint, ctypes.c_ulong]
    x.XPending.argtypes = [ctypes.c_void_p]
    x.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x.XCloseDisplay.argtypes = [ctypes.c_void_p]
    # XEvent tem 24 longs; o primeiro membro é o tipo int.
    evento = (ctypes.c_long * 24)()
    display = x.XOpenDisplay(None)
    if not display:
        raise RuntimeError('Não foi possível acessar a sessão X11.')
    raiz = x.XDefaultRootWindow(display)
    erros = []
    callback_tipo = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
    callback = callback_tipo(lambda _d, _e: erros.append(True) or 0)
    x.XSetErrorHandler.argtypes = [callback_tipo]
    x.XSetErrorHandler(callback)
    ativo = None
    captura = None
    caminho_captura = None
    buffer = b''
    try:
        while True:
            pronto, _, _ = select.select([sys.stdin], [], [], 0.1)
            if pronto:
                parte = os.read(sys.stdin.fileno(), 4096)
                if not parte:
                    break  # agente parou: libera o atalho e termina
                buffer += parte
                if len(buffer) > 8192:
                    raise RuntimeError('Configuração inválida.')
                while b'\n' in buffer:
                    linha, buffer = buffer.split(b'\n', 1)
                    cfg = json.loads(linha.decode('utf-8'))
                    novo = cfg.get('atalho', 'ctrl_q') if cfg.get('habilitado') is True else None
                    novo = novo if novo in ATALHOS else ('ctrl_q' if novo else None)
                    if novo == ativo:
                        continue
                    if ativo:
                        tecla, mod = ATALHOS[ativo]
                        codigo = x.XKeysymToKeycode(display, x.XStringToKeysym(tecla.encode()))
                        for lock in LOCKS:
                            x.XUngrabKey(display, codigo, mod | lock, raiz)
                    ativo = None
                    erros.clear()
                    if novo:
                        tecla, mod = ATALHOS[novo]
                        codigo = x.XKeysymToKeycode(display, x.XStringToKeysym(tecla.encode()))
                        for lock in LOCKS:
                            x.XGrabKey(display, codigo, mod | lock, raiz, False, 1, 1)
                        x.XSync(display, False)
                        if erros:
                            for lock in LOCKS:
                                x.XUngrabKey(display, codigo, mod | lock, raiz)
                            raise RuntimeError('Atalho ocupado. Escolha outro atalho no cadastro NOC.')
                        ativo = novo
                    print('[NoPulsoPrint] ' + ('pronto: ' + ativo if ativo else 'desligado no cadastro'), flush=True)
            if captura and captura.poll() is not None:
                if os.path.isfile(caminho_captura) and os.path.getsize(caminho_captura) > 0:
                    print('[NoPulsoPrint] imagem salva: ' + caminho_captura, flush=True)
                elif captura.returncode != 0:
                    print('[NoPulsoPrint] captura falhou ou foi cancelada (código %s).' % captura.returncode, flush=True)
                else:
                    print('[NoPulsoPrint] seleção cancelada; nenhuma imagem salva.', flush=True)
                captura = None
            while x.XPending(display):
                x.XNextEvent(display, ctypes.byref(evento))
                tipo = ctypes.cast(ctypes.byref(evento), ctypes.POINTER(ctypes.c_int))[0]
                if tipo == 3 and ativo and captura is None:  # KeyRelease: não disputa a tecla pressionada
                    caminho_captura = destino_captura()
                    captura = subprocess.Popen(['gnome-screenshot', '--area', '--file=' + caminho_captura],
                                               stdin=subprocess.DEVNULL)
    finally:
        if captura and captura.poll() is None:
            captura.terminate()
            try:
                captura.wait(timeout=3)
            except subprocess.TimeoutExpired:
                captura.kill()
                captura.wait()
        x.XCloseDisplay(display)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('[NoPulsoPrint] falhou: ' + str(e), flush=True)
        sys.exit(1)
