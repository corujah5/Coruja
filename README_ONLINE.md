# CORUJA TIME — Deploy online

Projeto Node.js + Express preparado para publicação no Render.

## Segurança
- O arquivo `.env` real foi removido deste pacote.
- Não envie tokens ou senhas para o GitHub.
- Configure `TMDB_TOKEN` e `ADMIN_USERNAME` nas variáveis de ambiente do serviço.
- `ADMIN_USERNAME` deve corresponder ao nome de usuário da conta administradora; as rotas administrativas exigem a sessão autenticada dessa conta.
- Dados de usuários e sessões ficam fora do repositório e, no Render, no disco persistente `/var/data`.

## Deploy
Build:
`npm install --no-audit --no-fund`

Start:
`npm start`

O `render.yaml` já está preparado para o serviço web e o disco persistente.
