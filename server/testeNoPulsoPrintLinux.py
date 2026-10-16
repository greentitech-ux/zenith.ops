#!/usr/bin/env python3
"""Testes do agente gerado e do editor do NoPulsoPrint, sem systemd/produção
nem credenciais reais.
Executar: /usr/bin/python3 server/testeNoPulsoPrintLinux.py
(os testes do editor precisam de Pillow, como na máquina da loja; sem ela
são pulados e o unittest avisa). O X11 de verdade fica em
testeNoPulsoPrintLinuxX11.py.
"""
import datetime
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch, Mock

PASTA = Path(__file__).resolve().parent
fonte = subprocess.check_output(['node', '-e',
    "process.stdout.write(require('./agenteLinux').montarScriptAgenteLinux({"
    "codigo:'Dominos Teste',posto:'X11',agentToken:'token-nao-deve-chegar-ao-usuario',base:'https://example.invalid'}))"],
    cwd=str(PASTA), text=True)
agente = types.ModuleType('agente_linux_teste')
exec(compile(fonte, 'agente-gerado.py', 'exec'), agente.__dict__)
# o auxiliar X11, carregado sem rodar o main (guarda de __name__)
editor = runpy.run_path(str(PASTA / 'noPulsoPrintLinux.py'))
try:
    from PIL import Image
    TEM_PIL = True
except Exception:
    TEM_PIL = False


def sessao_de_teste():
    usuario = types.SimpleNamespace(pw_uid=1001, pw_name='zorin', pw_dir='/home/zorin')
    return (usuario, {'DISPLAY': ':0', 'XAUTHORITY': '/run/user/1001/gdm/Xauthority'})


