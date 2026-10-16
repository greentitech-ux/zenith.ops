#!/usr/bin/env python3
"""NoPulsoPrint X11: processo da sessão, sem token, rede ou privilégios.

O agente envia somente habilitado/atalho/unidade (e o gatilho "capturar"
do botão 📸 do NOC) pelo stdin. Capturas são selecionadas pelo usuário e
salvas localmente; nenhum comando do servidor é executado.

Dois modos no MESMO arquivo:
  (sem argumento)  laço do atalho: segura a tecla no X11 e abre o editor
  --editar UNIDADE editor: congela a tela, seleção com alças, Seta/Linha/
                   Caixa/Desfocar, Enter salva+copia, Ctrl+C só copia

É o espelho do NoPulsoPrint do NOCZenith (vigiaScript.js, Selecionar-AreaPrint
e Desenhar-Marcas): mesma barra, mesmas cores, mesma cabeça de seta, mesmo
mosaico de 16 px, mesma ampliação a 1400 px, mesma pasta AAAA-MM e mesmo nome
curto "dd-MM HHhmm Unidade.png". Quem usa as duas plataformas não percebe a
troca. Pedido do Master (15/10): "preciso que ele seja completo... seta,
seleção, embaçar, tudo que o NoPulso do Windows já entrega".

Área de transferência: o X11 só mantém o conteúdo enquanto algum processo o
serve. O xclip faz isso (fica vivo em segundo plano até alguém copiar outra
coisa) - é o que deixa o Ctrl+V colar o print no chat do NoPulso.
"""
import ctypes
import ctypes.util
import datetime
import json
import math
import os
import re
import select
import shutil
import subprocess
import sys

ATALHOS = {'ctrl_q': ('q', 4), 'ctrl_alt_p': ('p', 12),
           'ctrl_alt_q': ('q', 12), 'ctrl_shift_p': ('p', 5)}
# Caps Lock e Num Lock não podem impedir o atalho.
LOCKS = (0, 2, 16, 18)

# ---------------------------------------------------------------- aparência
# as mesmas cores do NOCZenith (FromArgb no vigiaScript.js), montadas por
# número pra não cravar hex de marca em lugar nenhum
def _rgb(r, g, b):
    return '#%02x%02x%02x' % (r, g, b)


COR_BARRA = _rgb(18, 22, 28)
COR_ICONE = _rgb(206, 216, 226)
COR_HOVER = _rgb(42, 51, 62)
COR_FIO = _rgb(48, 58, 70)
COR_ACENTO = _rgb(184, 255, 60)
COR_ACENTO_HOVER = _rgb(163, 226, 53)
COR_SOBRE_ACENTO = _rgb(11, 13, 16)
COR_FECHAR_HOVER = _rgb(120, 40, 44)
COR_INSTRUCOES = _rgb(30, 36, 45)
COR_MARCA_PADRAO = (255, 0, 0)
GROSSURA_PADRAO = 3
GROSSURA_MAX = 12
MOSAICO = 16                # bloco do desfoque (igual ao Windows)
LADO_MINIMO = 1400          # recorte menor que isto é ampliado antes de salvar/copiar
OCIOSO_S = 60               # seleção aberta sem ninguém mexer fecha sozinha
ALCA = 9                    # tolerância (px) pra pegar borda/canto da seleção
FONTE = 'DejaVu Sans'
INSTRUCOES = ('  Arraste para selecionar · alças redimensionam · dentro move · '
              'Seta (S) / Linha (L) / Caixa (C) / Desfocar (D) · Ctrl+Z desfaz · '
              'Enter salva e copia · Ctrl+C só copia · Esc cancela  ')


def avisar(texto):
    print('[NoPulsoPrint] ' + texto, flush=True)


# ---------------------------------------------------------------- arquivos
def pasta_base():
    """Imagens/NoPulsoPrint (a pasta de imagens do usuário, no idioma dele).
    NOPULSO_PRINT_PASTA existe só pro teste automático apontar pra uma pasta
    descartável; o agente sobe o auxiliar com ambiente limpo (env -i)."""
    forcada = os.environ.get('NOPULSO_PRINT_PASTA')
    if forcada:
        return forcada
    pasta = ''
    if shutil.which('xdg-user-dir'):
        try:
            r = subprocess.run(['xdg-user-dir', 'PICTURES'], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, timeout=5)
            pasta = r.stdout.decode('utf-8').strip() if r.returncode == 0 else ''
        except (OSError, subprocess.SubprocessError):
            pasta = ''
    if not os.path.isabs(pasta):
        pasta = os.path.join(os.path.expanduser('~'), 'Pictures')
    return os.path.join(pasta, 'NoPulsoPrint')


