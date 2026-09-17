#!/usr/bin/env node
/**
 * rep-shim-dev — Agente Comunicador falso, apontado na DEVELOP.
 *
 * Por que existe: o agente comunicador oficial (Tauri) tem a URL do servidor
 * CRAVADA NO BINARIO, apontando pra producao. Rodando ele, a lista de REPs, o
 * cache local (agent.db) e qualquer Sincronizar batem em PRODUCAO, nao no
 * ambiente de teste. Nao da pra testar sync de REP fora de producao com o
 * agente oficial.
 *
 * O que faz: fala o mesmo protocolo socket.io do RepAgentGateway do servidor,
 * declara posse de um repId via `clientStatus`, e traduz cada `repRequest*`
 * para a API .fcgi (mode=671) do Control iD na LAN.
 *
 * O gateway aceita agente sem token (`handleConnection`: "auth=none (legacy
 * agent)"), entao o shim NAO precisa de credencial da develop.
 *
 * IMPORTANTE: o IP/porta/credencial do device saem daqui (env), nao do
 * cadastro no servidor. Isso e de proposito: o registro na develop pode estar
 * com IP velho e o shim funciona mesmo assim. Divergencia e logada como aviso.
 *
 * Uso:
 *   npm install
 *   SHIM_SERVER=http://... SHIM_REP_ID=<uuid> SHIM_REP_IP=<ip> node shim.js
 *
 * Nada tem default de infraestrutura: servidor, repId e IP do device sao
 * obrigatorios. Ver README.
 */

'use strict';

const { io } = require('socket.io-client');
const https = require('https');
const http = require('http');
const dns = require('dns');
const { URL } = require('url');

// ---------------------------------------------------------------- configuracao

const cfg = {
  server: process.env.SHIM_SERVER,
  repId: process.env.SHIM_REP_ID,
  repName: process.env.SHIM_REP_NAME || 'REP de teste',
  repIp: process.env.SHIM_REP_IP,
  repPort: Number(process.env.SHIM_REP_PORT || 443),
  repLogin: process.env.SHIM_REP_LOGIN || 'admin',
  repPassword: process.env.SHIM_REP_PASSWORD || 'admin',
  repTls: process.env.SHIM_REP_TLS !== '0',
  agentId: process.env.SHIM_AGENT_ID || `shim-dev-${process.pid}`,
  statusEverySec: Number(process.env.SHIM_STATUS_EVERY_SEC || 30),
  // O backend nao manda image_timestamp: quem escolhe e o agente. O agente
  // oficial manda milissegundos (Date.now()), o que satura no int32 do device
  // (2147483647) e faz a troca de foto nunca re-sincronizar. Default mantem o
  // comportamento buggado de proposito, pra reproduzir producao fielmente.
  // SHIM_IMAGE_TS_SECONDS=1 usa segundos, pra validar o fix.
  imageTsSeconds: process.env.SHIM_IMAGE_TS_SECONDS === '1',
  allowProd: process.env.SHIM_ALLOW_PROD === '1',
};