class AgenteTeste(unittest.TestCase):
    def test_heartbeat_sem_tela_mas_com_captura_por_agente(self):
        est = types.SimpleNamespace(link={}, falhas=0, ultima_latencia=None, diag={},
                                    boot_em=1, sistema={'nome': 'Zorin'})
        with patch.object(agente, 'postar', return_value={'noPulsoPrint': True}) as postar:
            resposta = agente.bater(est)
        self.assertTrue(resposta['noPulsoPrint'])
        corpo = postar.call_args[0][1]
        self.assertTrue(corpo['semInterface'])
        # é isto que faz o servidor entregar o "📸 Capturar agora" a uma batida sem tela
        self.assertTrue(corpo['capturaPorAgente'])

    def test_auxiliar_sem_token_rodando_como_usuario_com_unidade_e_gatilho(self):
        with tempfile.TemporaryDirectory() as pasta:
            worker = os.path.join(pasta, 'print-x11.py')
            processo = Mock(stdin=io.BytesIO())
            processo.poll.return_value = None
            with patch.object(agente, 'PASTA', pasta), patch.object(agente, 'DESTINO_PRINT', worker), \
                 patch.object(agente.os, 'geteuid', return_value=0), \
                 patch.object(agente.shutil, 'which', return_value='/usr/bin/ferramenta'), \
                 patch.object(agente, 'print_faltando', return_value=[]), \
                 patch.object(agente, 'sessao_print', return_value=sessao_de_teste()), \
                 patch.object(agente.subprocess, 'Popen', return_value=processo) as popen:
                p = agente.PrintLinux()
                p.aplicar({'noPulsoPrint': True, 'noPulsoPrintAtalho': 'ctrl_alt_p',
                           'comandoPendente': {'comando': 'NUNCA EXECUTAR'}})
                p.aplicar({'noPulsoPrint': True, 'noPulsoPrintAtalho': 'ctrl_shift_p'})
                p.aplicar({'noPulsoPrint': True, 'noPulsoPrintAtalho': 'ctrl_shift_p', 'capturarAgora': True})
                comando = popen.call_args[0][0]
                self.assertEqual(comando[:4], ['runuser', '-u', 'zorin', '--'])
                self.assertIn('LANG=pt_BR.UTF-8', comando)  # Sim/Não/Cancelar em português
                self.assertNotIn(agente.TOKEN, ' '.join(comando))
                self.assertNotIn('NUNCA EXECUTAR', ' '.join(comando))
                self.assertNotIn(agente.TOKEN, Path(worker).read_text())
                self.assertEqual(os.stat(worker).st_mode & 0o777, 0o644)
                linhas = [json.loads(l) for l in processo.stdin.getvalue().splitlines()]
                self.assertEqual(linhas, [
                    {'habilitado': True, 'atalho': 'ctrl_alt_p', 'unidade': 'Teste'},
                    {'habilitado': True, 'atalho': 'ctrl_shift_p', 'unidade': 'Teste'},
                    {'capturar': True},
                ])
                p.aplicar({'noPulsoPrint': False})
                self.assertTrue(processo.stdin.closed)
                processo.wait.assert_called_once()
                self.assertIsNone(p.processo)

    def test_sem_sessao_nao_captura_e_nao_roda_como_root(self):
        with patch.object(agente.os, 'geteuid', return_value=0), \
             patch.object(agente.shutil, 'which', return_value='/usr/bin/ferramenta'), \
             patch.object(agente, 'print_faltando', return_value=[]), \
             patch.object(agente, 'sessao_print', return_value=None), \
             patch.object(agente.subprocess, 'Popen') as popen:
            p = agente.PrintLinux()
            p.aplicar({'noPulsoPrint': True})
            popen.assert_not_called()
            self.assertIn('aguardando', p.ultimo_aviso)

    def test_dependencia_ausente_tenta_instalar_uma_vez_e_nao_inicia(self):
        with patch.object(agente.os, 'geteuid', return_value=0), \
             patch.object(agente.shutil, 'which', return_value='/usr/bin/ferramenta'), \
             patch.object(agente, 'print_faltando', return_value=['python3-tk', 'xclip']), \
             patch.object(agente, 'instalar_dependencias_print', return_value=False) as instalar, \
             patch.object(agente.subprocess, 'Popen') as popen:
            p = agente.PrintLinux()
            p.aplicar({'noPulsoPrint': True})
            p.aplicar({'noPulsoPrint': True})
            popen.assert_not_called()
            self.assertIn('python3-tk', p.ultimo_aviso)
            self.assertIn('apt-get install', p.ultimo_aviso)
            # uma tentativa por processo: apt não roda a cada batida
            self.assertEqual(instalar.call_count, 1)

    def test_agente_atualizado_instala_os_pacotes_do_editor_sozinho(self):
        # máquina instalada com a versão anterior (sem Tk/Pillow/xclip): o
        # agente novo instala o que falta e sobe o auxiliar sem ninguém reinstalar
        processo = Mock(stdin=io.BytesIO())
        processo.poll.return_value = None
        with tempfile.TemporaryDirectory() as pasta, \
             patch.object(agente, 'PASTA', pasta), patch.object(agente, 'DESTINO_PRINT', os.path.join(pasta, 'p.py')), \
             patch.object(agente.os, 'geteuid', return_value=0), \
             patch.object(agente.shutil, 'which', return_value='/usr/bin/ferramenta'), \
             patch.object(agente, 'print_faltando', side_effect=[['xclip'], []]), \
             patch.object(agente, 'instalar_dependencias_print', return_value=True) as instalar, \
             patch.object(agente, 'sessao_print', return_value=sessao_de_teste()), \
             patch.object(agente.subprocess, 'Popen', return_value=processo) as popen:
            p = agente.PrintLinux()
            p.aplicar({'noPulsoPrint': True})
            instalar.assert_called_once()
            popen.assert_called_once()
            self.assertTrue(p.dependencias_ok)

    def test_reiniciar_o_agente_procura_atualizacao_na_primeira_volta(self):
        # caso real: deploy no ar, "systemctl restart", e a máquina seguiu 6 h
        # com a versão velha - a checagem contava a partir do reinício
        with patch.object(agente, 'medir_link', return_value={}), patch.object(agente, 'medir_vazao'), \
             patch.object(agente, 'bater', side_effect=[{}, {}, KeyboardInterrupt()]), \
             patch.object(agente, 'enviar_telemetria'), patch.object(agente.PrintLinux, 'aplicar'), \
             patch.object(agente, 'talvez_atualizar', return_value=True) as atualizar, \
             patch.object(agente.time, 'sleep'):
            try:
                agente.laco()
                self.fail('o laço devia ter saído pra reiniciar com a versão nova')
            except SystemExit:
                pass
            except KeyboardInterrupt:
                self.fail('3 batidas e nenhuma atualização aplicada: a checagem ficou pra dali a 6 h')
            atualizar.assert_called_once()

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


