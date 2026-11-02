'use strict';

/**
 * Cliente SMTP mínimo, sem dependências externas.
 * Suporta SSL direto (porta 465), STARTTLS (porta 587) e AUTH PLAIN/LOGIN.
 * Com segurança "starttls", se o servidor não oferecer criptografia o envio é
 * recusado: a senha nunca trafega sem proteção.
 */

const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');

class SmtpError extends Error {}

const NO_NEWLINE = /[\r\n]/;

class Connection {
  constructor(socket, timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.buf = '';
    this.lines = [];
    this.queue = [];
    this.waiter = null;
    this.err = null;
    this.closing = false;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    socket.setTimeout(this.timeoutMs);
    this.handlers = {
      data: (d) => this.onData(d),
      error: (e) => this.fail(e),
      timeout: () => { this.fail(new SmtpError('Tempo esgotado aguardando o servidor de e-mail.')); socket.destroy(); },
      close: () => this.fail(new SmtpError('O servidor de e-mail encerrou a conexão.')),
    };
    for (const [ev, fn] of Object.entries(this.handlers)) socket.on(ev, fn);
  }

  detach() {
    for (const [ev, fn] of Object.entries(this.handlers)) this.socket.removeListener(ev, fn);
  }

  onData(chunk) {
    this.buf += chunk.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      if (line.length <= 3 || line[3] === ' ') {
        const resp = { code: Number(line.slice(0, 3)), lines: this.lines.map((l) => l.slice(4)) };
        this.lines = [];
        if (this.waiter) { const w = this.waiter; this.waiter = null; w.resolve(resp); } else this.queue.push(resp);
      }
    }
  }

  fail(e) {
    if (this.closing) return;
    if (!this.err) this.err = e;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(this.err); }
  }

  read() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }

  async cmd(line, expected, what) {
    this.socket.write(line + '\r\n');
    const r = await this.read();
    if (!expected.includes(r.code)) {
      throw new SmtpError(`${what || line.split(' ')[0]} recusado pelo servidor: ${r.code} ${r.lines.join(' ').slice(0, 300)}`);
    }
    return r;
  }
}

function openSocket(host, port, secure, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = secure
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host })
      : net.connect({ host, port });
    const timer = setTimeout(() => { sock.destroy(); reject(new SmtpError('Não foi possível conectar ao servidor de e-mail (tempo esgotado).')); }, timeoutMs);
    sock.once(secure ? 'secureConnect' : 'connect', () => { clearTimeout(timer); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(timer); reject(new SmtpError(`Não foi possível conectar ao servidor de e-mail: ${e.message}`)); });
  });
}

function upgradeTls(plain, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ socket: plain, servername: net.isIP(host) ? undefined : host });
    const timer = setTimeout(() => { sock.destroy(); reject(new SmtpError('Falha ao ativar criptografia (tempo esgotado).')); }, timeoutMs);
    sock.once('secureConnect', () => { clearTimeout(timer); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(timer); reject(new SmtpError(`Falha ao ativar criptografia: ${e.message}`)); });
  });
}

const hasCap = (ehlo, name) => ehlo.lines.some((l) => l.toUpperCase().split(/\s+/)[0] === name);
const authMethods = (ehlo) => {
  const l = ehlo.lines.find((x) => /^AUTH[\s=]/i.test(x));
  return l ? l.slice(5).toUpperCase().split(/\s+/) : [];
};

function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');

function buildMessage({ fromName, fromAddr, to, subject, text, html }) {
  const boundary = 'bic_' + crypto.randomBytes(12).toString('hex');
  const domain = fromAddr.split('@')[1] || 'localhost';
  const name = /^[\x20-\x7e]*$/.test(fromName) ? `"${fromName.replace(/["\\]/g, '')}"` : encodeHeader(fromName);
  const headers = [
    `From: ${name} <${fromAddr}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text),
  ];
  if (html) parts.push(`--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html));
  parts.push(`--${boundary}--`, '');
  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
}

/**
 * Envia um e-mail.
 * cfg: { host, port, security: 'ssl'|'starttls'|'none', user, pass, fromName, fromAddr, timeoutMs }
 * msg: { to, subject, text, html }
 */
async function sendMail(cfg, msg) {
  for (const v of [msg.to, msg.subject, cfg.fromAddr, cfg.fromName || '']) {
    if (NO_NEWLINE.test(String(v))) throw new SmtpError('Endereço ou assunto inválido.');
  }
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(msg.to)) throw new SmtpError(`Destinatário inválido: ${msg.to}`);
  const timeoutMs = cfg.timeoutMs || 20000;
  const host = cfg.host; const port = Number(cfg.port);
  const sock = await openSocket(host, port, cfg.security === 'ssl', timeoutMs);
  const c = new Connection(sock, timeoutMs);
  const helo = (os.hostname() || 'localhost').replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  try {
    const greet = await c.read();
    if (greet.code !== 220) throw new SmtpError(`Servidor de e-mail indisponível: ${greet.code} ${greet.lines.join(' ')}`);
    let ehlo = await c.cmd(`EHLO ${helo}`, [250], 'EHLO');
    if (cfg.security === 'starttls') {
      if (!hasCap(ehlo, 'STARTTLS')) throw new SmtpError('O servidor de e-mail não oferece STARTTLS. Envio cancelado para proteger a senha.');
      await c.cmd('STARTTLS', [220]);
      c.detach();
      const secure = await upgradeTls(sock, host, timeoutMs);
      c.attach(secure);
      ehlo = await c.cmd(`EHLO ${helo}`, [250], 'EHLO');
    }
    if (cfg.user) {
      const methods = authMethods(ehlo);
      if (methods.includes('PLAIN') || !methods.includes('LOGIN')) {
        const token = Buffer.from(`\0${cfg.user}\0${cfg.pass || ''}`, 'utf8').toString('base64');
        await c.cmd(`AUTH PLAIN ${token}`, [235], 'Login no e-mail (usuário ou senha)');
      } else {
        await c.cmd('AUTH LOGIN', [334], 'Login no e-mail');
        await c.cmd(Buffer.from(cfg.user, 'utf8').toString('base64'), [334], 'Login no e-mail (usuário)');
        await c.cmd(Buffer.from(cfg.pass || '', 'utf8').toString('base64'), [235], 'Login no e-mail (senha)');
      }
    }
    await c.cmd(`MAIL FROM:<${cfg.fromAddr}>`, [250], 'Remetente');
    await c.cmd(`RCPT TO:<${msg.to}>`, [250, 251], 'Destinatário');
    await c.cmd('DATA', [354]);
    const data = buildMessage({ fromName: cfg.fromName || '', fromAddr: cfg.fromAddr, ...msg })
      .split('\r\n').map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
    c.socket.write(data + '\r\n.\r\n');
    const r = await c.read();
    if (r.code !== 250) throw new SmtpError(`Mensagem recusada pelo servidor: ${r.code} ${r.lines.join(' ').slice(0, 300)}`);
    c.closing = true;
    c.socket.write('QUIT\r\n');
    c.socket.end();
  } catch (e) {
    c.closing = true;
    c.socket.destroy();
    throw e instanceof SmtpError ? e : new SmtpError(e.message);
  }
}

module.exports = { sendMail, buildMessage, SmtpError };
