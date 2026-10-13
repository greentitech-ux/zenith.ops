#!/usr/bin/env python3
# NoPulso Agente Linux
#
# O AGENTE DO NOC PARA COMPUTADOR LINUX (Zorin, Ubuntu e derivados). Faz pelo
# Linux o que o NOCZenith faz pelo Windows, nas partes que existem nos dois:
#   - bate presença a cada 25 s, com ou sem navegador aberto;
#   - conta a conexão (cabo ou Wi-Fi, nome da rede, sinal, banda, placa) e
#     mede a internet 1x por hora;
#   - conta sistema, reinício, disco, RAM, processador, placa-mãe e uptime;
#   - mede roteador e internet (ping) para a aba Rede do NOC.
#
# O QUE ELE NÃO FAZ, DE PROPÓSITO: não recebe nem executa comando nenhum vindo
# do servidor. A batida vai marcada "semInterface": o servidor não entrega a
# ela mensagem, comando nem captura - quem mostra mensagem é a tela do
# navegador, se estiver aberta.
#
# Este arquivo é gerado pelo servidor (agenteLinux.js) com a unidade, o posto
# e o token DESTA máquina. Instalado em /opt/nopulso-agente/agente.py, só o
# root lê (o token está aqui dentro). Roda como serviço do systemd.
#
#   sudo python3 agente.py --instalar      instala e liga o serviço
#   sudo python3 agente.py --desinstalar   desliga e apaga
#   python3 agente.py --uma-vez            uma batida e uma telemetria (teste)
#
# Compatível com Python 3.6+ (Ubuntu 18.04 em diante).
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSAO = __VERSAO__
BASE = os.environ.get('NOPULSO_AGENTE_BASE') or __BASE__
CODIGO = __CODIGO__
POSTO = __POSTO__
TOKEN = __TOKEN__
CAMINHO_SCRIPT = __CAMINHO_SCRIPT__

PASTA = '/opt/nopulso-agente'
DESTINO = PASTA + '/agente.py'
UNIDADE_SYSTEMD = '/etc/systemd/system/nopulso-agente.service'
CABECALHO = '#!/usr/bin/env python3\n# NoPulso Agente Linux'

INTERVALO_S = 25                 # igual ao NOCZenith e ao app Android (limiar de 90 s no NOC)
TICKS_TELEMETRIA = 24            # ~10 min
TICKS_DIAGNOSTICO_REDE = 12      # ~5 min
INTERVALO_VAZAO_S = 3600         # internet medida 1x por hora
INTERVALO_ATUALIZACAO_S = 6 * 3600
URL_TESTE_VAZAO = 'https://speed.cloudflare.com/__down?bytes=524288'
# chassi de notebook/portátil (SMBIOS): 8-14, 18, 21, 30-32 - mesma lista do NOCZenith
CHASSIS_PORTATIL = {8, 9, 10, 11, 12, 14, 18, 21, 30, 31, 32}


def log(msg):
    print('[nopulso-agente] ' + msg, flush=True)


def ler(caminho, padrao=None):
    try:
        with open(caminho, 'r', encoding='utf-8', errors='replace') as f:
            return f.read().strip()
    except Exception:
        return padrao


def rodar(cmd, timeout=6):
    """Roda um comando LOCAL fixo (nunca vindo do servidor) e devolve a saída."""
    try:
        env = dict(os.environ, LC_ALL='C', LANG='C')
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, env=env)
        return r.stdout.decode('utf-8', errors='replace')
    except Exception:
        return ''


def url_maquina(sufixo):
    q = lambda v: urllib.parse.quote(v, safe='')
    return '%s/api/loja-status/%s/computadores/%s/%s' % (BASE, q(CODIGO), q(POSTO), sufixo)


