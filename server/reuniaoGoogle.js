// reuniaoGoogle.js
// Sala de reunião de verdade, criada na agenda do Google Workspace.
//
// O QUE MUDA. Até aqui "Gerar link automaticamente" devolvia uma sala do
// Jitsi: funciona, mas é uma sala solta - não entra na agenda de ninguém,
// não manda convite e não aparece no Meet da empresa. Com o Workspace
// conectado, a mesma opção cria um EVENTO na agenda com sala do Meet e
// convida os participantes: o compromisso cai no calendário deles.
//
// A SALA É SEMPRE CORPORATIVA. Quando Calendar/Meet não responder, a criação
// falha antes de gravar. Assim, todo link automático do NoPulso nasce no Meet
// e vem acompanhado do evento na agenda da empresa.
//
// O QUE PRECISA SER FEITO NO WORKSPACE: docs/GOOGLE_WORKSPACE.md.
'use strict';

const crypto = require('crypto');
const googleAuth = require('./googleAuth');

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const API = 'https://www.googleapis.com/calendar/v3';
// as lojas e o escritório estão todos no mesmo fuso; a hora que a pessoa
// digita na tela é hora de Brasília, e é assim que ela tem que chegar na
// agenda de quem for convidado
const FUSO = process.env.GOOGLE_MEET_FUSO || 'America/Sao_Paulo';
const MAX_CONVIDADOS = 40;
const USUARIO_DONO_PADRAO = 'admin@solutionstitech.com';

// e-mail da pessoa do Workspace que a conta de serviço representa. Conta de
// serviço não tem agenda própria: sem representar alguém, o Google recusa
// criar o evento. É o único ajuste obrigatório pra ligar a integração.
function usuarioDono() {
  // Esta conta corporativa não é segredo. Deixá-la como padrão evita que uma
  // sincronização de Blueprint precise tocar no ambiente do Render (onde
  // ficam as credenciais sensíveis do Firebase). A variável continua podendo
  // sobrescrever o dono em outro ambiente.
  return String(process.env.GOOGLE_MEET_USUARIO || USUARIO_DONO_PADRAO).trim();
}

// a agenda onde o evento nasce. Por padrão a do próprio usuário representado
// ("primary"); dá pra apontar pra uma agenda compartilhada da empresa.
function agenda() {
  return String(process.env.GOOGLE_MEET_AGENDA || 'primary').trim() || 'primary';
}

// Está ligado? A tela pergunta isso antes de prometer sala do Meet.
function configurado() {
  return !!(googleAuth.configurado() && usuarioDono());
}

