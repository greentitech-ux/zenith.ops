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


if __name__ == '__main__':
    unittest.main()