def pasta_do_mes(agora=None):
    agora = agora or datetime.datetime.now()
    pasta = os.path.join(pasta_base(), agora.strftime('%Y-%m'))
    os.makedirs(pasta, mode=0o700, exist_ok=True)
    return pasta


def nome_padrao(unidade, agora=None):
    """Igual ao Windows: dia, mês, hora e a unidade - "10-09 18h42 Tirol.png".
    A pasta já separa o mês; o mês no nome faz o arquivo continuar se
    explicando depois de sair dela (anexado num chamado, mandado por WhatsApp)."""
    agora = agora or datetime.datetime.now()
    unidade = re.sub(r'[^A-Za-z0-9]+', '', str(unidade or ''))[:12] or 'Unidade'
    return agora.strftime('%d-%m %Hh%M') + ' ' + unidade + '.png'


def arquivo_livre(pasta, nome):
    """O nome só tem minuto: duas capturas seguidas cairiam no mesmo arquivo e
    a primeira sumiria sem aviso. Numera em vez de perder."""
    caminho = os.path.join(pasta, nome)
    sem_ext = nome[:-4] if nome.lower().endswith('.png') else nome
    n = 2
    while os.path.exists(caminho):
        caminho = os.path.join(pasta, '%s (%d).png' % (sem_ext, n))
        n += 1
    return caminho


def arquivo_da_area_de_transferencia():
    """"Copiar" não encosta na pasta de imagens: o PNG vai pra um arquivo
    privado de trabalho, só pra alimentar o xclip."""
    raiz = os.environ.get('XDG_RUNTIME_DIR') or os.path.join(os.path.expanduser('~'), '.cache')
    pasta = os.path.join(raiz, 'nopulso-print')
    os.makedirs(pasta, mode=0o700, exist_ok=True)
    return os.path.join(pasta, 'ultima.png')


def copiar_para_area_de_transferencia(caminho):
    """xclip lê o PNG, se desprende e fica servindo image/png até alguém
    copiar outra coisa. Chrome/Firefox/WhatsApp Web/chat do NoPulso colam
    isso com Ctrl+V. Só como imagem: o X11 não tem a lista de arquivos do
    Windows (CF_HDROP) servida pelo mesmo dono."""
    if not shutil.which('xclip'):
        return False
    try:
        r = subprocess.run(['xclip', '-selection', 'clipboard', '-t', 'image/png', '-i', caminho],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=10)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


# ---------------------------------------------------------------- imagem
def _reamostragem(nome):
    from PIL import Image
    return getattr(getattr(Image, 'Resampling', Image), nome)


def capturar_tela():
    """Congela a tela INTEIRA (todos os monitores) antes de abrir qualquer
    janela: assim a própria máscara nunca aparece no PNG. Pillow fala X11
    direto (xcb); sem isso, gnome-screenshot ou o import do ImageMagick."""
    from PIL import Image, ImageGrab
    try:
        return ImageGrab.grab(xdisplay=os.environ.get('DISPLAY') or ':0').convert('RGB')
    except Exception:
        pass
    arquivo = os.path.join(os.environ.get('XDG_RUNTIME_DIR') or '/tmp', 'nopulso-print-tela-%d.png' % os.getpid())
    for comando in (['gnome-screenshot', '--file=' + arquivo], ['import', '-window', 'root', arquivo]):
        if not shutil.which(comando[0]):
            continue
        try:
            subprocess.run(comando, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=20)
            if os.path.isfile(arquivo) and os.path.getsize(arquivo) > 0:
                with Image.open(arquivo) as im:
                    return im.convert('RGB')
        except (OSError, subprocess.SubprocessError):
            continue
        finally:
            try:
                os.remove(arquivo)
            except OSError:
                pass
    raise RuntimeError('Não consegui fotografar a tela (Pillow sem xcb, sem gnome-screenshot e sem ImageMagick).')


