"""Primeira chave Android: uso manual autorizado, nunca sobrescreve chave existente."""
import base64
import datetime
import getpass
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import urllib.request
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID
from nacl.public import PublicKey, SealedBox

if sys.argv[1:] != ['--confirmar-primeira-chave']:
    raise SystemExit('Exige autorização explícita para criar a primeira chave.')
repo = 'greentitech-ux/zenith.ops'
cred = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n', text=True, capture_output=True, check=True)
campos = dict(linha.split('=', 1) for linha in cred.stdout.splitlines() if '=' in linha)
token = campos.get('password')
if not token:
    raise SystemExit('Credencial GitHub indisponível.')
def api(caminho, dados=None):
    body = json.dumps(dados).encode() if dados is not None else None
    req = urllib.request.Request('https://api.github.com/repos/' + repo + caminho, data=body, method='PUT' if dados is not None else 'GET', headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','Content-Type':'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        payload = r.read()
        return json.loads(payload) if payload else {}
nomes = ['ANDROID_KEYSTORE_BASE64','ANDROID_KEYSTORE_PASSWORD','ANDROID_KEY_ALIAS','ANDROID_KEY_PASSWORD']
existentes = {s['name'] for s in api('/actions/secrets')['secrets']}
if existentes.intersection(nomes):
    raise SystemExit('Já há configuração Android; não sobrescrever a assinatura.')
pasta = Path(__file__).resolve().parents[2] / '.android-assinatura'
if pasta.exists():
    raise SystemExit('Já existe backup local; não gerar outra chave.')
pasta.mkdir()
# Antes de gravar qualquer segredo, limitar o diretório ao usuário atual e SYSTEM.
usuario = subprocess.check_output(['whoami'], text=True).strip()
subprocess.run(['icacls',str(pasta),'/inheritance:r','/grant:r',usuario+':(OI)(CI)F','SYSTEM:(OI)(CI)F'],check=True,capture_output=True)
senha = secrets.token_urlsafe(40)
chave = rsa.generate_private_key(public_exponent=65537, key_size=4096)
nome = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'NoPulso Agente Android'),x509.NameAttribute(NameOID.ORGANIZATION_NAME,'Solutions TI Tech'),x509.NameAttribute(NameOID.COUNTRY_NAME,'BR')])
agora = datetime.datetime.now(datetime.timezone.utc)
certificado = (x509.CertificateBuilder().subject_name(nome).issuer_name(nome).public_key(chave.public_key()).serial_number(x509.random_serial_number()).not_valid_before(agora-datetime.timedelta(days=1)).not_valid_after(agora+datetime.timedelta(days=365*30)).sign(chave,hashes.SHA256()))
arquivo = pkcs12.serialize_key_and_certificates(b'nopulso-agente',chave,certificado,None,serialization.BestAvailableEncryption(senha.encode()))
(pasta/'nopulso-agente.p12').write_bytes(arquivo)
(pasta/'recuperacao.json').write_text(json.dumps({'alias':'nopulso-agente','senha':senha,'fingerprint_sha256':certificado.fingerprint(hashes.SHA256()).hex()},indent=2),encoding='utf-8')
publica = api('/actions/secrets/public-key')
caixa = SealedBox(PublicKey(base64.b64decode(publica['key'])))
valores = [base64.b64encode(arquivo).decode(),senha,'nopulso-agente',senha]
for nomeSecret, valor in zip(nomes,valores):
    cifrado = base64.b64encode(caixa.encrypt(valor.encode())).decode()
    api('/actions/secrets/'+nomeSecret,{'encrypted_value':cifrado,'key_id':publica['key_id']})
print('Chave permanente criada; quatro secrets configurados. Backup com ACL restrita: '+str(pasta))
print('Fingerprint SHA-256 do certificado: '+certificado.fingerprint(hashes.SHA256()).hex())