// "2026-09-14" + "16:00" + 60min -> { inicio, fim } em ISO com fuso nomeado.
// Somar minuto na mão (e não via Date) evita que o horário de verão de um
// fuso qualquer do servidor mova a reunião uma hora.
function janela(dia, hora, duracaoMin) {
  const [h, m] = String(hora || '').split(':').map((x) => parseInt(x, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dia || '')) || !Number.isFinite(h) || !Number.isFinite(m)) {
    throw new Error('Reunião sem dia ou hora não vira evento na agenda.');
  }
  const minutos = h * 60 + m;
  const fim = minutos + Math.max(5, Number(duracaoMin) || 60);
  const doDia = (base) => {
    // passou da meia-noite: empurra o dia junto, senão o evento termina antes
    // de começar e o Google recusa
    const diasAdiante = Math.floor(base / 1440);
    const resto = ((base % 1440) + 1440) % 1440;
    const d = new Date(`${dia}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + diasAdiante);
    const hh = String(Math.floor(resto / 60)).padStart(2, '0');
    const mm = String(resto % 60).padStart(2, '0');
    return `${d.toISOString().slice(0, 10)}T${hh}:${mm}:00`;
  };
  return { inicio: doDia(minutos), fim: doDia(fim) };
}

// e-mails válidos e sem repetição, e sem o próprio dono (o Google recusa o
// organizador como convidado)
function convidadosLimpos(emails) {
  const dono = usuarioDono().toLowerCase();
  const vistos = new Set();
  return (emails || [])
    .map((e) => String(e || '').trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e !== dono && !vistos.has(e) && vistos.add(e))
    .slice(0, MAX_CONVIDADOS)
    .map((email) => ({ email }));
}

function linkDoMeet(evento) {
  return evento?.hangoutLink
    || (evento?.conferenceData?.entryPoints || []).find((p) => p && p.entryPointType === 'video')?.uri
    || '';
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A criação de conferenceData pode ser assíncrona: o POST devolve o evento
// antes de o Meet entregar o entry point. Consultamos o mesmo evento por um
// curto período para nunca gravar uma reunião sem o link que a pessoa espera.
async function esperarLinkDoMeet(evento, token) {
  let atual = evento;
  for (let tentativa = 0; tentativa < 6; tentativa++) {
    const link = linkDoMeet(atual);
    if (link) return link;
    if (!atual?.id) break;
    await esperar(350);
    const url = `${API}/calendars/${encodeURIComponent(agenda())}/events/${encodeURIComponent(atual.id)}?conferenceDataVersion=1`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) break;
    atual = await resp.json().catch(() => atual);
  }
  return '';
}

/**
 * Cria o evento com sala do Meet. Lança se não der: a reunião não é gravada
 * sem uma sala corporativa válida.
 * @returns {{link:string, eventoId:string, agenda:string, convidados:number}}
 */
async function criarSala({ titulo, descricao, dia, hora, duracaoMin, convidados = [] }) {
  if (!configurado()) throw new Error('Workspace não conectado (falta GOOGLE_MEET_USUARIO).');
  const dono = usuarioDono();
  const token = await googleAuth.tokenDeAcesso(CALENDAR_SCOPE, { comoUsuario: dono, ondeHabilitar: 'Google Calendar' });
  const { inicio, fim } = janela(dia, hora, duracaoMin);
  const pessoas = convidadosLimpos(convidados);

  const corpo = {
    summary: String(titulo || 'Reunião').slice(0, 200),
    description: String(descricao || '').slice(0, 2000) || undefined,
    start: { dateTime: inicio, timeZone: FUSO },
    end: { dateTime: fim, timeZone: FUSO },
    attendees: pessoas.length ? pessoas : undefined,
    // requestId identifica ESTE pedido de sala: se a resposta se perder na
    // rede e o pedido for repetido, o Google devolve a mesma sala em vez de
    // criar uma segunda
    conferenceData: {
      createRequest: {
        requestId: crypto.randomBytes(12).toString('hex'),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
  };

  const url = `${API}/calendars/${encodeURIComponent(agenda())}/events`
    + '?conferenceDataVersion=1&sendUpdates=all';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Google Agenda recusou criar a reunião: ${data.error?.message || resp.status}.`);
  }
  const link = await esperarLinkDoMeet(data, token);
  if (!link) {
    // Não deixa evento órfão quando a política do domínio não permite Meet.
    if (data.id) {
      const apagar = `${API}/calendars/${encodeURIComponent(agenda())}/events/${encodeURIComponent(data.id)}?sendUpdates=all`;
      await fetch(apagar, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    }
    throw new Error('O Google criou o evento, mas não entregou a sala do Meet. Confira se o Google Meet está habilitado para a conta e tente novamente.');
  }
  return { link, eventoId: data.id || '', agenda: agenda(), convidados: pessoas.length };
}

/**
 * Apaga o evento da agenda. Usado quando a reunião é cancelada no NoPulso:
 * sem isso o compromisso fica de pé na agenda de todo mundo, e alguém entra
 * numa sala que ninguém mais vai usar. Nunca lança - cancelar a reunião no
 * NoPulso não pode falhar por causa da agenda.
 */
async function cancelarSala(eventoId) {
  if (!eventoId || !configurado()) return false;
  try {
    const token = await googleAuth.tokenDeAcesso(CALENDAR_SCOPE, { comoUsuario: usuarioDono(), ondeHabilitar: 'Google Calendar' });
    const url = `${API}/calendars/${encodeURIComponent(agenda())}/events/${encodeURIComponent(eventoId)}?sendUpdates=all`;
    const resp = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    return resp.ok || resp.status === 410; // 410 = já tinha sido apagado
  } catch (e) {
    return false;
  }
}

/**
 * Move o evento pra outro dia/hora (reagendamento). Diferente do cancelar,
 * AQUI falhar tem de parar tudo: reagendar no NoPulso e deixar a agenda de
 * todo mundo no horario velho mandaria gente pra uma sala vazia. O convite
 * atualizado sai pra todos (sendUpdates=all) - e a mesma sala do Meet.
 */
async function moverSala(eventoId, { dia, hora, duracaoMin }) {
  if (!eventoId) return false;
  if (!configurado()) throw new Error('Google Meet não está conectado: não dá pra mover o evento na agenda de quem participa.');
  const token = await googleAuth.tokenDeAcesso(CALENDAR_SCOPE, { comoUsuario: usuarioDono(), ondeHabilitar: 'Google Calendar' });
  const { inicio, fim } = janela(dia, hora, duracaoMin);
  const url = `${API}/calendars/${encodeURIComponent(agenda())}/events/${encodeURIComponent(eventoId)}?sendUpdates=all`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: { dateTime: inicio, timeZone: FUSO }, end: { dateTime: fim, timeZone: FUSO } }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(`Google Agenda recusou mover a reunião: ${data.error?.message || resp.status}. Nada foi alterado.`);
  }
  return true;
}

module.exports = { criarSala, cancelarSala, moverSala, configurado, janela, convidadosLimpos, linkDoMeet, esperarLinkDoMeet, CALENDAR_SCOPE, USUARIO_DONO_PADRAO };
