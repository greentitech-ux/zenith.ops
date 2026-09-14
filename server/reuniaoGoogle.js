// reuniaoGoogle.js
// Sala de reunião de verdade, criada na agenda do Google Workspace.
//
// O QUE MUDA. Até aqui "Gerar link automaticamente" devolvia uma sala do
// Jitsi: funciona, mas é uma sala solta - não entra na agenda de ninguém,
// não manda convite e não aparece no Meet da empresa. Com o Workspace
// conectado, a mesma opção cria um EVENTO na agenda com sala do Meet e
// convida os participantes: o compromisso cai no calendário deles.
//
// FALLBACK É REGRA, NÃO ENFEITE. Se o Workspace não estiver configurado, ou
// a chamada falhar (rede, cota, delegação revogada), a reunião é criada do
// mesmo jeito, com a sala do Jitsi que sempre existiu. Reunião sem sala
// nenhuma seria pior que reunião no Jitsi: alguém marca, avisa a equipe e na
// hora não há onde entrar.
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

// e-mail da pessoa do Workspace que a conta de serviço representa. Conta de
// serviço não tem agenda própria: sem representar alguém, o Google recusa
// criar o evento. É o único ajuste obrigatório pra ligar a integração.
function usuarioDono() {
  return String(process.env.GOOGLE_MEET_USUARIO || '').trim();
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

/**
 * Cria o evento com sala do Meet. Lança se não der - quem chama decide o
 * fallback (ver tarefas.js: cai na sala do Jitsi).
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
  const link = data.hangoutLink
    || (data.conferenceData?.entryPoints || []).find((p) => p && p.entryPointType === 'video')?.uri
    || '';
  if (!link) throw new Error('O evento foi criado mas veio sem sala do Meet (confira se o Meet está habilitado para a conta).');
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

module.exports = { criarSala, cancelarSala, configurado, janela, convidadosLimpos, CALENDAR_SCOPE };
