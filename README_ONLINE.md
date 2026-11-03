# CORUJA — publicação no Render

O serviço usa Node.js/Express, `npm ci` para instalar as dependências do lockfile e `npm start` para iniciar o servidor. O servidor escuta na porta `PORT` do Render. O `render.yaml` monta o disco persistente em `/var/data`, com dados em `DATA_DIR` e uploads em `UPLOAD_DIR`.

## Variáveis do serviço

Configure os valores secretos na área **Environment** do Render; não os coloque neste repositório:

- `TMDB_TOKEN`: token de leitura v4 do TMDB. É consumido pelo backend.
- `ADMIN_USERNAME`: nome de usuário da conta administradora provisionada. O servidor usa essa conta para identificar o administrador e protegê-la contra bloqueio ou exclusão.
- `ADMIN_KEY`: chave separada, com pelo menos 16 bytes, exigida pelo servidor em todas as rotas `/api/admin`. O painel administrativo a envia no cabeçalho `x-admin-key`; ela não é substituída pela sessão normal de usuário. Use somente HTTPS e não coloque a chave em URLs, commits, capturas ou logs.
- `ADMIN_BOOTSTRAP_SECRET`: segredo temporário, com pelo menos 32 bytes aleatórios, usado apenas para provisionar a primeira conta em um disco sem usuários. Remova-o do Render após o bootstrap bem-sucedido.

O `render.yaml` declara esses segredos com `sync: false`: o Blueprint não contém nem fornece valores. `DATA_DIR` e `UPLOAD_DIR` são caminhos não secretos e permanecem no disco persistente.

## Provisionamento inicial do administrador

1. No Render, configure `ADMIN_USERNAME` com o usuário que será criado, `ADMIN_KEY` com uma chave forte e temporária ou permanente conforme a política de acesso, e `ADMIN_BOOTSTRAP_SECRET` com um segredo aleatório de pelo menos 32 bytes.
2. Faça o deploy do Blueprint. Confirme que o serviço está acessível por HTTPS.
3. Envie `POST /api/bootstrap/admin` por HTTPS, com `x-admin-bootstrap` contendo o segredo temporário e um corpo JSON com `name`, `username` igual a `ADMIN_USERNAME` e `password` forte. Não registre o cabeçalho, o corpo ou a resposta em logs compartilhados.
4. Após HTTP 201, remova `ADMIN_BOOTSTRAP_SECRET` das variáveis do serviço e aplique/reinicie a alteração. O marcador no disco persistente mantém o bootstrap consumido, mesmo depois de reinícios.
5. Entre no CORUJA com a conta criada. Para abrir e usar o painel administrativo, informe `ADMIN_KEY` no próprio painel. A autorização das operações é verificada pelo servidor em cada chamada.

O bootstrap só cria a primeira conta quando não há usuários e não habilita cadastro público. Se o disco já tiver usuários ou um marcador de bootstrap consumido, o endpoint não provisionará outra conta.

## Dados e Git

O `.gitignore` exclui `.env`, arquivos de dados, uploads e diretórios de backup. O `.env.example` é apenas um modelo e não deve conter valores reais. Mantenha `users.json`, sessões, estados e uploads no disco persistente; não os adicione ao GitHub.

## Comandos do Render

- Build: `npm ci`
- Start: `npm start`

Antes de criar ou atualizar o serviço, confira o `render.yaml`, os segredos cadastrados no painel do Render e o disco persistente associado ao serviço.
