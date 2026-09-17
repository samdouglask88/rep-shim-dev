# rep-shim-dev

Agente Comunicador **falso**, para testar sincronizacao de REP Control iD fora
de producao.

## O problema que ele resolve

O agente comunicador oficial (Tauri) tem a URL do servidor **cravada no
binario**, apontando para producao. Rodando ele, a lista de REPs, o cache local
(`agent.db`) e qualquer "Sincronizar" batem em producao — nao no ambiente de
teste.

Na pratica isso significava que **nao dava para testar sync de REP fora de
producao**. Nao era inconveniente: era impossivel.

Este shim fala o mesmo protocolo socket.io do `RepAgentGateway` do servidor,
declara posse de um `repId` via `clientStatus` e traduz cada `repRequest*` para
a API `.fcgi` (`mode=671`) do Control iD na LAN. O gateway aceita agente sem
token (`handleConnection`: "legacy agent"), entao nao precisa de credencial do
ambiente de teste.

## Uso

```bash
npm install

SHIM_SERVER=http://10.0.0.5:8080 \
SHIM_REP_ID=<uuid-do-rep-no-cadastro> \
SHIM_REP_IP=192.0.2.10 \
SHIM_PROD_MARKERS=api.exemplo.com,203.0.113.7 \
node shim.js
```

**Nenhuma variavel de infraestrutura tem valor padrao.** Servidor, `repId` e IP
do device sao obrigatorios; sem eles o shim recusa subir com a lista do que
falta. Isso e de proposito: endereco de servidor e id de equipamento sao
ambiente, nao codigo.

O IP, a porta e a credencial do device saem do **ambiente**, nao do cadastro no
servidor — o registro pode estar com IP velho e o shim funciona mesmo assim. A
divergencia e logada como aviso.

## Duas coisas que valem saber

**A trava anti-producao.** O ponto inteiro do shim e nao encostar em producao.
Um `SHIM_SERVER` errado transformaria este processo num agente de producao
apontado para o REP que esta na mesa — sincronizando cadastro de cliente real
no equipamento de teste. A checagem e por hostname **e** por IP resolvido via
DNS, e so passa com `SHIM_ALLOW_PROD=1` explicito.

Os marcadores vem de `SHIM_PROD_MARKERS`. Com a lista vazia a trava fica
desligada — e nesse caso o shim **avisa alto**, porque silencio ali pareceria
"passou na checagem" quando na verdade e "nao checou nada".

**O bug do `image_timestamp`.** Quem escolhe esse valor e o agente, nao o
backend. O agente oficial manda milissegundos (`Date.now()`), que **satura no
int32 do device** (2147483647) — e por isso a troca de foto nunca
re-sincroniza. O default do shim mantem o comportamento com bug de proposito,
para reproduzir producao fielmente; `SHIM_IMAGE_TS_SECONDS=1` usa segundos,
para validar a correcao.

## Variaveis

| Variavel | Default |
|---|---|
| `SHIM_SERVER` | **obrigatoria** |
| `SHIM_REP_ID` | **obrigatoria** — UUID do REP no cadastro |
| `SHIM_REP_IP` | **obrigatoria** |
| `SHIM_REP_PORT` | `443` |
| `SHIM_REP_LOGIN` / `SHIM_REP_PASSWORD` | `admin` / `admin` (padrao de fabrica do Control iD) |
| `SHIM_REP_TLS` | ligado (`0` desliga) |
| `SHIM_PROD_MARKERS` | vazio — sem isto a trava anti-producao nao funciona |
| `SHIM_IMAGE_TS_SECONDS` | `0` (reproduz o bug); `1` corrige |
| `SHIM_ALLOW_PROD` | `0` — nao mexa |