def postar(url, corpo, timeout=15):
    dados = json.dumps(corpo).encode('utf-8')
    req = urllib.request.Request(url, data=dados, method='POST', headers={
        'Content-Type': 'application/json; charset=utf-8',
        'X-NOC-Token': TOKEN,
        'User-Agent': 'NoPulsoAgenteLinux/%d' % VERSAO,
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8') or '{}')


# ---------------------------------------------------------------- sistema
def sistema():
    nome = None
    texto = ler('/etc/os-release', '') or ''
    m = re.search(r'^PRETTY_NAME="?([^"\n]+)"?', texto, re.M)
    if m:
        nome = m.group(1).strip()
    u = os.uname()
    maquina = u.machine or ''
    if re.search(r'64', maquina):
        arquitetura = '64 bits'
    elif re.search(r'86|arm', maquina):
        arquitetura = '32 bits'
    else:
        arquitetura = None
    return {'nome': nome or 'Linux', 'versao': u.release, 'arquitetura': arquitetura}


def uptime_s():
    t = ler('/proc/uptime', '')
    try:
        return float(t.split()[0])
    except Exception:
        return None


def portatil():
    import glob
    if glob.glob('/sys/class/power_supply/BAT*'):
        return True
    try:
        return int(ler('/sys/class/dmi/id/chassis_type', '0') or 0) in CHASSIS_PORTATIL
    except Exception:
        return False


# ---------------------------------------------------------------- rede
def rota_padrao():
    """(interface, gateway) da rota padrão - é por ela que a internet sai agora."""
    saida = rodar(['ip', 'route', 'show', 'default'])
    m = re.search(r'default via (\S+) dev (\S+)', saida)
    if m:
        return m.group(2), m.group(1)
    m = re.search(r'default dev (\S+)', saida)
    if m:
        return m.group(1), None
    # sem o comando ip: lê a tabela do kernel
    for linha in (ler('/proc/net/route', '') or '').splitlines()[1:]:
        p = linha.split()
        if len(p) > 2 and p[1] == '00000000':
            gw = p[2]
            try:
                gateway = '.'.join(str(int(gw[i:i + 2], 16)) for i in (6, 4, 2, 0))
            except Exception:
                gateway = None
            return p[0], gateway
    return None, None


def eh_wifi(iface):
    return os.path.isdir('/sys/class/net/%s/wireless' % iface) or os.path.exists('/sys/class/net/%s/phy80211' % iface)


def eh_fisica(iface):
    return os.path.exists('/sys/class/net/%s/device' % iface)


def sinal_porcento(dbm):
    """dBm em %, mesma régua do NOCZenith e do app Android: -100 = 0%, -55 = 100%."""
    return max(0, min(100, int((dbm + 100) * 100 / 45)))


def banda_da_frequencia(mhz):
    if 2400 <= mhz <= 2500:
        return '2,4 GHz'
    if 4900 <= mhz <= 5900:
        return '5 GHz'
    if 5925 <= mhz <= 7125:
        return '6 GHz'
    return None


def separar_nmcli(linha):
    # nmcli -t escapa ':' como '\:' dentro dos valores (ex.: SSID com dois-pontos)
    return [p.replace('\\:', ':') for p in re.split(r'(?<!\\):', linha)]


def detalhes_wifi(iface):
    w = {}
    if shutil.which('nmcli'):
        saida = rodar(['nmcli', '-t', '-f', 'ACTIVE,SSID,SIGNAL,CHAN,FREQ,RATE,DEVICE', 'dev', 'wifi', 'list', '--rescan', 'no'])
        for linha in saida.splitlines():
            p = separar_nmcli(linha)
            if len(p) >= 7 and p[0] == 'yes' and (not iface or p[6] == iface):
                if p[1]:
                    w['nome'] = p[1][:80]
                if p[2].isdigit():
                    w['sinalWifi'] = int(p[2])
                if p[3].isdigit():
                    w['canal'] = int(p[3])
                f = re.match(r'(\d+)', p[4])
                if f:
                    w['banda'] = banda_da_frequencia(int(f.group(1)))
                r = re.match(r'(\d+)', p[5])
                if r:
                    w['mbps'] = int(r.group(1))
                break
    if not w and shutil.which('iw') and iface:
        saida = rodar(['iw', 'dev', iface, 'link'])
        m = re.search(r'SSID: (.+)', saida)
        if m:
            w['nome'] = m.group(1).strip()[:80]
        m = re.search(r'signal: (-?\d+) dBm', saida)
        if m:
            w['sinalWifi'] = sinal_porcento(int(m.group(1)))
        m = re.search(r'freq: (\d+)', saida)
        if m:
            w['banda'] = banda_da_frequencia(int(m.group(1)))
        m = re.search(r'tx bitrate: ([\d.]+) MBit', saida)
        if m:
            w['mbps'] = int(float(m.group(1)))
    return {k: v for k, v in w.items() if v is not None}


def medir_link():
    iface, _ = rota_padrao()
    interfaces = [n for n in sorted(os.listdir('/sys/class/net')) if n != 'lo'] if os.path.isdir('/sys/class/net') else []
    cabo = [n for n in interfaces if eh_fisica(n) and not eh_wifi(n)]
    cabo_ativo = [n for n in cabo if ler('/sys/class/net/%s/operstate' % n) == 'up']
    r = {
        'ethernetPresente': bool(cabo),
        'ethernetAtiva': bool(cabo_ativo),
        'ethernetCaida': bool(cabo) and not cabo_ativo,
        'portatil': portatil(),
    }
    if not iface:
        r['tipo'] = 'nenhum'
        return r
    r['adaptador'] = iface
    if eh_wifi(iface):
        r['tipo'] = 'wifi'
        r.update(detalhes_wifi(iface))
    elif eh_fisica(iface):
        r['tipo'] = 'ethernet'
        r['nome'] = iface
        try:
            v = int(ler('/sys/class/net/%s/speed' % iface, '-1'))
            if v > 0:
                r['mbps'] = v
        except Exception:
            pass
    else:
        r['tipo'] = 'outro'
        r['nome'] = iface
    return r


_vazao = {'em': 0, 'valor': None}


def medir_vazao():
    """Internet MEDIDA (512 KB de endpoint público, 1x por hora). Não passa pelo
    NoPulso. Rede que bloqueia o endpoint fica sem número - nunca inventado."""
    agora = time.time()
    if agora - _vazao['em'] < INTERVALO_VAZAO_S:
        return _vazao['valor']
    _vazao['em'] = agora
    _vazao['valor'] = None
    try:
        inicio = time.time()
        with urllib.request.urlopen(URL_TESTE_VAZAO, timeout=8) as resp:
            total = len(resp.read())
        seg = time.time() - inicio
        if total >= 65536 and seg > 0:
            _vazao['valor'] = {'vazaoMbps': round(total * 8 / seg / 1e6, 2), 'vazaoEm': int(time.time() * 1000)}
    except Exception as e:
        log('vazão não medida: %s' % e)
    return _vazao['valor']


def pingar(alvo):
    if not alvo or not shutil.which('ping'):
        return None, None
    saida = rodar(['ping', '-n', '-c', '2', '-W', '2', alvo], timeout=8)
    perda = re.search(r'(\d+(?:\.\d+)?)% packet loss', saida)
    media = re.search(r'= [\d.]+/([\d.]+)/', saida)
    return (int(float(media.group(1))) if media else None), (int(float(perda.group(1))) if perda else None)


def diagnostico_rede(link):
    _, gateway = rota_padrao()
    d = {}
    gms, gperda = pingar(gateway)
    if gms is not None:
        d['gatewayMs'], d['gatewayPerdaPct'] = gms, gperda
    wms, wperda = pingar('8.8.8.8')
    if wms is not None:
        d['wanMs'], d['wanPerdaPct'] = wms, wperda
    if link.get('tipo') == 'wifi':
        d['conexao'] = 'wifi'
        if 'sinalWifi' in link:
            d['sinalWifi'] = link['sinalWifi']
    elif link.get('tipo') == 'ethernet':
        d['conexao'] = 'cabo'
    return d


# ---------------------------------------------------------------- máquina
def medir_disco():
    discos = []
    try:
        dados = json.loads(rodar(['lsblk', '-J', '-b', '-d', '-o', 'NAME,MODEL,SIZE,ROTA,TYPE']) or '{}')
        for d in dados.get('blockdevices', []):
            if d.get('type') != 'disk' or re.match(r'(loop|zram|ram|sr)', d.get('name') or ''):
                continue
            rota = d.get('rota')
            discos.append({
                'modelo': (d.get('model') or d.get('name') or '').strip()[:60],
                'tipo': 'HDD' if rota in (True, '1', 1) else 'SSD',
                'tamanhoGb': round(int(d.get('size') or 0) / 1e9, 1),
                'saude': 'desconhecida',
            })
    except Exception:
        pass
    volumes = []
    try:
        st = os.statvfs('/')
        volumes.append({'letra': '/', 'totalGb': round(st.f_blocks * st.f_frsize / 1e9, 1), 'livreGb': round(st.f_bavail * st.f_frsize / 1e9, 1)})
    except Exception:
        pass
    return {'discos': discos, 'volumes': volumes} if (discos or volumes) else None


def medir_ram():
    info = {}
    for linha in (ler('/proc/meminfo', '') or '').splitlines():
        p = linha.split()
        if len(p) >= 2:
            info[p[0].rstrip(':')] = int(p[1])
    if 'MemTotal' not in info:
        return None
    gb = lambda kb: round(kb / 1048576, 1)
    return {'totalGb': gb(info['MemTotal']), 'livreGb': gb(info.get('MemAvailable', info.get('MemFree', 0)))}


def medir_hardware():
    h = {}
    cpu = ler('/proc/cpuinfo', '') or ''
    m = re.search(r'^model name\s*:\s*(.+)$', cpu, re.M)
    proc = {}
    if m:
        proc['nome'] = re.sub(r'\s+', ' ', m.group(1)).strip()
    nucleos = set()
    fisico = None
    for linha in cpu.splitlines():
        if linha.startswith('physical id'):
            fisico = linha.split(':')[1].strip()
        elif linha.startswith('core id'):
            nucleos.add((fisico, linha.split(':')[1].strip()))
    if nucleos:
        proc['nucleos'] = len(nucleos)
    if os.cpu_count():
        proc['threads'] = os.cpu_count()
    try:
        proc['frequenciaMaxMhz'] = int(int(ler('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq', '0')) / 1000) or None
    except Exception:
        pass
    proc = {k: v for k, v in proc.items() if v}
    if proc:
        h['processador'] = proc
    placa = {'fabricante': ler('/sys/class/dmi/id/board_vendor'), 'modelo': ler('/sys/class/dmi/id/board_name')}
    if any(placa.values()):
        h['placaMae'] = {k: v for k, v in placa.items() if v}
    bios = {'fabricante': ler('/sys/class/dmi/id/bios_vendor'), 'versao': ler('/sys/class/dmi/id/bios_version')}
    if any(bios.values()):
        h['bios'] = {k: v for k, v in bios.items() if v}
    # módulos de memória: só o dmidecode sabe, e só como root
    if os.geteuid() == 0 and shutil.which('dmidecode'):
        mods = []
        for bloco in rodar(['dmidecode', '-t', '17']).split('\n\n'):
            tam = re.search(r'^\s*Size:\s*(\d+)\s*(GB|MB)', bloco, re.M)
            if not tam:
                continue
            cap = int(tam.group(1)) / (1024 if tam.group(2) == 'MB' else 1)
            tipo = re.search(r'^\s*Type:\s*(\S+)', bloco, re.M)
            freq = re.search(r'^\s*Configured (?:Memory|Clock) Speed:\s*(\d+)', bloco, re.M)
            mod = {'capacidadeGb': round(cap, 1), 'tipo': tipo.group(1) if tipo and tipo.group(1) in ('DDR', 'DDR2', 'DDR3', 'DDR4', 'DDR5') else 'Desconhecido'}
            if freq:
                mod['frequenciaMhz'] = int(freq.group(1))
            mods.append(mod)
        if mods:
            h['memoria'] = mods
    return h or None


# ---------------------------------------------------------------- envio
class Estado:
    def __init__(self):
        up = uptime_s()
        self.boot_em = int((time.time() - up) * 1000) if up is not None else None
        self.sistema = sistema()
        self.falhas = 0
        self.ultima_latencia = None
        self.diag = {}
        self.link = None


def bater(est):
    link = dict(est.link or {})
    vz = _vazao['valor']
    if vz:
        link.update(vz)
    rede = {'falhasSeguidas': est.falhas}
    if est.ultima_latencia is not None:
        rede['latenciaMs'] = est.ultima_latencia
    rede.update(est.diag)
    est.diag = {}
    corpo = {
        'unidade': CODIGO, 'posto': POSTO,
        'userAgent': 'NoPulsoAgenteLinux/%d (%s; python)' % (VERSAO, est.sistema.get('nome')),
        # sem tela: o servidor não entrega mensagem/comando/captura a esta batida
        'semInterface': True,
        'agenteLinuxVersao': VERSAO,
        'link': link, 'sistema': est.sistema, 'rede': rede,
    }
    if est.boot_em:
        corpo['bootEm'] = est.boot_em
    inicio = time.time()
    postar(BASE + '/api/loja-status/heartbeat', corpo)
    est.ultima_latencia = int((time.time() - inicio) * 1000)


def enviar_telemetria(est):
    corpo = {'sistema': est.sistema, 'link': est.link}
    for chave, medir in (('disco', medir_disco), ('ram', medir_ram), ('hardware', medir_hardware)):
        try:
            v = medir()
            if v:
                corpo[chave] = v
        except Exception as e:
            log('%s: %s' % (chave, e))
    up = uptime_s()
    if up is not None:
        corpo['uptimeHoras'] = round(up / 3600, 1)
    if est.boot_em:
        corpo['bootEm'] = est.boot_em
    postar(url_maquina('telemetria'), corpo)


def talvez_atualizar():
    """Baixa o script DESTA máquina (o servidor prova o token) e troca se a
    versão for maior. Só aceita arquivo que começa com o cabeçalho certo e
    compila - é a trava contra gravar arquivo quebrado por falha de rede."""
    try:
        req = urllib.request.Request(BASE + CAMINHO_SCRIPT, headers={'X-NOC-Token': TOKEN})
        with urllib.request.urlopen(req, timeout=30) as resp:
            novo = resp.read().decode('utf-8')
        m = re.search(r'^VERSAO = (\d+)$', novo, re.M)
        if not novo.startswith(CABECALHO) or not m or int(m.group(1)) <= VERSAO:
            return False
        compile(novo, DESTINO, 'exec')
        temporario = DESTINO + '.novo'
        with open(temporario, 'w', encoding='utf-8') as f:
            f.write(novo)
        os.chmod(temporario, 0o700)
        os.replace(temporario, DESTINO)
        log('atualizado para a versão %s; reiniciando' % m.group(1))
        return True
    except Exception as e:
        log('atualização não aplicada: %s' % e)
        return False


def laco(uma_vez=False):
    est = Estado()
    tick = 0
    ultima_checagem = time.time()
    log('iniciado - versão %d - %s/%s' % (VERSAO, CODIGO, POSTO))
    while True:
        try:
            if tick % 4 == 0 or est.link is None:
                est.link = medir_link()
                if not uma_vez:
                    medir_vazao()
            if not uma_vez and tick > 0 and tick % TICKS_DIAGNOSTICO_REDE == 0:
                est.diag = diagnostico_rede(est.link)
            bater(est)
            est.falhas = 0
            if tick % TICKS_TELEMETRIA == 0:
                enviar_telemetria(est)
        except Exception as e:
            est.falhas += 1
            log('falha na batida: %s' % e)
        if uma_vez:
            return est.falhas == 0
        if time.time() - ultima_checagem >= INTERVALO_ATUALIZACAO_S:
            ultima_checagem = time.time()
            if talvez_atualizar():
                sys.exit(0)  # o systemd sobe de novo, já com a versão nova
        tick += 1
        time.sleep(INTERVALO_S)


# ---------------------------------------------------------------- instalação
SERVICO = """[Unit]
Description=Agente NoPulso (NOC)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/env python3 %s
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
""" % DESTINO


def instalar():
    if os.geteuid() != 0:
        print('Rode com sudo: sudo python3 %s --instalar' % sys.argv[0])
        return 1
    if not shutil.which('systemctl'):
        print('Este Linux não usa systemd; o agente não sabe se instalar como serviço aqui.')
        return 1
    os.makedirs(PASTA, exist_ok=True)
    os.chmod(PASTA, 0o700)
    origem = os.path.abspath(sys.argv[0])
    if origem != DESTINO:
        shutil.copyfile(origem, DESTINO)
    os.chmod(DESTINO, 0o700)
    with open(UNIDADE_SYSTEMD, 'w') as f:
        f.write(SERVICO)
    subprocess.run(['systemctl', 'daemon-reload'])
    subprocess.run(['systemctl', 'enable', '--now', 'nopulso-agente.service'])
    subprocess.run(['systemctl', 'restart', 'nopulso-agente.service'])
    if origem != DESTINO:
        try:
            os.remove(origem)  # a cópia baixada tem o token: não fica solta
        except Exception:
            pass
    print('Agente NoPulso instalado e ligado. Em até 1 minuto esta máquina aparece no NOC.')
    return 0


def desinstalar():
    if os.geteuid() != 0:
        print('Rode com sudo: sudo python3 %s --desinstalar' % sys.argv[0])
        return 1
    subprocess.run(['systemctl', 'disable', '--now', 'nopulso-agente.service'])
    for caminho in (UNIDADE_SYSTEMD, DESTINO):
        try:
            os.remove(caminho)
        except Exception:
            pass
    subprocess.run(['systemctl', 'daemon-reload'])
    print('Agente NoPulso removido desta máquina.')
    return 0


if __name__ == '__main__':
    arg = sys.argv[1] if len(sys.argv) > 1 else ''
    if arg == '--instalar':
        sys.exit(instalar())
    if arg == '--desinstalar':
        sys.exit(desinstalar())
    if arg == '--uma-vez':
        sys.exit(0 if laco(uma_vez=True) else 1)
    laco()
