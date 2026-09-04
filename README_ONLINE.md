# CORUJA TIME — Deploy online

Projeto Node.js + Express preparado para publicação no Render.

## Segurança
- O arquivo `.env` real foi removido deste pacote.
- Não envie tokens ou senhas para o GitHub.
- Configure `TMDB_TOKEN` e `ADMIN_KEY` como variáveis secretas no Render.
- Dados de usuários e sessões ficam fora do repositório e, no Render, no disco persistente `/var/data`.

## Deploy
Build:
`npm install --no-audit --no-fund`

Start:
`npm start`

O `render.yaml` já está preparado para o serviço web e o disco persistente.