class EditorTeste(unittest.TestCase):
    """O desenhista é UM só (prévia e PNG), como no Windows; aqui se prova o
    PNG com imagem sintética: seta com farpas, caixa, mosaico, deslocamento
    do recorte, ampliação a 1400 e os nomes de arquivo."""

    def test_nome_padrao_igual_ao_windows(self):
        quando = datetime.datetime(2026, 10, 9, 18, 42)
        self.assertEqual(editor['nome_padrao']('Tirol', quando), '09-10 18h42 Tirol.png')
        self.assertEqual(editor['nome_padrao']('Dom Tirol!', quando), '09-10 18h42 DomTirol.png')
        self.assertEqual(editor['nome_padrao']('', quando), '09-10 18h42 Unidade.png')

    def test_arquivo_livre_numera_em_vez_de_sobrescrever(self):
        with tempfile.TemporaryDirectory() as pasta:
            nome = '09-10 18h42 Tirol.png'
            self.assertEqual(editor['arquivo_livre'](pasta, nome), os.path.join(pasta, nome))
            Path(pasta, nome).write_bytes(b'x')
            Path(pasta, '09-10 18h42 Tirol (2).png').write_bytes(b'x')
            self.assertEqual(editor['arquivo_livre'](pasta, nome), os.path.join(pasta, '09-10 18h42 Tirol (3).png'))

    def test_modo_da_selecao(self):
        area = (100, 100, 200, 100)
        m = editor['modo_area']
        self.assertEqual(m((100, 100), area), 'nw')
        self.assertEqual(m((300, 200), area), 'se')
        self.assertEqual(m((200, 100), area), 'n')
        self.assertEqual(m((300, 150), area), 'e')
        self.assertEqual(m((200, 150), area), 'mover')
        self.assertEqual(m((50, 50), area), 'novo')
        self.assertEqual(m((50, 50), None), 'novo')

    def test_sem_xclip_nao_copia_e_a_falta_e_apontada(self):
        with patch.object(editor['shutil'], 'which', return_value=None):
            self.assertFalse(editor['copiar_para_area_de_transferencia']('/x.png'))
            self.assertIn('xclip', editor['dependencias_faltando']())

    @unittest.skipUnless(TEM_PIL, 'sem Pillow neste python')
    def test_seta_com_farpas_e_deslocamento_do_recorte(self):
        captura = Image.new('RGB', (400, 300), (0, 0, 0))
        marca = {'tipo': 'seta', 'x1': 60, 'y1': 60, 'x2': 300, 'y2': 200, 'cor': (255, 0, 0), 'grossura': 3}
        recorte = captura.crop((50, 50, 350, 250))
        editor['desenhar_marcas'](recorte, [marca], -50, -50, captura)
        px = recorte.load()
        self.assertEqual(px[180 - 50, 130 - 50], (255, 0, 0))   # meio do traço, já deslocado
        for fx, fy in editor['farpas_da_seta'](300, 200, 300, 200, 3) or []:
            pass
        farpas = editor['farpas_da_seta'](60, 60, 300, 200, 3)
        for fx, fy in farpas:
            mx = (300 + fx) // 2 - 50; my = (200 + fy) // 2 - 50
            self.assertEqual(px[mx, my], (255, 0, 0), 'a farpa da seta não foi desenhada')
        self.assertEqual(captura.getpixel((180, 130)), (0, 0, 0), 'a captura original não pode ser alterada')

    @unittest.skipUnless(TEM_PIL, 'sem Pillow neste python')
    def test_caixa_so_contorno_e_mosaico_mistura_os_pixels(self):
        origem = Image.new('RGB', (200, 100), (255, 0, 0))
        origem.paste((0, 255, 0), (100, 0, 200, 100))   # esquerda vermelha, direita verde
        img = origem.copy()
        marcas = [{'tipo': 'retangulo', 'x1': 10, 'y1': 10, 'x2': 60, 'y2': 60, 'cor': (0, 0, 255), 'grossura': 2},
                  {'tipo': 'desfoque', 'x1': 80, 'y1': 20, 'x2': 120, 'y2': 80}]
        editor['desenhar_marcas'](img, marcas, 0, 0, origem)
        px = img.load()
        self.assertEqual(px[10, 30], (0, 0, 255))
        self.assertEqual(px[35, 35], (255, 0, 0), 'a caixa não pode preencher o interior')
        r, g, b = px[100, 50]
        self.assertTrue(r > 0 and g > 0, 'o mosaico tinha de misturar vermelho e verde na divisa: %r' % ((r, g, b),))
        self.assertEqual(origem.getpixel((100, 50)), (0, 255, 0), 'a origem do mosaico fica intacta (desfazer)')
        self.assertIsNone(editor['mosaico'](origem, 50, 50, 50, 90), 'área sem largura não vira mosaico')

    @unittest.skipUnless(TEM_PIL, 'sem Pillow neste python')
    def test_recorte_pequeno_amplia_a_1400_e_grande_fica(self):
        pequeno = editor['ampliar'](Image.new('RGB', (300, 200)))
        self.assertEqual(pequeno.size, (1400, 933))
        grande = Image.new('RGB', (1600, 900))
        self.assertIs(editor['ampliar'](grande), grande)


if __name__ == '__main__':
    unittest.main()