def mosaico(origem, l, t, r, b):
    """Desfoque igual ao Windows: encolhe a área 16x (bilinear) e devolve ao
    tamanho sem suavizar. A origem permanece intacta (permite desfazer)."""
    l = max(0, min(l, r)); t = max(0, min(t, b))
    r = min(origem.width, max(l, r)); b = min(origem.height, max(t, b))
    w = int(r - l); h = int(b - t)
    if w <= 0 or h <= 0:
        return None
    mw = max(1, int(math.ceil(w / float(MOSAICO)))); mh = max(1, int(math.ceil(h / float(MOSAICO))))
    mini = origem.crop((int(l), int(t), int(l) + w, int(t) + h)).resize((mw, mh), _reamostragem('BILINEAR'))
    return mini.resize((w, h), _reamostragem('NEAREST')), int(l), int(t)


def farpas_da_seta(x1, y1, x2, y2, grossura):
    """Cabeça desenhada à mão, como no Windows: duas farpas grossas que
    crescem com a espessura - seta evidente mesmo em traço fino."""
    ang = math.atan2(y2 - y1, x2 - x1)
    farpa = max(16, int(grossura) * 5)
    abertura = 0.5
    return [(int(x2 - farpa * math.cos(ang - abertura)), int(y2 - farpa * math.sin(ang - abertura))),
            (int(x2 - farpa * math.cos(ang + abertura)), int(y2 - farpa * math.sin(ang + abertura)))]


def desenhar_marcas(img, marcas, dx, dy, origem):
    """UM desenhista pros dois destinos (prévia e PNG), como no Windows: as
    marcas vivem em coordenada da tela; o recorte começa em (0,0), daí o
    deslocamento. Cada marca carrega a SUA cor e espessura."""
    from PIL import ImageDraw
    if not marcas:
        return
    d = ImageDraw.Draw(img)

    def traco(a, b, cor, g):
        d.line([a, b], fill=cor, width=g)
        raio = g / 2.0
        for (x, y) in (a, b):  # ponta arredondada (PIL só sabe ponta reta)
            d.ellipse([x - raio, y - raio, x + raio, y + raio], fill=cor)

    for m in marcas:
        if not m:
            continue
        cor = tuple(m.get('cor') or COR_MARCA_PADRAO)
        g = max(1, int(m.get('grossura') or GROSSURA_PADRAO))
        if m['tipo'] == 'desfoque':
            bloco = mosaico(origem, m['x1'], m['y1'], m['x2'], m['y2'])
            if bloco:
                img.paste(bloco[0], (bloco[1] + dx, bloco[2] + dy))
            continue
        x1 = m['x1'] + dx; y1 = m['y1'] + dy; x2 = m['x2'] + dx; y2 = m['y2'] + dy
        if m['tipo'] == 'seta':
            traco((x1, y1), (x2, y2), cor, g)
            for f in farpas_da_seta(x1, y1, x2, y2, g):
                traco((x2, y2), f, cor, g)
        elif m['tipo'] == 'linha':
            traco((x1, y1), (x2, y2), cor, g)
        else:
            rx = min(x1, x2); ry = min(y1, y2); rw = abs(x2 - x1); rh = abs(y2 - y1)
            if rw > 0 and rh > 0:
                d.rectangle([rx, ry, rx + rw, ry + rh], outline=cor, width=g)


def ampliar(img):
    """Recorte miúdo é AMPLIADO antes de salvar/copiar (mesma regra do Windows):
    a leitura por foto do fechamento enxerga a imagem pelo pixel que ela tem.
    1400 fica abaixo do teto em que a API reduz a imagem de volta."""
    lado = max(img.width, img.height)
    if lado <= 0 or lado >= LADO_MINIMO:
        return img
    escala = LADO_MINIMO / float(lado)
    return img.resize((int(round(img.width * escala)), int(round(img.height * escala))),
                      _reamostragem('BICUBIC'))


# ---------------------------------------------------------------- seleção
def normalizar(a, b):
    return (min(a[0], b[0]), min(a[1], b[1]), abs(a[0] - b[0]), abs(a[1] - b[1]))