// Hostnames/IPs de producao, separados por virgula. Ficam FORA do codigo de
// proposito: sao infraestrutura, nao logica. Sem eles a trava abaixo nao tem
// como saber o que e producao — por isso ela avisa alto quando a lista vem
// vazia, em vez de deixar passar calada.
const PROD_MARKERS = (process.env.SHIM_PROD_MARKERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ------------------------------------------------------------------------ log

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] AVISO:`, ...a);
const err = (...a) => console.error(`[${ts()}] ERRO:`, ...a);

// Aqui, e nao no fim do arquivo: `io(cfg.server, ...)` roda no nivel do modulo
// e estouraria antes, com `cfg.server` indefinido.
assertConfig();

// ------------------------------------------------- trava anti-producao

/**
 * O ponto inteiro do shim e nao encostar em producao. Um SHIM_SERVER errado
 * transformaria este processo num agente de producao apontado pro REP que esta
 * na mesa do dev — sincronizando cadastro de cliente real no equipamento de
 * teste. Por isso a checagem e por hostname E por IP resolvido.
 */
/**
 * Config obrigatoria. Antes estes tres tinham default apontando pra
 * infraestrutura real; agora sao exigidos, entao vale falhar com uma frase
 * que diz o que fazer em vez de estourar num `new URL(undefined)`.
 */
function assertConfig() {
  const faltando = ['SHIM_SERVER', 'SHIM_REP_ID', 'SHIM_REP_IP'].filter(
    (k) => !process.env[k],
  );
  if (faltando.length) {
    err(`faltam variaveis obrigatorias: ${faltando.join(', ')}`);
    err('Ver README.md. Exemplo:');
    err('  SHIM_SERVER=http://10.0.0.5:8080 SHIM_REP_ID=<uuid> \\');
    err('  SHIM_REP_IP=192.0.2.10 node shim.js');
    process.exit(1);
  }
}

async function assertNotProduction() {
  // Lista vazia = trava desligada. Isso e perigoso o bastante pra avisar:
  // o ponto inteiro do shim e nao encostar em producao, e um silencio aqui
  // parece "passou na checagem" quando na verdade e "nao checou nada".
  if (PROD_MARKERS.length === 0) {
    warn('SHIM_PROD_MARKERS esta vazio: a trava anti-producao esta DESLIGADA.');
    warn('Defina os hostnames/IPs de producao para ligar a protecao.');
    return;
  }

  const host = new URL(cfg.server).hostname;
  const hits = new Set();
  if (PROD_MARKERS.includes(host)) hits.add(host);

  const resolved = await new Promise((res) =>
    dns.lookup(host, { all: true }, (e, addrs) =>
      res(e ? [] : addrs.map((a) => a.address)),
    ),
  );
  for (const ip of resolved) if (PROD_MARKERS.includes(ip)) hits.add(ip);

  if (hits.size === 0) return;
  if (cfg.allowProd) {
    warn(`SHIM_SERVER aponta pra PRODUCAO (${[...hits].join(', ')}) e`);
    warn('SHIM_ALLOW_PROD=1 esta setado. Seguindo. Espero que seja proposital.');
    return;
  }
  err(`SHIM_SERVER (${cfg.server}) resolve pra PRODUCAO: ${[...hits].join(', ')}`);
  err('Recusando subir. Este shim e pra develop.');
  err('Se for realmente proposital, rode com SHIM_ALLOW_PROD=1.');
  process.exit(1);
}

// --------------------------------------------------- HTTP cru para o device

function deviceFetch(path, bodyObj) {
  const mod = cfg.repTls ? https : http;
  const payload = Buffer.from(JSON.stringify(bodyObj ?? {}), 'utf8');

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        host: cfg.repIp,
        port: cfg.repPort,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
        // O device usa certificado autoassinado emitido pela "Control iD CA",
        // com CN preso ao IP que ele tinha quando o cert foi gerado — nunca
        // valida. Verificar aqui so quebraria sem ganho nenhum de seguranca
        // numa LAN.
        rejectUnauthorized: false,
        // OBRIGATORIO, nao e frescura: o firmware do Control iD termina quase
        // todos os headers de resposta com LF puro em vez do CRLF que o HTTP
        // exige (confirmado com `curl -D - | cat -A`: so o Content-Length vem
        // com ^M$). O parser estrito do Node rejeita com "Parse Error: Invalid
        // header value char" e nenhuma chamada ao device funciona. O curl e
        // tolerante, por isso os testes manuais passam e o shim falhava.
        insecureHTTPParser: true,
        timeout: 12000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout no device')));
    req.on('error', reject);
    req.end(payload);
  });
}

// ------------------------------------------------------ sessao no Control iD

let session = null;

async function login() {
  const res = await deviceFetch('/login.fcgi', {
    login: cfg.repLogin,
    password: cfg.repPassword,
  });
  let parsed;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new Error(`login.fcgi devolveu resposta nao-JSON (HTTP ${res.status})`);
  }
  if (res.status !== 200 || !parsed.session) {
    throw new Error(
      `login falhou (HTTP ${res.status}): ${parsed.error ?? res.text.slice(0, 120)}`,
    );
  }
  session = parsed.session;
  log(`sessao aberta no device ${cfg.repIp}`);
  return session;
}

/**
 * Chama um comando .fcgi. Reautentica uma vez em "Invalid session" (401): a
 * sessao do device expira sozinha e o shim fica de pe por horas entre syncs.
 */
async function call(cmd, body, extraQuery = '') {
  if (!session) await login();

  const url = () => `/${cmd}.fcgi?session=${session}&mode=671${extraQuery}`;
  let res = await deviceFetch(url(), body);

  if (res.status === 401) {
    log(`sessao expirada em ${cmd}, reautenticando`);
    session = null;
    await login();
    res = await deviceFetch(url(), body);
  }
  return res;
}

function asJson(res, cmd) {
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(
      `${cmd} devolveu resposta nao-JSON (HTTP ${res.status}): ${res.text.slice(0, 160)}`,
    );
  }
}

// ------------------------------------------------------ comandos do device

const device = {
  async loadUsers() {
    const res = await call('load_users', { limit: 100, offset: 0, templates: true });
    return asJson(res, 'load_users').users ?? [];
  },

  async loadUser(cpf) {
    const res = await call('load_users', {
      templates: true,
      users_cpf: [Number.parseInt(cpf, 10)],
    });
    return asJson(res, 'load_users').users?.[0] ?? null;
  },

  async addUser(d) {
    const res = await call('add_users', {
      users: [
        {
          admin: false,
          name: d.name,
          cpf: Number(d.cpf),
          registration: Number(d.registration ?? 0),
          password: d.password ?? '',
          templates: d.templates ?? [],
        },
      ],
    });
    // O 500 aqui e o sintoma classico de device sem EMPREGADOR cadastrado
    // (Portaria 671): o REP recusa criar usuario e, sem usuario, foto nenhuma
    // tem em quem ser anexada. Vale traduzir, senao vira "erro 500" opaco.
    if (res.status === 500 && /empregador/i.test(res.text)) {
      throw new Error(
        'device recusou add_users: EMPREGADOR nao cadastrado no equipamento. ' +
          `Abra https://${cfg.repIp} -> menu Empregador e preencha CNPJ, Razao ` +
          'Social, CPF do Responsavel (!= 0) e Endereco (nao vazio).',
      );
    }
    if (res.status !== 200) {
      throw new Error(`add_users falhou (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    }
    return {};
  },

  /**
   * Espelha o rep-wrapper: update_users e sequencia de DUAS chamadas — a
   * primeira grava os dados com remove_templates, a segunda grava os
   * templates. Mandar tudo junto nao funciona nesse firmware.
   */
  async updateUser(d) {
    let res = await call('update_users', {
      users: [
        {
          cpf: Number(d.cpf),
          name: d.name,
          registration: Number(d.registration ?? 0),
          password: d.password ?? '',
          remove_templates: true,
        },
      ],
    });
    if (res.status !== 200) {
      throw new Error(`update_users (dados) falhou (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    }

    res = await call('update_users', {
      users: [{ cpf: Number(d.cpf), templates: d.templates ?? [] }],
    });
    if (res.status !== 200) {
      throw new Error(`update_users (templates) falhou (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    }
    return {};
  },

  async removeUser(cpf) {
    const res = await call('remove_users', {
      users: [Number.parseInt(cpf, 10)],
    });
    if (res.status !== 200) {
      throw new Error(`remove_users falhou (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    }
    return {};
  },

  async setUserImage(cpf, imageBase64) {
    const stamp = cfg.imageTsSeconds
      ? Math.floor(Date.now() / 1000)
      : Date.now();
    const res = await call(
      'user_set_image',
      { image: imageBase64 },
      `&do_match=false&cpf=${encodeURIComponent(cpf)}&image_timestamp=${stamp}&raw=false`,
    );
    if (res.status !== 200) {
      throw new Error(`user_set_image falhou (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    }
    log(
      `foto gravada p/ cpf ${cpf} (image_timestamp=${stamp} em ` +
        `${cfg.imageTsSeconds ? 'segundos' : 'milissegundos'})`,
    );
    return {};
  },

  async getAfd(initialNsr) {
    const res = await call('get_afd', { initial_nsr: Number(initialNsr ?? 0) });
    if (res.status !== 200) {
      throw new Error(`get_afd falhou (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    }
    return res.text;
  },

  async systemInfo() {
    const res = await call('get_system_information', {});
    return asJson(res, 'get_system_information');
  },
};

// ------------------------------------------------------------ socket.io

log(`shim rep-shim-dev  agentId=${cfg.agentId}`);
log(`servidor : ${cfg.server}`);
log(`repId    : ${cfg.repId}`);
log(`device   : ${cfg.repTls ? 'https' : 'http'}://${cfg.repIp}:${cfg.repPort} (login ${cfg.repLogin})`);

let lastNsr = 0;

const socket = io(cfg.server, {
  transports: ['websocket', 'polling'],
  // Sem token de proposito: o gateway trata isso como "legacy agent" e aceita.
  auth: { agentId: cfg.agentId },
  // Obrigatorio: com o autoConnect default (true) a conexao acontece aqui, no
  // construtor, ANTES de assertNotProduction() rodar — e a trava anti-producao
  // nao serviria pra nada.
  autoConnect: false,
  reconnection: true,
  reconnectionDelay: 2000,
  reconnectionDelayMax: 15000,
});

function sendClientStatus() {
  const repInfos = [
    {
      status: 'connected',
      id: cfg.repId,
      name: cfg.repName,
      ipAddress: cfg.repIp,
      lastNsr,
    },
  ];
  socket.emit('clientStatus', { repInfos });
}

/**
 * Todo handler segue a mesma forma: o gateway espera um `RepResponse`
 * ({ promiseId, isError, data }) no evento de resposta correspondente, e
 * desiste em 15s. Erro nao tratado aqui = promise pendurada no backend ate o
 * timeout, que aparece como "request timed out" sem causa. Por isso todo
 * handler responde, inclusive no caminho de falha.
 */
function handle(reqEvent, resEvent, fn) {
  socket.on(reqEvent, async (payload) => {
    const { promiseId, repId } = payload ?? {};
    if (repId && repId !== cfg.repId) {
      warn(`${reqEvent} para repId desconhecido ${repId}, ignorando`);
      return;
    }
    log(`<- ${reqEvent}`);
    try {
      const data = await fn(payload);
      socket.emit(resEvent, { promiseId, isError: false, data });
      log(`-> ${resEvent} ok`);
    } catch (e) {
      const message = e?.message ?? String(e);
      err(`${reqEvent}: ${message}`);
      socket.emit(resEvent, { promiseId, isError: true, data: message });
    }
  });
}

socket.on('connect', async () => {
  log(`conectado (socket ${socket.id})`);
  sendClientStatus();
  try {
    const info = await device.systemInfo();
    log(
      `device ok — usuarios=${info.user_count ?? '?'} faces=${info.number_of_faces ?? '?'}`,
    );
    if (info.number_of_faces === 0) {
      warn('device com 0 faces. Se add_users falhar com 500, e o EMPREGADOR.');
    }
  } catch (e) {
    warn(`nao consegui ler o device agora: ${e.message}`);
  }
});

socket.on('disconnect', (reason) => warn(`desconectado: ${reason}`));
socket.on('connect_error', (e) => err(`falha ao conectar: ${e.message}`));

// O gateway avisa mudanca de cadastro por aqui. O shim nao adota o IP do
// servidor (o env manda), mas divergencia e exatamente o bug que fez esse
// registro ficar apontado pro IP errado — entao grita.
socket.on('repUpdate', (rep) => {
  log(`<- repUpdate (${rep?.name})`);
  if (rep?.ipAddress && rep.ipAddress !== cfg.repIp) {
    warn(
      `cadastro no servidor tem ipAddress=${rep.ipAddress}, o shim esta usando ` +
        `${cfg.repIp}. O shim funciona, mas o agente OFICIAL usaria o do servidor ` +
        'e falharia. Corrija o cadastro.',
    );
  }
  if (typeof rep?.afdLastNsr === 'number') {
    log(`servidor diz afdLastNsr=${rep.afdLastNsr}`);
  }
});

socket.on('userChanged', ({ cpf } = {}) => log(`<- userChanged cpf=${cpf}`));

handle('repRequestUsers', 'repResponseUsers', () => device.loadUsers());
handle('repRequestUser', 'repResponseUser', (p) => device.loadUser(p.cpf));
handle('repRequestAddUser', 'repResponseAddUser', (p) => device.addUser(p.data));
handle('repRequestUpdateUser', 'repResponseUpdateUser', (p) => device.updateUser(p.data));
// Atencao: aqui `data` e o CPF cru (string), nao um objeto — ver
// ControlIdRepAdapter.removeUser, que passa `profile.cpf` direto.
handle('repRequestDeleteUser', 'repResponseDeleteUser', (p) => device.removeUser(p.data));
handle('repRequestSetUserImage', 'repResponseSetUserImage', (p) =>
  device.setUserImage(p.data.userCpf, p.data.imageBase64),
);
handle('repRequestAfd', 'repResponseAfd', async (p) => {
  const afd = await device.getAfd(p.initialNsr);
  const nsrs = [...afd.matchAll(/^(\d{9})/gm)].map((m) => Number(m[1]));
  if (nsrs.length) {
    lastNsr = Math.max(lastNsr, ...nsrs);
    log(`AFD: ${nsrs.length} registros, maior NSR ${lastNsr}`);
  } else {
    log(`AFD vazio a partir do NSR ${p.initialNsr} (nada novo no device)`);
  }
  return afd;
});

const statusTimer = setInterval(sendClientStatus, cfg.statusEverySec * 1000);

function shutdown(sig) {
  log(`recebi ${sig}, encerrando`);
  clearInterval(statusTimer);
  socket.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

assertNotProduction().then(() => socket.connect());
