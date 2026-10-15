#!/usr/bin/env python3
"""Testes do agente gerado, sem systemd/produção nem credenciais reais.
Executar: python3 server/testeNoPulsoPrintLinux.py
"""
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch, Mock

PASTA = Path(__file__).resolve().parent
fonte = subprocess.check_output(['node', '-e',
    "process.stdout.write(require('./agenteLinux').montarScriptAgenteLinux({"
    "codigo:'TESTE',posto:'X11',agentToken:'token-nao-deve-chegar-ao-usuario',base:'https://example.invalid'}))"],
    cwd=str(PASTA), text=True)
agente = types.ModuleType('agente_linux_teste')
exec(compile(fonte, 'agente-gerado.py', 'exec'), agente.__dict__)


class PrintLinuxTeste(unittest.TestCase):
    def test_heartbeat_preserva_sem_interface_e_devolve_configuracao(self):
        est = types.SimpleNamespace(link={}, falhas=0, ultima_latencia=None, diag={},
                                    boot_em=1, sistema={'nome': 'Zorin'})
        with patch.object(agente, 'postar', return_value={'noPulsoPrint': True}) as postar:
            resposta = agente.bater(est)
        self.assertTrue(resposta['noPulsoPrint'])
        self.assertTrue(postar.call_args[0][1]['semInterface'])

    def test_auxiliar_sem_token_rodando_como_usuario_e_reconfiguracao(self):
        with tempfile.TemporaryDirectory() as pasta:
            worker = os.path.join(pasta, 'print-x11.py')
            usuario = types.SimpleNamespace(pw_uid=1001, pw_name='zorin', pw_dir='/home/zorin')
            processo = Mock(stdin=io.BytesIO())
            processo.poll.return_value = None
            sessao = (usuario, {'DISPLAY': ':0', 'XAUTHORITY': '/run/user/1001/gdm/Xauthority'})
            with patch.object(agente, 'PASTA', pasta), patch.object(agente, 'DESTINO_PRINT', worker), \
                 patch.object(agente.os, 'geteuid', return_value=0), \
                 patch.object(agente.shutil, 'which', return_value='/usr/bin/ferramenta'), \
                 patch.object(agente, 'sessao_print', return_value=sessao), \
                 patch.object(agente.subprocess, 'Popen', return_value=processo) as popen:
                p = agente.PrintLinux()
                p.aplicar({'noPulsoPrint': True, 'noPulsoPrintAtalho': 'ctrl_alt_p',
                           'comandoPendente': {'comando': 'NUNCA EXECUTAR'}})
                p.aplicar({'noPulsoPrint': True, 'noPulsoPrintAtalho': 'ctrl_shift_p'})
                comando = popen.call_args[0][0]
                self.assertEqual(comando[:4], ['runuser', '-u', 'zorin', '--'])
                self.assertNotIn(agente.TOKEN, ' '.join(comando))
                self.assertNotIn('NUNCA EXECUTAR', ' '.join(comando))
                self.assertNotIn(agente.TOKEN, Path(worker).read_text())
                self.assertEqual(os.stat(worker).st_mode & 0o777, 0o644)
                config = [json.loads(l) for l in processo.stdin.getvalue().splitlines()]
                self.assertEqual([c['atalho'] for c in config], ['ctrl_alt_p', 'ctrl_shift_p'])
                p.aplicar({'noPulsoPrint': False})
                self.assertTrue(processo.stdin.closed)
                processo.wait.assert_called_once()
                self.assertIsNone(p.processo)

    def test_sem_sessao_nao_captura_e_nao_roda_como_root(self):
        with patch.object(agente.os, 'geteuid', return_value=0), \
             patch.object(agente.shutil, 'which', return_value='/usr/bin/ferramenta'), \
             patch.object(agente, 'sessao_print', return_value=None), \
             patch.object(agente.subprocess, 'Popen') as popen:
            p = agente.PrintLinux()
            p.aplicar({'noPulsoPrint': True})
            popen.assert_not_called()
            self.assertIn('aguardando', p.ultimo_aviso)

    def test_dependencia_ausente_nao_inicia_captura(self):
        with patch.object(agente.os, 'geteuid', return_value=0), \
             patch.object(agente.shutil, 'which', return_value=None), \
             patch.object(agente.subprocess, 'Popen') as popen:
            p = agente.PrintLinux()
            p.aplicar({'noPulsoPrint': True})
            popen.assert_not_called()
            self.assertIn('gnome-screenshot', p.ultimo_aviso)

    def test_acha_sessao_x11_com_loginctl_que_recusa_lista_com_virgula(self):
        # Caso real (Pop!_OS 24.04, KDE/SDDM): "show-session 1
        # --property=A,B" volta vazio; só "-p A -p B" responde.
        dados = {'1': {'Active': 'yes', 'Remote': 'no', 'Type': 'x11', 'User': '1000',
                       'Name': 'solutions', 'Display': ':0'},
                 '3': {'Active': 'yes', 'Remote': 'yes', 'Type': 'tty', 'User': '1000',
                       'Name': 'solutions', 'Display': ''}}

        def loginctl(cmd, timeout=6):
            if cmd[:2] == ['loginctl', 'list-sessions']:
                return '      1 1000 solutions seat0 1234 user tty7 no -\n      3 1000 solutions -     999 user pts/1 no -\n'
            if cmd[:2] == ['loginctl', 'show-session']:
                props = [cmd[i + 1] for i, a in enumerate(cmd) if a == '-p']
                if any(a.startswith('--property=') and ',' in a for a in cmd):
                    return ''
                return ''.join('%s=%s\n' % (p, dados[cmd[2]][p]) for p in props)
            return ''

        with tempfile.TemporaryDirectory() as raiz:
            xauth = os.path.join(raiz, 'xauth_QvdRZt')
            Path(xauth).write_text('cookie')
            proc = os.path.join(raiz, '4242')
            os.makedirs(proc)
            env = {'XDG_SESSION_TYPE': 'x11', 'XDG_SESSION_ID': '1', 'DISPLAY': ':0',
                   'XAUTHORITY': xauth, 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/1000/bus',
                   'SEGREDO': 'nao-deve-sair'}
            Path(proc, 'environ').write_bytes(b'\0'.join(('%s=%s' % kv).encode() for kv in env.items()))
            Path(proc, 'comm').write_text('dolphin\n')
            stat_real = os.stat
            def stat_falso(c, *a, **k):
                r = stat_real(c, *a, **k)
                if not str(c).startswith(raiz):
                    return r
                # os arquivos de mentira "pertencem" ao uid 1000 da sessão
                return os.stat_result((r.st_mode, r.st_ino, r.st_dev, r.st_nlink, 1000, r.st_gid,
                                       r.st_size, r.st_atime, r.st_mtime, r.st_ctime))
            usuario = types.SimpleNamespace(pw_uid=1000, pw_name='solutions', pw_dir='/home/solutions')
            with patch.object(agente, 'rodar', side_effect=loginctl), \
                 patch.object(agente.glob, 'glob', return_value=[proc]), \
                 patch.object(agente.os, 'stat', side_effect=stat_falso), \
                 patch.object(agente.pwd, 'getpwuid', return_value=usuario):
                achou = agente.sessao_print()
        self.assertIsNotNone(achou, 'a sessão X11 local ativa deveria ser achada')
        self.assertEqual(achou[0].pw_name, 'solutions')
        self.assertEqual(achou[1], {'DISPLAY': ':0', 'XAUTHORITY': xauth,
                                    'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/1000/bus'})


if __name__ == '__main__':
    unittest.main()