def modo_area(p, area):
    """Onde o mouse pegou a seleção: canto, borda, dentro (mover) ou fora (nova)."""
    if not area:
        return 'novo'
    x, y, w, h = area
    e = abs(p[0] - x) <= ALCA; d = abs(p[0] - (x + w)) <= ALCA
    c = abs(p[1] - y) <= ALCA; b = abs(p[1] - (y + h)) <= ALCA
    if e and c: return 'nw'
    if d and c: return 'ne'
    if e and b: return 'sw'
    if d and b: return 'se'
    if e: return 'w'
    if d: return 'e'
    if c: return 'n'
    if b: return 's'
    if x <= p[0] <= x + w and y <= p[1] <= y + h:
        return 'mover'
    return 'novo'


CURSORES = {'nw': 'top_left_corner', 'se': 'bottom_right_corner', 'ne': 'top_right_corner',
            'sw': 'bottom_left_corner', 'e': 'right_side', 'w': 'left_side',
            'n': 'top_side', 's': 'bottom_side', 'mover': 'fleur'}


class Editor:
    """Janela opaca com a tela congelada escurecida; a seleção mostra a parte
    clara. Estado todo no objeto (o Windows guarda no Form.Tag pelo mesmo motivo)."""

    def __init__(self, captura):
        import tkinter as tk
        from PIL import ImageEnhance, ImageTk
        self.tk = tk
        self.ImageTk = ImageTk
        self.captura = captura
        self.largura, self.altura = captura.size
        self.escuro = ImageEnhance.Brightness(captura).enhance(0.47)
        self.area = None
        self.inicio = None
        self.modo = None
        self.area_inicio = None
        self.ferramenta = 'selecao'
        self.marcas = []
        self.marca_atual = None
        self.cor = COR_MARCA_PADRAO
        self.grossura = GROSSURA_PADRAO
        self.acao = None
        self.resultado = None
        self.ocioso = 0
        self.expirou = False
        self._refs = []

        root = tk.Tk()
        self.root = root
        root.title('NoPulsoPrint - seleção')  # a pergunta "Salvar onde?" é a janela "NoPulsoPrint"
        root.overrideredirect(True)
        root.geometry('%dx%d+0+0' % (self.largura, self.altura))
        try:
            root.attributes('-topmost', True)
        except tk.TclError:
            pass
        self.canvas = tk.Canvas(root, width=self.largura, height=self.altura, highlightthickness=0,
                                bg='black', cursor='crosshair')
        self.canvas.pack(fill='both', expand=True)
        self.fundo = ImageTk.PhotoImage(self.escuro)
        self.canvas.create_image(0, 0, anchor='nw', image=self.fundo)

        # wraplength: em tela estreita (1280) a linha inteira não cabe e o fim
        # ("Esc cancela") sumia pra fora da tela
        self.instrucoes = tk.Label(root, text=INSTRUCOES, bg=COR_INSTRUCOES, fg='white',
                                   font=(FONTE, 10, 'bold'), justify='left',
                                   wraplength=max(300, self.largura - 28))
        self.instrucoes.place(x=14, y=14)
        self._montar_barra()

        c = self.canvas
        c.bind('<ButtonPress-1>', self._pressionar)
        c.bind('<B1-Motion>', self._arrastar)
        c.bind('<ButtonRelease-1>', self._soltar)
        c.bind('<Motion>', self._mover_mouse)
        root.bind('<Escape>', lambda e: self._fechar(None))
        root.bind('<Control-z>', lambda e: self._desfazer())
        root.bind('<Control-c>', lambda e: self._fechar('copiar'))
        root.bind('<Return>', lambda e: self._fechar('salvar'))
        root.bind('<KP_Enter>', lambda e: self._fechar('salvar'))
        for tecla, qual in (('s', 'seta'), ('l', 'linha'), ('c', 'retangulo'), ('d', 'desfoque')):
            root.bind('<Key-%s>' % tecla, lambda e, q=qual: self._trocar_ferramenta(q))
            root.bind('<Key-%s>' % tecla.upper(), lambda e, q=qual: self._trocar_ferramenta(q))
        for tecla, (ddx, ddy) in (('Left', (-1, 0)), ('Right', (1, 0)), ('Up', (0, -1)), ('Down', (0, 1))):
            root.bind('<%s>' % tecla, lambda e, a=ddx, b=ddy: self._empurrar(a, b, 1))
            root.bind('<Shift-%s>' % tecla, lambda e, a=ddx, b=ddy: self._empurrar(a, b, 10))
        root.bind('<Key>', lambda e: self._acordar())
        root.after(1000, self._tique)
        root.after(50, self._tomar_foco)

    # -- barra de ferramentas (estilo Lightshot, igual à do Windows) --
    def _montar_barra(self):
        tk = self.tk
        barra = tk.Frame(self.root, bg=COR_BARRA, padx=4, pady=4)
        self.barra = barra
        self.botoes_ferramenta = {}

        def botao(texto, comando, fonte=(FONTE, 13), largura=2, dica=None):
            b = tk.Button(barra, text=texto, command=comando, font=fonte, width=largura,
                          bg=COR_BARRA, fg=COR_ICONE, activebackground=COR_HOVER, activeforeground=COR_ICONE,
                          relief='flat', bd=0, highlightthickness=0, cursor='hand2', takefocus=0)
            b.pack(side='left', padx=1)
            return b

        def fio():
            tk.Frame(barra, width=1, height=20, bg=COR_FIO).pack(side='left', padx=5)

        for texto, qual in (('↖', 'seta'), ('╱', 'linha'), ('▭', 'retangulo'), ('▒', 'desfoque')):
            self.botoes_ferramenta[qual] = botao(texto, lambda q=qual: self._trocar_ferramenta(q))
        botao('↶', self._desfazer)
        fio()
        botao('−', lambda: self._mudar_grossura(-1), fonte=(FONTE, 11), largura=2)
        self.rotulo_grossura = tk.Label(barra, text=str(self.grossura), bg=COR_BARRA, fg=COR_ICONE,
                                        font=(FONTE, 9, 'bold'), width=2)
        self.rotulo_grossura.pack(side='left')
        botao('+', lambda: self._mudar_grossura(1), fonte=(FONTE, 11), largura=2)
        self.botao_cor = tk.Button(barra, text='', command=self._escolher_cor, width=2, bg=_rgb(*self.cor),
                                   activebackground=_rgb(*self.cor), relief='flat', bd=0,
                                   highlightthickness=1, highlightbackground=COR_FIO, cursor='hand2', takefocus=0)
        self.botao_cor.pack(side='left', padx=1, ipady=4)
        fio()
        botao('Copiar', lambda: self._fechar('copiar'), fonte=(FONTE, 9, 'bold'), largura=6)
        salvar = botao('Salvar', lambda: self._fechar('salvar'), fonte=(FONTE, 9, 'bold'), largura=6)
        salvar.configure(bg=COR_ACENTO, fg=COR_SOBRE_ACENTO, activebackground=COR_ACENTO_HOVER,
                         activeforeground=COR_SOBRE_ACENTO)
        fio()
        fechar = botao('✕', lambda: self._fechar(None), fonte=(FONTE, 11))
        fechar.configure(activebackground=COR_FECHAR_HOVER)
        self._pintar_ferramenta()

    def _pintar_ferramenta(self):
        for qual, b in self.botoes_ferramenta.items():
            if qual == self.ferramenta:
                b.configure(bg=COR_ACENTO, fg=COR_SOBRE_ACENTO)
            else:
                b.configure(bg=COR_BARRA, fg=COR_ICONE)

    def _posicionar_barra(self):
        """A barra COLA na seleção: abaixo dela; se não couber, por cima."""
        a = self.area
        if not a or a[2] < 3 or a[3] < 3:
            self.barra.place_forget()
            return
        self.barra.update_idletasks()
        bw = self.barra.winfo_reqwidth(); bh = self.barra.winfo_reqheight()
        bx = int(a[0] + (a[2] - bw) / 2)
        bx = max(8, min(bx, self.largura - bw - 8))
        by = a[1] + a[3] + 8
        if by + bh + 8 > self.altura:
            by = a[1] - bh - 8
        by = max(8, by)
        self.barra.place(x=bx, y=by)
        self.barra.lift()

    # -- ferramentas --
    def _trocar_ferramenta(self, qual):
        # clicar na ferramenta ATIVA volta pra seleção (pra reajustar a área)
        self.ferramenta = 'selecao' if self.ferramenta == qual else qual
        self._pintar_ferramenta()
        self.canvas.configure(cursor='crosshair')
        self._acordar()

    def _mudar_grossura(self, delta):
        self.grossura = max(1, min(GROSSURA_MAX, self.grossura + delta))
        self.rotulo_grossura.configure(text=str(self.grossura))
        self._acordar()

    def _escolher_cor(self):
        from tkinter import colorchooser
        self._acordar()
        try:
            self.root.attributes('-topmost', False)
        except self.tk.TclError:
            pass
        try:
            escolha = colorchooser.askcolor(color=_rgb(*self.cor), parent=self.root, title='Cor do traço')
        finally:
            try:
                self.root.attributes('-topmost', True)
            except self.tk.TclError:
                pass
        if escolha and escolha[0]:
            self.cor = tuple(int(round(v)) for v in escolha[0])
            self.botao_cor.configure(bg=_rgb(*self.cor), activebackground=_rgb(*self.cor))
        self._tomar_foco()

    def _desfazer(self):
        if self.marcas:
            self.marcas.pop()
        self._redesenhar()
        self._acordar()

    # -- mouse --
    def _pressionar(self, e):
        self._acordar()
        p = (e.x, e.y)
        if self.ferramenta != 'selecao':
            self.marca_atual = {'tipo': self.ferramenta, 'x1': p[0], 'y1': p[1], 'x2': p[0], 'y2': p[1],
                                'cor': self.cor, 'grossura': self.grossura}
            return
        self.modo = modo_area(p, self.area)
        self.inicio = p
        self.area_inicio = self.area
        if self.modo == 'novo':
            self.area = None
        self.barra.place_forget()
        self._redesenhar()

    def _arrastar(self, e):
        self._acordar()
        p = (max(0, min(e.x, self.largura)), max(0, min(e.y, self.altura)))
        if self.marca_atual:
            self.marca_atual['x2'] = p[0]; self.marca_atual['y2'] = p[1]
            self._redesenhar()
            return
        if not self.inicio:
            return
        dx = p[0] - self.inicio[0]; dy = p[1] - self.inicio[1]
        if self.modo == 'novo':
            self.area = normalizar(self.inicio, p)
        elif self.modo == 'mover' and self.area_inicio:
            x, y, w, h = self.area_inicio
            x = max(0, min(x + dx, self.largura - w)); y = max(0, min(y + dy, self.altura - h))
            self.area = (x, y, w, h)
        elif self.area_inicio:
            l, t, w, h = self.area_inicio; r = l + w; b = t + h
            if 'n' in self.modo: t += dy
            if 's' in self.modo: b += dy
            if 'w' in self.modo: l += dx
            if 'e' in self.modo: r += dx
            self.area = normalizar((l, t), (r, b))
        self._redesenhar()

    def _soltar(self, e):
        self._acordar()
        if self.marca_atual:
            self.marcas.append(self.marca_atual)
            self.marca_atual = None
            self._redesenhar()
            self._posicionar_barra()
            return
        self.inicio = None; self.area_inicio = None; self.modo = None
        self._redesenhar()
        self._posicionar_barra()

    def _mover_mouse(self, e):
        self._acordar()
        if self.ferramenta == 'selecao' and not self.inicio:
            self.canvas.configure(cursor=CURSORES.get(modo_area((e.x, e.y), self.area), 'crosshair'))

    def _empurrar(self, ddx, ddy, passo):
        self._acordar()
        if not self.area:
            return
        x, y, w, h = self.area
        self.area = (x + ddx * passo, y + ddy * passo, w, h)
        self._redesenhar()
        self._posicionar_barra()

    # -- desenho --
    def _redesenhar(self):
        c = self.canvas
        c.delete('sel')
        self._refs = []
        a = self.area
        if a and a[2] > 0 and a[3] > 0:
            x, y, w, h = a
            claro = self.ImageTk.PhotoImage(self.captura.crop((x, y, x + w, y + h)))
            self._refs.append(claro)
            c.create_image(x, y, anchor='nw', image=claro, tags='sel')
            c.create_rectangle(x, y, x + w, y + h, outline='lime', width=2, dash=(6, 4), tags='sel')
            for (px, py) in ((x, y), (x + w, y), (x, y + h), (x + w, y + h),
                             (x + w // 2, y), (x + w // 2, y + h), (x, y + h // 2), (x + w, y + h // 2)):
                c.create_rectangle(px - 4, py - 4, px + 4, py + 4, fill='white', outline='', tags='sel')
            c.create_text(x + 6, y + 6, anchor='nw', text='%d × %d' % (w, h), fill='white',
                          font=(FONTE, 9, 'bold'), tags='sel')
        for m in self.marcas + ([self.marca_atual] if self.marca_atual else []):
            self._desenhar_marca_na_tela(m)

    def _desenhar_marca_na_tela(self, m):
        c = self.canvas
        cor = _rgb(*m['cor']); g = m['grossura']
        if m['tipo'] == 'desfoque':
            bloco = mosaico(self.captura, m['x1'], m['y1'], m['x2'], m['y2'])
            if bloco:
                foto = self.ImageTk.PhotoImage(bloco[0])
                self._refs.append(foto)
                c.create_image(bloco[1], bloco[2], anchor='nw', image=foto, tags='sel')
            return
        x1, y1, x2, y2 = m['x1'], m['y1'], m['x2'], m['y2']
        if m['tipo'] == 'seta':
            c.create_line(x1, y1, x2, y2, fill=cor, width=g, capstyle='round', tags='sel')
            for f in farpas_da_seta(x1, y1, x2, y2, g):
                c.create_line(x2, y2, f[0], f[1], fill=cor, width=g, capstyle='round', tags='sel')
        elif m['tipo'] == 'linha':
            c.create_line(x1, y1, x2, y2, fill=cor, width=g, capstyle='round', tags='sel')
        else:
            if abs(x2 - x1) > 0 and abs(y2 - y1) > 0:
                c.create_rectangle(min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2),
                                   outline=cor, width=g, tags='sel')

    # -- ciclo de vida --
    def _tomar_foco(self):
        try:
            self.root.lift()
            self.root.focus_force()
            self.canvas.focus_set()
            self.root.grab_set_global()
        except self.tk.TclError:
            pass

    def _acordar(self):
        self.ocioso = 0

    def _tique(self):
        # Se a janela abrir onde ninguém vê (monitor desligado, sessão remota),
        # ela se fecha sozinha em 60 s e devolve o atalho - igual ao Windows.
        if self.acao is not None or self.resultado is not None:
            return
        self.ocioso += 1
        if self.ocioso >= OCIOSO_S:
            self.expirou = True
            self._fechar(None)
            return
        self.root.after(1000, self._tique)

    def _fechar(self, acao):
        if acao and not (self.area and self.area[2] >= 3 and self.area[3] >= 3):
            return  # sem seleção não há o que salvar/copiar
        self.acao = acao
        self.resultado = self.area if acao else None
        try:
            self.root.grab_release()
        except self.tk.TclError:
            pass
        self.root.quit()

    def rodar(self):
        self.root.mainloop()
        try:
            self.root.withdraw()
        except self.tk.TclError:
            pass
        if not self.acao:
            return None
        return {'area': self.resultado, 'acao': self.acao, 'marcas': list(self.marcas)}


def perguntar_onde_salvar(root, pasta, nome):
    """Pergunta UMA vez, como no Windows: pasta padrão, escolher outro lugar,
    ou não salvar (a captura já vai pra área de transferência de todo jeito)."""
    from tkinter import filedialog, messagebox
    try:
        root.attributes('-topmost', True)
    except Exception:
        pass
    escolha = messagebox.askyesnocancel(
        'NoPulsoPrint',
        'Salvar onde?\n\nSim = pasta padrão (Imagens/NoPulsoPrint)\nNão = escolher outro local',
        parent=root)
    if escolha is True:
        return arquivo_livre(pasta, nome)
    if escolha is False:
        caminho = filedialog.asksaveasfilename(parent=root, title='Salvar captura NoPulsoPrint',
                                               initialdir=pasta, initialfile=nome, defaultextension='.png',
                                               filetypes=[('Imagem PNG', '*.png')])
        return caminho or None
    return None


def editar(unidade):
    """Fluxo inteiro de UMA captura. Devolve 0 se terminou (salvou/copiou ou
    o usuário cancelou), 1 se falhou."""
    os.environ.setdefault('LANG', 'pt_BR.UTF-8')  # botões Sim/Não/Cancelar do Tk em português
    captura = capturar_tela()
    editor = Editor(captura)
    escolha = editor.rodar()
    if editor.expirou:
        avisar('a seleção ficou %ds sem interação e foi fechada sozinha - se você apertou o atalho e não viu nada, a janela abriu fora da sua vista.' % OCIOSO_S)
    if not escolha:
        avisar('seleção cancelada; nenhuma imagem salva.')
        editor.root.destroy()
        return 0
    x, y, w, h = escolha['area']
    recorte = captura.crop((x, y, x + w, y + h))
    desenhar_marcas(recorte, escolha['marcas'], -x, -y, captura)
    recorte = ampliar(recorte)
    arquivo = None
    if escolha['acao'] == 'salvar':
        arquivo = perguntar_onde_salvar(editor.root, pasta_do_mes(), nome_padrao(unidade))
        if arquivo:
            recorte.save(arquivo, format='PNG')
    editor.root.destroy()
    fonte_clip = arquivo
    if not fonte_clip:
        fonte_clip = arquivo_da_area_de_transferencia()
        recorte.save(fonte_clip, format='PNG')
    copiou = copiar_para_area_de_transferencia(fonte_clip)
    if arquivo:
        avisar('captura salva em %s%s' % (arquivo, ' e copiada pra área de transferência' if copiou else ''))
    elif copiou:
        avisar('captura copiada pra área de transferência (sem gravar arquivo)')
    else:
        avisar('não consegui copiar pra área de transferência (xclip ausente ou falhou)')
    return 0


# ---------------------------------------------------------------- atalho
def dependencias_faltando():
    faltam = []
    try:
        import tkinter  # noqa: F401
    except Exception:
        faltam.append('python3-tk')
    try:
        from PIL import Image, ImageTk, ImageDraw  # noqa: F401
    except Exception:
        faltam.append('python3-pil/python3-pil.imagetk')
    if not shutil.which('xclip'):
        faltam.append('xclip')
    return faltam


def laco_do_atalho():
    if os.geteuid() == 0:
        raise RuntimeError('A captura deve rodar na sessão do usuário, nunca como root.')
    if os.environ.get('XDG_SESSION_TYPE') != 'x11':
        raise RuntimeError('NoPulsoPrint Linux requer sessão X11.')
    faltam = dependencias_faltando()
    if faltam:
        raise RuntimeError('Instale %s para habilitar o NoPulsoPrint.' % ', '.join(faltam))
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
    unidade = ''
    editor = None
    buffer = b''

    def abrir_editor():
        return subprocess.Popen([sys.executable, os.path.abspath(__file__), '--editar', unidade],
                                stdin=subprocess.DEVNULL)

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
                    if isinstance(cfg.get('unidade'), str):
                        unidade = re.sub(r'[^A-Za-z0-9]+', '', cfg['unidade'])[:12]
                    # "📸 Capturar agora" do NOC: abre sem teclado, mesmo com o
                    # cadastro desligado - é o Master pedindo, e prova que a
                    # janela abre nessa tela quando o atalho não chega
                    if cfg.get('capturar') is True:
                        if editor is None:
                            avisar('captura pedida pelo NOC - abrindo a seleção.')
                            editor = abrir_editor()
                        continue
                    if 'habilitado' not in cfg and 'atalho' not in cfg:
                        continue
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
                    avisar('pronto: ' + ativo if ativo else 'desligado no cadastro')
            if editor and editor.poll() is not None:
                if editor.returncode != 0:
                    avisar('o editor terminou com erro (código %s).' % editor.returncode)
                editor = None
            while x.XPending(display):
                x.XNextEvent(display, ctypes.byref(evento))
                tipo = ctypes.cast(ctypes.byref(evento), ctypes.POINTER(ctypes.c_int))[0]
                if tipo == 3 and ativo and editor is None:  # KeyRelease: não disputa a tecla pressionada
                    avisar(ativo + ' detectado - abrindo a seleção.')
                    editor = abrir_editor()
    finally:
        if editor and editor.poll() is None:
            editor.terminate()
            try:
                editor.wait(timeout=3)
            except subprocess.TimeoutExpired:
                editor.kill()
                editor.wait()
        x.XCloseDisplay(display)


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == '--editar':
        return editar(sys.argv[2] if len(sys.argv) > 2 else '')
    laco_do_atalho()
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main() or 0)
    except Exception as e:
        avisar('falhou: ' + str(e))
        sys.exit(1)
